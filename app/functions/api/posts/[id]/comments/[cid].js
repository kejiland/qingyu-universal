/* Cloudflare Pages Functions · /api/posts/[id]/comments/[cid]
 * DELETE 删除评论（需写入令牌，用于管理） */
import { handleCommentId } from '../../../../_lib/api-core.js';

export async function onRequest(context) {
  return handleCommentId(context.request, context.env, context.params.id, context.params.cid);
}