/* Cloudflare Pages Functions · /api/admin/logout
 * POST 撤销当前会话 token（Authorization: Bearer <token>）。 */
import { handleAdminLogout } from '../../_lib/api-core.js';

export async function onRequest(context) {
  return handleAdminLogout(context.request, context.env);
}
export async function onRequestOptions(context) {
  return handleAdminLogout(context.request, context.env);
}