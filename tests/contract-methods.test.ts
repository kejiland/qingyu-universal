/* ============================================================
 * 契约「方法可用性」护栏：声明的方法必须真的被支持
 * ------------------------------------------------------------
 * 起因（真 bug）：契约里登记了 `PUT /api/site-files`、`PUT /api/site-files/:name`、
 * `DELETE /api/site-files/:name`，但上游 handleSiteFiles() 根本没实现这三个方法，
 * 运行时一律 405；反倒是能用的 `POST /api/site-files/:name` 从来没登记。
 *
 * 契约骗人的代价是连锁的：OpenAPI 文档、generated/api.d.ts 前端类型、
 * 运行时校验中间件全都会照着这份错声明行事。
 *
 * 所以这里逐个请求**契约里登记的每一个方法**，断言不会拿到 405。
 * 管理员路由带真实会话 token；路径参数用占位符替换成真实存在的 id。
 * ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';
import { postRoutes } from '../src/api/routes/posts.js';
import { adminRoutes } from '../src/api/routes/admin.js';
import { miscRoutes } from '../src/api/routes/misc.js';
import type { ApiRoute } from '../src/api/registry.js';

let server: TestServer;
let token = '';

/** 把契约路径里的 :param 换成真实存在的取值，避免 404 掩盖 405。 */
function fillParams(path: string, postId: string): string {
  return path
    .replace(':id', postId)
    .replace(':name', 'probe.txt')
    .replace(':cid', 'probe-cid')
    .replace(':rid', '1')
    .replace(':revision', '1');
}

/** 这些路由会真的写库 / 有副作用，只探方法可用性，不校验业务结果。 */
const DESTRUCTIVE = /\/admin\/errors$|subscribers\/\|\/backups$|restore$|\/logout$/;

const allRoutes: ApiRoute[] = [...postRoutes, ...adminRoutes, ...miscRoutes];

beforeAll(async () => {
  server = await startTestServer();
  const setup = await fetch(`${server.baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'contract-methods-2026' })
  });
  void setup;
  const login = await fetch(`${server.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'contract-methods-2026' })
  });
  const body = (await login.json()) as { token?: string };
  token = body.token ?? '';

  // 造一篇真实文章，供带 :id 的路由使用
  await fetch(`${server.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: 'contract-probe-post', title: '契约探测文章', content: '正文',
      date: new Date().toISOString(), status: 'published', tags: []
    })
  });
});

afterAll(async () => {
  await server.close();
});

describe('契约登记的 HTTP 方法都真的被支持', () => {
  it('管理员会话可用（否则后面的断言全是假阳性）', () => {
    expect(token.length).toBeGreaterThan(0);
  });

  it('没有任何一条声明过的方法返回 405 Method Not Allowed', async () => {
    const failures: string[] = [];
    for (const route of allRoutes) {
      if (DESTRUCTIVE.test(`${route.method} ${route.path}`)) continue;
      if (route.method === 'DELETE') continue; // 删除类不探：会把探测数据删掉
      const url = `${server.baseUrl}${fillParams(route.path, 'contract-probe-post')}`;
      const headers: Record<string, string> = {};
      if (route.auth === 'admin') headers.Authorization = `Bearer ${token}`;
      if (route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH') {
        headers['Content-Type'] = 'application/json';
      }
      let status = 0;
      try {
        const r = await fetch(url, {
          method: route.method,
          headers,
          body: route.method === 'GET' ? undefined : '{}'
        });
        status = r.status;
        await r.arrayBuffer();
      } catch (e) {
        failures.push(`${route.method} ${route.path} → 请求异常: ${(e as Error).message}`);
        continue;
      }
      // 401/403 = 鉴权生效（方法存在）；404 = 资源不存在（方法存在）；
      // 400 = 参数校验生效（方法存在）。只有 405 是「契约撒谎」。
      if (status === 405) failures.push(`${route.method} ${route.path} → 405（上游未实现）`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60000);
});
