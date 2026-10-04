/* Cloudflare Pages Functions · /api/sitemap.xml（SEO 站点地图）
 * 站点地址取 env.SITE_URL，未配置则用请求来源。 */
import { handleSitemap } from '../_lib/api-core.js';

export async function onRequestGet(context) {
  return handleSitemap(context.request, context.env);
}
export async function onRequestOptions(context) {
  return handleSitemap(context.request, context.env);
}