import { handleSiteFiles } from '../../../_lib/api-core.js';

/** GET /api/site-files/:name（下载产物内容） */
export async function onRequest(context) {
  const name = context.params && context.params.name ? context.params.name : null;
  return handleSiteFiles(context.request, context.env, name);
}
