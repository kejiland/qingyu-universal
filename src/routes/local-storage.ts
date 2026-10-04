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
      return c.json({ ok: true, key, size: stat.size });
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

    if (!storage.verify('GET', key, expires, '', signature)) {
      return c.json({ ok: false, error: '下载地址无效或已过期' }, 403);
    }

    const target = storage.resolve(key);
    const stat = target ? await fsp.stat(target).catch(() => null) : null;
    if (!target || !stat?.isFile()) return c.json({ ok: false, error: '对象不存在' }, 404);

    const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream<Uint8Array>;
    const metaType = (await storage.readMeta(target)).trim();
    return new Response(c.req.method === 'HEAD' ? null : stream, {
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
      const stream = Readable.toWeb(fs.createReadStream(target, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(c.req.method === 'HEAD' ? null : stream, {
        status: 206,
        headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(length) }
      });
    }

    const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream<Uint8Array>;
    return new Response(c.req.method === 'HEAD' ? null : stream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(stat.size) }
    });
  };
}