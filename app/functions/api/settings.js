/* Cloudflare Pages Functions · /api/settings
 * GET → 读取全部站点设置   PUT/POST → 合并写入（需会话 token） */
import { handleSettings } from '../_lib/api-core.js';

export async function onRequest(context) {
  return handleSettings(context.request, context.env);
}
