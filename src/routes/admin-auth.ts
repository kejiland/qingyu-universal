/* ============================================================
 * 自有路由的管理员鉴权（抽出来共用）
 * ------------------------------------------------------------
 * 契约注册表里的路由由 registry 统一按 `auth: 'admin'` 校验，
 * 但**本地挂载**的路由（/api/admin/export-static、AI 配置等）
 * 不走那一层，得自己鉴权。以前这段逻辑写在 static-export.ts 里，
 * 现在新增自有的写接口会再来一遍——复制两份迟早会漏改一处，
 * 而漏掉的那处正好是「API Key 能被匿名读写」这种最糟的漏洞。
 *
 * 所以抽成单一实现：查 admin_sessions，兼容静态写入令牌。
 * ============================================================ */
import type { Context } from 'hono';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../types.js';

export function jsonError(c: Context, status: number, error: string): Response {
  return c.json({ ok: false, error }, status as 400);
}

/**
 * 校验管理员会话。
 * @returns 通过时返回 null；失败时返回**已经构造好的** 401 响应，直接 return 即可。
 */
export async function authenticateAdmin(
  c: Context,
  config: AppConfig,
  db: AppDatabase
): Promise<Response | null> {
  const header = c.req.header('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = m ? m[1].trim() : '';
  if (!token) {
    return jsonError(c, 401, '未授权：请先登录获取会话 token，并在请求头携带 Authorization: Bearer <token>');
  }

  // 兼容部署里仍然在用的静态写入令牌
  if (config.admin.writeToken && token === config.admin.writeToken) return null;

  const row = await db
    .first<{ exp?: number | null }>('SELECT exp FROM admin_sessions WHERE token = ?', token)
    .catch(() => null);
  const exp = Number(row?.exp ?? 0);
  if (!row || !Number.isFinite(exp) || exp <= Date.now()) {
    return jsonError(c, 401, '会话已过期，请重新登录后再试。');
  }
  return null;
}
