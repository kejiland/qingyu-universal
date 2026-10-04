/* Cloudflare Pages Functions · /api/comments
 * GET → 后台全局评论列表（可按 ?status=pending|approved 过滤） */
import { handleCommentsList } from '../_lib/api-core.js';

export async function onRequestGet(context) {
  return handleCommentsList(context.request, context.env);
}
export async function onRequestOptions(context) {
  return handleCommentsList(context.request, context.env);
}
