import { handleSiteFiles } from '../../../_lib/api-core.js';

/** POST /api/site-files（保存产物） · GET /api/site-files（列产物） */
export async function onRequest(context) {
  return handleSiteFiles(context.request, context.env, null);
}
