/* Cloudflare Pages Functions · /api/posts/[id]/stats
 * GET 阅读数/点赞 · POST { action: 'views' | 'like' } 累计（公开） */
import { handleStats } from '../../../_lib/api-core.js';

export async function onRequest(context) {
  return handleStats(context.request, context.env, context.params.id);
}