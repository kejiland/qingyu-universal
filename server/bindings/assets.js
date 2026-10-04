/* ============================================================
 * ASSETS 兼容层（本地静态资源）
 * ------------------------------------------------------------
 * 上游 worker.js 通过 env.ASSETS.fetch(request) 取 public/ 下的静态文件。
 * 这里用文件系统实现同款接口，并兼容 Cloudflare Pages 的 _redirects 语义
 * （本项目只用到 /public/* → /:splat 301 一条规则，其余靠 worker.js 的 SPA 回退）。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm'
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 解析请求路径到 public/ 内的真实文件，阻断 ../ 目录穿越。 */
function resolveSafe(rootDir, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (_) { decoded = pathname; }
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (normalized.split('/').includes('..')) return null;
  const target = path.join(rootDir, normalized);
  const relative = path.relative(rootDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

export class AssetsBinding {
  constructor(rootDir) {
    this.root = rootDir;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    // _redirects 规则 1：/public/* → /:splat（301）
    if (url.pathname === '/public' || url.pathname.startsWith('/public/')) {
      const rest = url.pathname.replace(/^\/public\/?/, '');
      return new Response(null, {
        status: 301,
        headers: { Location: '/' + rest + url.search, 'Cache-Control': 'no-store' }
      });
    }

    let target = resolveSafe(this.root, url.pathname);
    if (!target) return new Response('Bad Request', { status: 400 });

    let stat = await fsp.stat(target).catch(() => null);
    if (stat && stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fsp.stat(target).catch(() => null);
    }
    if (!stat || !stat.isFile()) return new Response('Not Found', { status: 404 });

    const headers = new Headers({
      'Content-Type': contentType(target),
      'Content-Length': String(stat.size),
      'Last-Modified': stat.mtime.toUTCString(),
      'ETag': 'W/"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"'
    });
    const inm = request.headers.get('If-None-Match');
    if (inm && inm === headers.get('ETag')) {
      return new Response(null, { status: 304, headers });
    }
    if (method === 'HEAD') return new Response(null, { status: 200, headers });

    const stream = fs.createReadStream(target);
    return new Response(ReadableStreamFrom(stream), { status: 200, headers });
  }
}

/** Node 可读流 → Web ReadableStream（无需外部依赖）。 */
export function ReadableStreamFrom(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
    cancel() { nodeStream.destroy(); }
  });
}

export function createAssets(rootDir) {
  return new AssetsBinding(rootDir);
}