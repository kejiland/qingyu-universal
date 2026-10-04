/* Cloudflare Pages Functions · /api/feed.xml（RSS 源）
 * 由 KV 中的文章生成 RSS 2.0；站点地址取 env.SITE_URL，未配置则用请求来源。
 */
import { handleFeed } from '../_lib/api-core.js';

export async function onRequestGet(context) {
  return handleFeed(context.request, context.env);
}
export async function onRequestOptions(context) {
  return handleFeed(context.request, context.env);
}