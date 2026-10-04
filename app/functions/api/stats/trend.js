/* Cloudflare Pages Functions · /api/stats/trend
 * GET → 近 N 天访问/点赞趋势（?days=30，需会话 token） */
import { handleStatsTrend } from '../_lib/api-core.js';

export async function onRequest(context) {
  return handleStatsTrend(context.request, context.env);
}
