/* ============================================================
 * 外链图片本地缓存反代：GET /api/img?url=<原始地址>
 * ------------------------------------------------------------
 * 把「浏览器直连境外图床」换成「浏览器连本站 + 服务端抓取一次并落盘缓存」。
 * 首屏封面 / 头像的首次加载从「跨洋 TLS 0.4s + TTFB 0.4s」降到同源毫秒级，
 * 且命中缓存后带 immutable 强缓存，后续访问不再产生任何外部请求。
 *
 * 安全：这是**由 URL 参数驱动的外网请求**，必须防 SSRF ——
 *   1. 只允许 http/https；
 *   2. 解析 DNS，命中私有 / 环回 / 链路本地 / 组播 / CGNAT 段一律 403；
 *   3. 重定向逐跳重新校验（不交给 fetch 自动跟随，否则可跳进内网）；
 *   4. 只接受 image/* 响应，且流式计数限体积。
 * 已知残留风险：DNS rebinding（校验与实际连接之间域名可能重解析）。
 * 对自建博客场景可接受；要彻底消除得给 undici 挂自定义 lookup，代价过高。
 *
 * 未命中时才抓取。禁用（IMAGE_PROXY=0）或命中直通域名时 302 回原始地址，
 * 保证「关掉这个功能」后行为与改动前完全一致。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { setImageWarmer } from '../lib/image-url.js';

/** 单张抓取超时：宁可让 onerror 兜底把图摘掉，也不能把标签页挂死。 */
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
/** 失败地址的短期记忆，避免图床挂掉时每个请求都去超时一次。 */
const NEGATIVE_TTL_MS = 60_000;
/** 每写入这么多张检查一次缓存总量。 */
const PRUNE_EVERY = 50;

export interface ImageProxyOptions {
  /** 缓存根目录（默认 DATA_DIR/cache/img）。 */
  cacheDir: string;
  enabled?: boolean;
  /** 单张体积上限（字节）。 */
  maxBytes?: number;
  /** 缓存目录总容量（字节），超出按 mtime 淘汰最旧的。 */
  cacheBytes?: number;
  /** 这些主机名直接 302 回原始地址（本站域名、已配置的对象存储公网域名）。 */
  passthroughHosts?: string[];
  /**
   * 测试注入。resolve 用来替换真实 DNS —— 否则内网判定会随测试机的
   * DNS 环境漂移（实测 example.com 在某些网络下会被解析成内网地址）。
   */
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  logger?: (message: string) => void;
}

const defaultResolve = async (host: string): Promise<string[]> => {
  const entries = await dns.lookup(host, { all: true });
  return entries.map((entry) => (typeof entry === 'string' ? entry : entry.address));
};

class ProxyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ---------------- 内网地址判定 ---------------- */

function stripBrackets(host: string): string {
  return String(host ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * 只拦**真正可能跑着内网服务**的网段。
 *
 * 刻意**不拦** RFC 保留的文档 / 基准段（192.0.2/24、198.51.100/24、
 * 203.0.113/24、198.18/15）：那些段上不会有内网服务，拦了没有安全收益，
 * 却会误伤 —— Clash / Mihomo 的 fake-IP 模式默认就用 198.18.0.0/15，
 * 实测容器内 images.2024921.xyz 被解析成 198.18.2.245，一拦就把整个
 * 反代功能打成 403（容器其实能直连图床）。
 */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true; // 0/8、10/8、环回
  if (p[0] === 169 && p[1] === 254) return true; // 链路本地（云厂商 metadata 就在这）
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
  if (p[0] === 192 && p[1] === 168) return true; // 192.168/16
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
  if (p[0] >= 224) return true; // 组播 / 保留 / 广播：连过去没有意义
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = String(ip ?? '').toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (v.startsWith('::ffff:')) return true; // 非标准 IPv4-mapped，一律拒绝
  const head = v.split(':')[0] || '';
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true; // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true; // fe80::/10 链路本地
  if (/^ff[0-9a-f]{0,2}$/.test(head)) return true; // 组播
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v = stripBrackets(ip);
  const family = net.isIP(v);
  if (family === 4) return isPrivateIPv4(v);
  if (family === 6) return isPrivateIPv6(v);
  return true; // 不是合法 IP —— 按不安全处理
}

async function assertPublicHost(hostname: string, resolve: (host: string) => Promise<string[]>): Promise<void> {
  const host = stripBrackets(hostname);
  if (!host) throw new ProxyError(400, 'URL 缺少主机名');
  if (/\.localhost$|\.local$|\.internal$|\.home\.arpa$/.test(host) || host === 'localhost') {
    throw new ProxyError(403, '拒绝代理内网域名');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ProxyError(403, '拒绝代理内网地址');
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ProxyError(502, '域名解析失败');
  }
  if (!addresses.length) throw new ProxyError(502, '域名解析失败');
  for (const address of addresses) {
    if (isPrivateIp(address)) throw new ProxyError(403, '拒绝代理内网地址');
  }
}

/* ---------------- 抓取 ---------------- */

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new ProxyError(413, '图片超出大小限制');
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已 cancel 时 releaseLock 会抛，忽略 */
    }
  }
  return Buffer.concat(chunks);
}

