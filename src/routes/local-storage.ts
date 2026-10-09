/* ============================================================
 * 本地存储路由：签名上传 / 私有下载 / 公开对象读取
 * ------------------------------------------------------------
 * 与 S3 预签名 URL 的行为对齐：浏览器拿到的仍是一个可直接 PUT 的
 * 绝对地址，只是这个地址指向应用自身而不是对象存储。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context } from 'hono';
import type { LocalStorage } from '../bindings/storage.js';
import { contentTypeFor } from '../bindings/assets.js';

/**
 * 本地上传/下载端点的 CORS 头。
 *
 * 上传地址由服务端按 SITE_URL 生成，但**用户实际访问后台的地址可能不同**
 * （例如安装脚本探测到公网 IP、而用户用 localhost 打开；或反之）。
 * 这时 PUT 会变成跨域请求，浏览器先发 OPTIONS 预检 —— 若端点不返回
 * CORS 头，预检失败，XHR 触发 onerror，前端只能报「上传失败：网络错误」，
 * 完全看不出真正原因。
 *
 * 安全性：该端点靠 URL 里的 HMAC 签名鉴权，放开来源不会降低安全性 ——
 * 没有有效签名，任何来源都传不进来。
 */
function corsHeaders(c: Context): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': c.req.header('origin') || '*',
    'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

/** 上传兜底上限（图片 10MB / 音乐 30MB，留足余量）。 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** 流式字节计数，超限即中断，避免超大请求把磁盘写满。 */
function byteLimitGuard(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > max) {
        callback(new Error('UPLOAD_TOO_LARGE'));
        return;
      }
      callback(null, chunk);
    }
  });
}

export function createLocalUploadHandler(storage: LocalStorage) {
  return async (c: Context): Promise<Response> => {
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(c) });
    if (c.req.method !== 'PUT' && c.req.method !== 'POST') {
      return c.json({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const url = new URL(c.req.url);
    const key = url.searchParams.get('key') ?? '';
    const expires = url.searchParams.get('exp') ?? '';
    const contentType = url.searchParams.get('ct') ?? '';
    const signature = url.searchParams.get('sig') ?? '';

    if (!storage.verify('PUT', key, expires, contentType, signature)) {
      return c.json({ ok: false, error: '上传地址无效或已过期' }, 403);
    }

    const declaredLength = Number(c.req.header('content-length') ?? 0);
    if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
      return c.json({ ok: false, error: '文件超出大小限制' }, 413);
    }

    const target = storage.resolve(key);
    if (!target) return c.json({ ok: false, error: '非法的对象 key' }, 400);

    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const body = c.req.raw.body;
      if (!body) {
        await fsp.writeFile(target, Buffer.alloc(0));
      } else {
        await pipeline(
          Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
          byteLimitGuard(MAX_UPLOAD_BYTES),
          fs.createWriteStream(target)
        );
      }
      if (contentType) await fsp.writeFile(`${target}.meta`, contentType, 'utf8').catch(() => {});

      const stat = await fsp.stat(target);
      return c.json({ ok: true, key, size: stat.size }, 200, corsHeaders(c));
    } catch (error) {
      await fsp.rm(target, { force: true }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UPLOAD_TOO_LARGE')) {
        return c.json({ ok: false, error: '文件超出大小限制' }, 413);
      }
      return c.json({ ok: false, error: `写入失败：${message}` }, 500);
    }
  };
}

export function createLocalDownloadHandler(storage: LocalStorage) {
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const key = url.searchParams.get('key') ?? '';
    const expires = url.searchParams.get('exp') ?? '';
    const signature = url.searchParams.get('sig') ?? '';

    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(c) });
    if (!storage.verify('GET', key, expires, '', signature)) {
      return c.json({ ok: false, error: '下载地址无效或已过期' }, 403);
    }

    const target = storage.resolve(key);
    const stat = target ? await fsp.stat(target).catch(() => null) : null;
    if (!target || !stat?.isFile()) return c.json({ ok: false, error: '对象不存在' }, 404);

    const metaType = (await storage.readMeta(target)).trim();
    // HEAD 必须先返回、不要建流：ReadStream 会在下一个 tick 打开 fd，
    // 而没人消费它的 body —— 每个 HEAD 请求都会漏一个文件描述符。
    if (c.req.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': metaType || contentTypeFor(target),
          'Content-Length': String(stat.size),
          'Cache-Control': 'no-store'
        }
      });
    }
    const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': metaType || contentTypeFor(target),
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store'
      }
    });
  };
}

/** 公开对象：/media/* /music/* /og/*，支持 HTTP Range（音频拖动播放）。 */
export function createPublicObjectHandler(storage: LocalStorage) {
  return async (c: Context): Promise<Response> => {
    const target = storage.resolvePublic(new URL(c.req.url).pathname);
    if (!target) return c.text('Bad Request', 400);

    const stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile()) return c.text('Not Found', 404);

    const contentType = (await storage.readMeta(target)).trim() || contentTypeFor(target);
    const baseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Last-Modified': stat.mtime.toUTCString()
    };

    const rangeHeader = c.req.header('range');
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;

    if (match && (match[1] || match[2])) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1]) {
        start = Math.max(0, stat.size - Number(match[2]));
        end = stat.size - 1;
      }
      if (start >= stat.size || end >= stat.size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      }
      const length = end - start + 1;
      const rangeHeaders = { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(length) };
      // 同上：HEAD 不建流，否则每个请求漏一个 fd。
      if (c.req.method === 'HEAD') return new Response(null, { status: 206, headers: rangeHeaders });
      const stream = Readable.toWeb(fs.createReadStream(target, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(stream, { status: 206, headers: rangeHeaders });
    }

    if (c.req.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(stat.size) } });
    }
    const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(stat.size) }
    });
  };
}