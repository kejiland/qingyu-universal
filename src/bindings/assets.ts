/* ============================================================
 * ASSETS 兼容层（本地静态资源）
 * ------------------------------------------------------------
 * 上游 worker.js 通过 env.ASSETS.fetch(request) 取 public/ 下的文件。
 * 这里用文件系统实现同款接口，并兼容 Cloudflare Pages 的 _redirects 语义
 * （本项目只用到 /public/* → /:splat 301，其余靠 worker.js 的 SPA 回退）。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { AssetsBindingLike } from '../types.js';

const MIME: Record<string, string> = {
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

export function contentTypeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/* ============================================================
 * 静态资源 gzip
 * ------------------------------------------------------------
 * Cloudflare 版由边缘自动压缩；自托管版此前裸传 —— style.min.css
 * 101KB、app.min.js 167KB 原样出网，公网访问首屏传输量白白多 3~4 倍。
 * 这里对文本类静态资源做 gzip + 进程内缓存（按 mtime+size 失效）：
 *  · 只压文本类（html/js/css/json/xml/svg/txt/webmanifest）；
 *  · 只压 >=1KB 的文件，二进制（图片/字体/音频）不碰；
 *  · 客户端 Accept-Encoding 不含 gzip 时保持原样；
 *  · 缓存上限 48 条（全是几十 KB 级文本，约 2~3MB 内存），LRU 淘汰；
 *  · 压缩响应的 ETag 追加 -gzip 后缀（nginx 惯例），避免裸传与
 *    压缩两种字节混用同一弱 ETag 造成 304 误判。
 * ============================================================ */
const COMPRESSIBLE_TYPES = new Set([
  'text/html', 'text/javascript', 'text/css', 'application/json',
  'application/manifest+json', 'application/xml', 'text/plain', 'image/svg+xml'
]);
/* 静态资源缓存头。
 * 之前这里不负 Cache-Control，浏览器只看得到 Last-Modified，
 * 就会自行按「部分时间推算的新鲜度」静默复用本地副本，
 * 于是更新后手机还看到旧的 app.min.js / polish.min.css，
 * 只能手动清缓存。写明确的失效策略后，
 * 每次访问都必须回源校验（未变就是 304，变了就拿新文件）。
 * 文件名不包含内容哈希，不能用 immutable —— 否则更新后始终拿旧副本。 */
const ASSET_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const GZIP_MIN_BYTES = 1024;
const GZIP_CACHE_MAX = 48;
const gzipCache = new Map<string, { body: Uint8Array; etag: string }>();

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/i.test(request.headers.get('Accept-Encoding') || '');
}

async function gzipAsset(target: string, stat: fs.Stats, etag: string): Promise<{ body: Uint8Array; etag: string }> {
  const key = `${target}|${stat.mtimeMs}|${stat.size}`;
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const raw = await fsp.readFile(target);
  const body = await new Promise<Uint8Array>((resolve, reject) => {
    zlib.gzip(raw, { level: 6 }, (err, out) => (err ? reject(err) : resolve(new Uint8Array(out))));
  });
  const gzEtag = etag.replace(/"$/, '-gzip"');
  const entry = { body, etag: gzEtag };
  if (gzipCache.size >= GZIP_CACHE_MAX) {
    const oldest = gzipCache.keys().next().value;
    if (oldest !== undefined) gzipCache.delete(oldest);
  }
  gzipCache.set(key, entry);
  return entry;
}

/** 解析请求路径到 root 内的真实文件，阻断 ../ 目录穿越。 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* 保留原始值，交由后续校验 */
  }
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (normalized.split('/').includes('..')) return null;
  const target = path.join(root, normalized);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

export class AssetsBinding implements AssetsBindingLike {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    // _redirects 规则：/public/* → /:splat（301）
    if (url.pathname === '/public' || url.pathname.startsWith('/public/')) {
      const rest = url.pathname.replace(/^\/public\/?/, '');
      return new Response(null, {
        status: 301,
        headers: { Location: `/${rest}${url.search}`, 'Cache-Control': 'no-store' }
      });
    }

    let target = resolveWithinRoot(this.root, url.pathname);
    if (!target) return new Response('Bad Request', { status: 400 });

    let stat = await fsp.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fsp.stat(target).catch(() => null);
    }
    if (!stat?.isFile()) return new Response('Not Found', { status: 404 });

    const ctype = contentTypeFor(target);
    const gzCandidate =
      acceptsGzip(request) &&
      stat.size >= GZIP_MIN_BYTES &&
      COMPRESSIBLE_TYPES.has(ctype.split(';')[0]);

    if (gzCandidate) {
      const gz = await gzipAsset(target, stat, `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`);
      const headers = new Headers({
        'Content-Type': ctype,
        'Content-Encoding': 'gzip',
        'Content-Length': String(gz.body.length),
        'Last-Modified': stat.mtime.toUTCString(),
        ETag: gz.etag,
        Vary: 'Accept-Encoding',
        'Cache-Control': ASSET_CACHE_CONTROL
      });
      if (request.headers.get('If-None-Match') === gz.etag) {
        return new Response(null, { status: 304, headers });
      }
      if (method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(gz.body, { status: 200, headers });
    }

    const headers = new Headers({
      'Content-Type': ctype,
      'Content-Length': String(stat.size),
      'Last-Modified': stat.mtime.toUTCString(),
      ETag: `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`,
      'Cache-Control': ASSET_CACHE_CONTROL
    });

    if (request.headers.get('If-None-Match') === headers.get('ETag')) {
      return new Response(null, { status: 304, headers });
    }
    if (method === 'HEAD') return new Response(null, { status: 200, headers });

    const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers });
  }
}

export function createAssets(rootDir: string): AssetsBinding {
  return new AssetsBinding(rootDir);
}