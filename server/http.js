/* ============================================================
 * HTTP 桥接：Node 原生 http ↔ Web Fetch API
 * ------------------------------------------------------------
 * 上游 worker.js 的入口签名是 fetch(Request) → Response（Workers 运行时）。
 * Node 18+ 已内置 Request / Response / fetch，因此这里只需做一层薄转换，
 * 无需 Express / Koa / Hono 之类的框架。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.json': 'application/json; charset=utf-8'
};

export function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 从反向代理头 / socket 中解析真实客户端 IP。 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

/** Node IncomingMessage → Web Request，并注入上游期望的 CF-* 头。 */
export function toWebRequest(req, config) {
  const trustProxy = !!config.trustProxy;
  const proto = trustProxy ? (req.headers['x-forwarded-proto'] || 'http') : 'http';
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
  const url = proto + '://' + host + (req.url || '/');

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.append(name, String(value));
  }

  // 上游「只信任 CDN 注入的 CF-Connecting-IP」——本进程就是可信边界，
  // 因此在这里统一注入，使限流 / 去重 / 统计拿到稳定的客户端标识。
  const ip = clientIp(req, trustProxy);
  if (ip) headers.set('CF-Connecting-IP', ip);

  // 可选地理统计：反向代理注入国家码（如 Caddy + GeoIP2 模块、Nginx geoip2）。
  const geoHeader = String(config.geoipHeader || '').toLowerCase();
  if (geoHeader && req.headers[geoHeader]) {
    headers.set('CF-IPCountry', String(req.headers[geoHeader]).toUpperCase().slice(0, 2));
  }

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init = { method: method, headers: headers };
  if (hasBody) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  const request = new Request(url, init);

  // 上游读取 request.cf.country 做来源统计；没有 GeoIP 时留空即可。
  const country = headers.get('CF-IPCountry');
  if (country) {
    try { Object.defineProperty(request, 'cf', { value: { country: country }, configurable: true }); }
    catch (_) { /* ignore */ }
  }
  return request;
}

/** Web Response → Node ServerResponse。 */
export async function sendWebResponse(res, response, method) {
  const headers = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, response.statusText || undefined, headers);
  if ((method || '').toUpperCase() === 'HEAD' || !response.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(response.body);
  stream.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
  stream.pipe(res);
}

/** 带 Range 的静态文件响应（音频拖动播放、图片按需读取）。 */
export async function serveStaticFile(req, res, filePath, options) {
  const opts = options || {};
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  const headers = {
    'Content-Type': opts.contentType || contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cacheControl || 'public, max-age=86400',
    'Last-Modified': stat.mtime.toUTCString()
  };
  if (opts.downloadName) headers['Content-Disposition'] = 'attachment; filename="' + opts.downloadName.replace(/"/g, '') + '"';

  const range = req.headers.range;
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : stat.size - 1;
    if (!match[1]) { start = Math.max(0, stat.size - Number(match[2])); end = stat.size - 1; }
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      res.end();
      return true;
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(206, headers);
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
    return true;
  }

  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(filePath).pipe(res);
  return true;
}