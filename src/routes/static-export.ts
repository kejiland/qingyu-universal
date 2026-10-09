/* ============================================================
 * 静态站导出接口
 * ------------------------------------------------------------
 * GET /api/admin/export-static
 *
 * 不进契约注册表（那一层全部是转发给上游的），和 /api/music 一样在
 * app.ts 里本地挂载。鉴权直接查 admin_sessions，与上游一致。
 * ============================================================ */
import type { Context } from 'hono';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../types.js';
import { buildStaticSite } from '../ssr/static-site.js';
import { zipFiles } from '../lib/zip.js';
import { isAdminWriteAuthed } from '../api/admin-auth.js';

export interface StaticExportDeps {
  config: AppConfig;
  db: AppDatabase;
}

function jsonError(c: Context, status: number, error: string): Response {
  return c.json({ ok: false, error }, status as 400);
}

function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function createStaticExportHandler(deps: StaticExportDeps) {
  const { config, db } = deps;

  return async (c: Context): Promise<Response> => {
    const header = c.req.header('Authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) {
      return jsonError(c, 401, '未授权：请先登录获取会话 token，并在请求头携带 Authorization: Bearer <token>');
    }

    /* 复用后台统一鉴权（admin-auth.ts）：此前这里自己抄了一份，
     * 两份差异造成两个问题 —— ① 用 `===` 比较 writeToken，非常量时间；
     * ② 只查 admin_sessions，不查 must_change，于是「未修改初始密码」期间
     *    仍能导出全站数据（含草稿与正文），绕过后台的强制改密闸门。 */
    const state = await isAdminWriteAuthed(db, { BLOG_WRITE_TOKEN: config.admin.writeToken }, header);
    if (!state.authed) {
      return jsonError(c, 401, '会话已过期或无效，请重新登录后再导出。');
    }
    if (state.mustChange) {
      return jsonError(c, 403, '请先修改初始密码后再使用后台功能。');
    }

    let built;
    try {
      built = await buildStaticSite({ config, db });
    } catch (e) {
      return jsonError(c, 400, e instanceof Error ? e.message : '生成静态站失败');
    }

    const zip = zipFiles(built.files);
    const name = `qingyu-static-site-${stamp()}.zip`;

    // 直接构造 Response：Hono 的 c.header() 只对 c.json/c.text 生效，
    // 这里返回裸 Response，响应头必须自己带全。
    return new Response(zip, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(zip.length),
        'Cache-Control': 'no-store',
        'X-Static-Post-Count': String(built.postCount)
      }
    });
  };
}
