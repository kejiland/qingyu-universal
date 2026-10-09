/* ============================================================
 * 管理员写权限校验 —— 供「自托管新增」的本地接口共用
 * ------------------------------------------------------------
 * 为什么单独成文件：这些接口**不经过上游**，因此必须自己做会话校验。
 * 校验语义必须与上游 isWriteAuthed 完全一致（authed && !mustChange），
 * 否则会出现「走上游的接口要改密码、走本地的接口不用」这种安全缺口。
 * 与其在 admin-ai.ts / admin-storage.ts 里各抄一份，不如只留一份实现。
 *
 * 上游语义（app/functions/_lib/api-core.js）：
 *   · admin_sessions 里存在未过期的 token → authed
 *   · admin_auth.k='auth' 的 must_change=1 → 必须先改初始密码，其它后台接口一律 403
 *   · 兼容旧的 BLOG_WRITE_TOKEN（部署脚本写入的静态令牌）
 * ============================================================ */
import { timingSafeEqual } from 'node:crypto';
import type { AppDatabase, WorkerEnv } from '../types.js';
import type { ApiContext } from './registry.js';
import { ErrorResponseSchema } from './contract/common.js';

/** 各接口 401/403 的文档声明完全一致，集中一份避免描述漂移。 */
export const ADMIN_AUTH_ERRORS = {
  401: { description: '未授权或会话已过期', schema: ErrorResponseSchema },
  403: { description: '仍需修改初始密码', schema: ErrorResponseSchema }
} as const;

const ADMIN_AUTH_KEY = 'auth';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export interface AdminAuthState {
  authed: boolean;
  mustChange: boolean;
}

/** 与上游 adminAuthState + isWriteAuthed 等价的最小实现。
 *  第二个参数只用到 BLOG_WRITE_TOKEN，类型收窄成 Pick 即可 —— 这样静态导出这类
 *  没有完整 WorkerEnv 的调用方也能复用同一套鉴权（含初始改密强制 + 常量时间比较），
 *  不必各自抄一份（抄一份就会漏掉 mustChange 闸门，见 2026-10-09 静态导出修复）。 */
export async function isAdminWriteAuthed(
  db: AppDatabase,
  env: Pick<WorkerEnv, 'BLOG_WRITE_TOKEN'> | WorkerEnv,
  authorization: string
): Promise<AdminAuthState> {
  const header = String(authorization || '').trim();
  const matched = /^Bearer\s+(.+)$/i.exec(header);
  const token = matched ? matched[1]!.trim() : '';

  if (token) {
    const session = await db
      .first<{ exp?: number | string }>('SELECT exp FROM admin_sessions WHERE token = ?', token)
      .catch(() => null);
    if (session) {
      const exp = Number(session.exp || 0);
      if (!exp || exp > Date.now()) {
        const auth = await db
          .first<{ must_change?: number | string }>('SELECT must_change FROM admin_auth WHERE k = ?', ADMIN_AUTH_KEY)
          .catch(() => null);
        return { authed: true, mustChange: Number(auth?.must_change || 0) === 1 };
      }
      // 过期会话顺手清理，避免表无限增长
      await db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run().catch(() => {});
    }
  }

  const legacy = String(env.BLOG_WRITE_TOKEN || '');
  if (legacy && safeEqual(header, `Bearer ${legacy}`)) return { authed: true, mustChange: false };

  return { authed: false, mustChange: false };
}

export interface AdminGuard {
  ok: boolean;
  response?: Response;
}

/** 路由入口的统一闸门：通过返回 {ok:true}，否则带上已经构造好的响应 */
export async function adminGuard(ctx: ApiContext): Promise<AdminGuard> {
  const state = await isAdminWriteAuthed(ctx.db, ctx.env, ctx.c.req.header('authorization') || '');
  if (!state.authed) {
    return { ok: false, response: ctx.c.json({ error: '未授权：请先登录后台' }, 401) };
  }
  if (state.mustChange) {
    return { ok: false, response: ctx.c.json({ error: '请先修改初始密码后再使用后台' }, 403) };
  }
  return { ok: true };
}
