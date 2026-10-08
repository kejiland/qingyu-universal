/* ============================================================
 * 静态站导出
 * ------------------------------------------------------------
 * 走真实 HTTP：登录 → 拉 ZIP → 自己解中央目录。
 * 只断言「该有的文件都在、页面已改成相对地址、配置是静态模式」，
 * 不去比对整段 HTML —— 那样每次改版式都会红。
 * ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';

let server: TestServer;
let token = '';
let zipBytes = new Uint8Array();
let zipNames: string[] = [];

const PASSWORD = 'Static-Export-Test-Password-1';

/** 解 ZIP 中央目录：只取条目名与本地头偏移，够断言用了。 */
function readZip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = data.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 结构损坏：找不到中央目录结尾');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录项签名不对');
    const size = view.getUint32(p + 24, true);
    const offset = view.getUint32(p + 42, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 本地文件头：文件名长度可能与中央目录不同，必须重新读
    const localNameLen = view.getUint16(offset + 26, true);
    const localExtraLen = view.getUint16(offset + 28, true);
    const start = offset + 30 + localNameLen + localExtraLen;
    out.set(name, data.subarray(start, start + size));
  }
  return out;
}

const text = (files: Map<string, Uint8Array>, name: string): string =>
  new TextDecoder().decode(files.get(name) ?? new Uint8Array());

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, init);
}

beforeAll(async () => {
  server = await startTestServer();

  await call('/api/admin/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: PASSWORD })
  });
  const login = await call('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  });
  token = ((await login.json()) as { token?: string }).token ?? '';

  // 没有文章时导出应当被明确拒绝，而不是给出一个空站
  const empty = await call('/api/admin/export-static', { headers: { Authorization: `Bearer ${token}` } });
  expect(empty.status).toBe(400);

  const created = await call('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: 'static-export-sample',
      title: '静态站导出测试文章',
      content: '## 正文\n\n这是导出用的正文。',
      tags: ['导出', '静态站'],
      status: 'published'
    })
  });
  expect(created.status).toBe(201);

  const res = await call('/api/admin/export-static', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  zipBytes = new Uint8Array(await res.arrayBuffer());
  zipNames = [...readZip(zipBytes).keys()];
});

afterAll(async () => {
  await server?.close();
});

describe('静态站导出', () => {
  it('未带令牌时拒绝导出', async () => {
    const res = await call('/api/admin/export-static');
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toContain('未授权');
  });

  it('令牌无效时拒绝导出', async () => {
    const res = await call('/api/admin/export-static', { headers: { Authorization: 'Bearer nope-nope' } });
    expect(res.status).toBe(401);
  });

  it('返回的是 ZIP 且文件名可下载', async () => {
    const res = await call('/api/admin/export-static', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.headers.get('content-type')).toContain('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="qingyu-static-site-\d{8}-\d{4}\.zip"/);
    // ZIP 魔数
    const head = new Uint8Array(await res.arrayBuffer()).slice(0, 2);
    expect(Array.from(head)).toEqual([0x50, 0x4b]);
  });

  it('页面、数据与资源齐全', () => {
    const required = [
      'index.html',
      'posts/static-export-sample/index.html',
      'archive/index.html',
      'tags/index.html',
      'categories/index.html',
      'about/index.html',
      'links/index.html',
      'popular/index.html',
      'history/index.html',
      'series/index.html',
      'guestbook/index.html',
      'subscribe/index.html',
      '404.html',
      'posts.min.js',
      'config.min.js',
      'app.min.js',
      'style.min.css',
      'boot.min.js',
      'polish.min.css',
      'i18n.min.js',
      'sitemap.xml',
      'feed.xml',
      'README-静态站说明.txt'
    ];
    for (const name of required) {
      expect(zipNames, `缺少 ${name}`).toContain(name);
    }
  });

  it('文章页：SSR 正文 + 相对资源 + 去掉 Service Worker', () => {
    const files = readZip(zipBytes);
    const html = text(files, 'posts/static-export-sample/index.html');
    expect(html).toContain('静态站导出测试文章');
    expect(html).toContain('这是导出用的正文');
    // 子目录里的页面必须用 ../../ 找资源
    expect(html).toContain('../../style.min.css');
    expect(html).not.toContain('"/style.min.css');
    // 静态站不该再注册 Service Worker
    expect(html).not.toContain('navigator.serviceWorker');
  });

  it('首页用相对资源，链接协议保持原样', () => {
    const files = readZip(zipBytes);
    const html = text(files, 'index.html');
    expect(html).toContain('style.min.css');
    // 带协议的地址（https:// 与页脚的 mailto:）不能被 rebase 加上路径前缀，
    // 例如变成 "../../mailto:x@y" 或 "posts/https://…" 都是坏的。
    const badRebase = [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
      .map((m) => m[1] as string)
      .filter((u) => /^(?:\.\.?\/)+[a-z][a-z0-9+.-]*:/i.test(u) || /\/[a-z][a-z0-9+.-]*:\/\//i.test(u));
    expect(badRebase, '带协议的地址被 rebase 加了路径前缀').toEqual([]);
    expect(html).toContain('https://schema.org');
  });

  it('数据与配置是纯静态形态', () => {
    const files = readZip(zipBytes);
    const postsJs = text(files, 'posts.min.js');
    expect(postsJs.startsWith('window.BLOG_POSTS = [')).toBe(true);
    // tags 是数组、ogImage 是驼峰、seo 是对象
    const data = JSON.parse(postsJs.replace(/^window\.BLOG_POSTS = /, '').replace(/;\s*$/, '')) as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(Array.isArray(data[0].tags)).toBe(true);
    expect(data[0]).toHaveProperty('ogImage');
    expect(data[0].seo).toBeTypeOf('object');

    const configJs = text(files, 'config.min.js');
    expect(configJs).toContain('"mode":"static"');
    expect(configJs).not.toContain('writeToken":"a');
  });

  it('收录文件包含全部文章地址', () => {
    const files = readZip(zipBytes);
    expect(text(files, 'sitemap.xml')).toContain('/posts/static-export-sample/');
    expect(text(files, 'feed.xml')).toContain('<rss');
    expect(text(files, 'README-静态站说明.txt')).toContain('静态站');
  });
});