async function fetchImage(
  startUrl: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  resolve: (host: string) => Promise<string[]>
): Promise<{ body: Buffer; contentType: string }> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ProxyError(400, '只支持 http/https 地址');
    }
    await assertPublicHost(parsed.hostname, resolve);

    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new ProxyError(502, '源站重定向缺少 Location');
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new ProxyError(502, `源站返回 ${res.status}`);

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new ProxyError(415, `源站返回的不是图片（${contentType || '未知类型'}）`);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new ProxyError(413, '图片超出大小限制');
    const body = await readCapped(res, maxBytes);
    return { body, contentType };
  }
  throw new ProxyError(502, '重定向次数过多');
}

/* ---------------- 缓存 ---------------- */

function cacheFile(cacheDir: string, key: string): string {
  return path.join(cacheDir, key.slice(0, 2), key);
}

async function pruneCache(cacheDir: string, cacheBytes: number): Promise<void> {
  const entries: Array<{ file: string; mtime: number; size: number }> = [];
  let total = 0;
  for (const shard of await fsp.readdir(cacheDir).catch(() => [])) {
    const dir = path.join(cacheDir, shard);
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.endsWith('.meta')) continue;
      const file = path.join(dir, name);
      const fileStat = await fsp.stat(file).catch(() => null);
      if (!fileStat?.isFile()) continue;
      // 用 atime（最后访问）而不是 mtime（最后写入）：
      // mtime 只记录「什么时候写进来的」，永不再变 —— 一张天天被访问的
      // 热门老图和一张从没人看的图会被一视同仁地按写入先后淘汰。
      // atime 才反映「最近还用不用」，这才是真正的 LRU。
      // NTFS 上 atime 的更新由系统管（默认对频繁访问做延迟合并），够用。
      entries.push({ file, mtime: Math.max(fileStat.atimeMs, fileStat.mtimeMs), size: fileStat.size });
      total += fileStat.size;
    }
  }
  if (total <= cacheBytes) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries) {
    if (total <= cacheBytes) break;
    await fsp.rm(entry.file, { force: true }).catch(() => {});
    await fsp.rm(`${entry.file}.meta`, { force: true }).catch(() => {});
    total -= entry.size;
  }
}

/* ---------------- 处理器 ---------------- */

