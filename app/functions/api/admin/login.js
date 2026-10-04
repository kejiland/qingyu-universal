/* Cloudflare Pages Functions · /api/admin/login
 * POST { password } → 服务端校验 PBKDF2 哈希 → 返回会话 token（7 天 TTL）。
 * 内置暴力破解防护：同一 IP 连续失败 5 次锁定 15 分钟。 */
import { handleAdminLogin } from '../../_lib/api-core.js';

export async function onRequest(context) {
  return handleAdminLogin(context.request, context.env);
}
export async function onRequestOptions(context) {
  return handleAdminLogin(context.request, context.env);
}