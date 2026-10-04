/* Cloudflare Pages Functions · /api/posts/[id]/comments
 * GET 评论列表 · POST 发表评论（公开） */
import { handleComments } from '../../../_lib/api-core.js';

export async function onRequest(context) {
  return handleComments(context.request, context.env, context.params.id);
}