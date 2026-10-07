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
    const token = m ? m[1].trim() : '';
    if (!token) {
      return jsonError(c, 401, '未授权：请先登录获取会话 token，并在请求头携带 Authorization: Bearer <token>');
    }

    // 兼容部署里仍然在用的静态写入令牌
    if (config.admin.writeToken && token === config.admin.writeToken) {
      // 直接放行
    } else {
      const row = await db
        .first<{ exp?: number | null }>('SELECT exp FROM admin_sessions WHERE token = ?', token)
        .catch(() => null);
      const exp = Number(row?.exp ?? 0);
      if (!row || !Number.isFinite(exp) || exp <= Date.now()) {
        return jsonError(c, 401, '会话已过期，请重新登录后再导出。');
      }
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
