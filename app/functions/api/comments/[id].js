/* Cloudflare Pages Functions · /api/comments/:id
 * PUT/POST → 修改审核状态（approved / pending）   DELETE → 删除评论 */
import { handleCommentUpdate, handleCommentDeleteGlobal } from '../../_lib/api-core.js';

export async function onRequestPut(context) {
  return handleCommentUpdate(context.request, context.env, context.params.id);
}
export async function onRequestPost(context) {
  return handleCommentUpdate(context.request, context.env, context.params.id);
}
export async function onRequestDelete(context) {
  return handleCommentDeleteGlobal(context.request, context.env, context.params.id);
}
export async function onRequestOptions(context) {
  return handleCommentUpdate(context.request, context.env, context.params.id);
}
