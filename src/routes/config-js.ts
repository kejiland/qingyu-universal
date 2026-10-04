/* ============================================================
 * 前端配置注入
 * ------------------------------------------------------------
 * 上游 public/config.min.js 里硬编码了原作者的站点域名。
 * 这里在返回前把 siteUrl 替换成本站 SITE_URL，避免自托管后仍生成
 * 指向原作者域名的分享链接 / RSS 地址。
 * ============================================================ */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'hono';
import type { AppConfig } from '../config.js';

const SUPPORTED = new Set(['/config.js', '/config.min.js']);

export function createConfigJsHandler(config: AppConfig) {
  return async (c: Context): Promise<Response> => {
    const pathname = new URL(c.req.url).pathname;
    if (!SUPPORTED.has(pathname)) return c.notFound();

    const file = path.join(config.publicDir, pathname.slice(1));
    const source = await fsp.readFile(file, 'utf8').catch(() => null);
    if (source === null) return c.notFound();

    const overridden = source.replace(/(siteUrl\s*:\s*)(["'])[^"']*\2/, (_match, prefix: string, quote: string) => {
      return `${prefix}${quote}${config.siteUrl}${quote}`;
    });

    const body = Buffer.from(overridden, 'utf8');
    const etag = `W/"cfg-${body.length.toString(16)}-${config.siteUrl.length.toString(16)}"`;

    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    return c.body(body, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': String(body.length),
      ETag: etag,
      'Cache-Control': 'no-cache'
    });
  };
}