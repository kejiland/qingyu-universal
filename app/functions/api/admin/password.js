/* Cloudflare Pages Functions · /api/admin/password
 * POST → 修改管理员密码（需会话 token + 校验当前密码） */
import { handleAdminPassword } from '../../_lib/api-core.js';

export async function onRequest(context) {
  return handleAdminPassword(context.request, context.env);
}