export function createImageProxyHandler(options: ImageProxyOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve = options.resolve ?? defaultResolve;
  // 默认开启：不传就是开启（写成 `options.enabled ?? false` 的话，调用方漏传会静默降级成直通）。
  const enabled = options.enabled ?? true;
  const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
  const cacheBytes = options.cacheBytes ?? 512 * 1024 * 1024;
  const passthrough = new Set(
    (options.passthroughHosts ?? []).map((h) => String(h || '').toLowerCase()).filter(Boolean)
  );
  const inflight = new Map<string, Promise<{ body: Buffer; contentType: string }>>();
  const failures = new Map<string, number>();
  let writes = 0;

  async function loadFromDisk(key: string): Promise<{ file: string; contentType: string; size: number } | null> {
    const file = cacheFile(options.cacheDir, key);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    const meta = await fsp.readFile(`${file}.meta`, 'utf8').catch(() => '');
    return { file, contentType: meta.trim() || 'application/octet-stream', size: stat.size };
  }

  /**
   * 预热：给定一批 URL，跳过已在磁盘上的，后台抓取并落盘。
   * 文章写入成功后调用 —— 新封面是全新 URL，等读者来触发的话第一位读者仍是冷抓取。
   */
  setImageWarmer((urls) => {
    for (const url of urls) {
      const key = crypto.createHash('sha256').update(url).digest('hex');
      if (inflight.has(key)) continue;
      void loadFromDisk(key)
        .then(async (hit) => {
          if (hit) return;
          const pending = fetchImage(url, fetchImpl, maxBytes, resolve);
          inflight.set(key, pending);
          try {
            const { body, contentType } = await pending;
            await store(key, body, contentType);
          } catch {
            failures.set(key, Date.now());
          } finally {
            inflight.delete(key);
          }
        })
        .catch(() => {});
    }
  });

  async function store(key: string, body: Buffer, contentType: string): Promise<void> {
    const file = cacheFile(options.cacheDir, key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 先写临时文件再 rename：并发请求不会读到半截字节。
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
    await fsp.writeFile(`${file}.meta`, contentType, 'utf8');
  }

  return async function imageProxy(c: Context): Promise<Response> {
    const raw = (c.req.query('url') ?? '').trim();
    if (!raw) return c.text('Missing url', 400);

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return c.text('Invalid url', 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.text('Unsupported protocol', 400);
    }

    // 关闭反代、或目标本来就是本站 / 已配置的对象存储公网域名 —— 直接回原始地址。
    // 这样「关掉这个功能」后行为与改动前完全一致，不会多绕一圈。
    if (!enabled || passthrough.has(parsed.hostname.toLowerCase())) {
      return new Response(null, {
        status: 302,
        headers: { Location: raw, 'Cache-Control': 'public, max-age=3600' }
      });
    }

    const key = crypto.createHash('sha256').update(raw).digest('hex');

    const failedAt = failures.get(key);
    if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) {
      return new Response(null, {
        status: 302,
        headers: { Location: raw, 'Cache-Control': 'public, max-age=60', 'X-Image-Proxy': 'recent-failure' }
      });
    }
    if (failedAt) failures.delete(key);

    const hit = await loadFromDisk(key);
    if (hit) {
      const etag = `"${key}"`;
      if (c.req.header('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      const headers: Record<string, string> = {
        'Content-Type': hit.contentType,
        'Content-Length': String(hit.size),
        // 内容由 URL 唯一决定，永不变更 —— 可以让浏览器和 CDN 放心永久缓存。
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        'X-Image-Proxy': 'hit'
      };
      if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
      const stream = fs.createReadStream(hit.file);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: 200, headers });
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchImage(raw, fetchImpl, maxBytes, resolve);
      inflight.set(key, pending);
      pending
        .then(async ({ body, contentType }) => {
          failures.delete(key);
          await store(key, body, contentType);
          if (++writes % PRUNE_EVERY === 0) await pruneCache(options.cacheDir, cacheBytes);
        })
        .catch((error: unknown) => {
          failures.set(key, Date.now());
          const message = error instanceof Error ? error.message : String(error);
          options.logger?.(`/api/img 抓取失败（${message}）：${raw}`);
        })
        .finally(() => inflight.delete(key));
    }

    let result: { body: Buffer; contentType: string };
    try {
      result = await pending;
    } catch (error) {
      const status = (error instanceof ProxyError ? error.status : 502) as ContentfulStatusCode;
      const message = error instanceof Error ? error.message : '抓取失败';
      return c.text(message, status);
    }

    const etag = `"${key}"`;
    const headers: Record<string, string> = {
      'Content-Type': result.contentType,
      'Content-Length': String(result.body.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      'X-Image-Proxy': 'miss'
    };
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(new Uint8Array(result.body), { status: 200, headers });
  };
}
