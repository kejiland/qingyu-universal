/* ============================================================
 * 新版后台静态托管
 * ------------------------------------------------------------
 * 由 Vite 构建到 admin/dist，挂在 /admin/ 下（与 vite.config.ts 的 base 一致）。
 *
 *   /admin            → 301 到 /admin/（保证相对路径与路由基线正确）
 *   /admin/           → index.html
 *   /admin/assets/*   → 构建产物（强缓存，文件名带内容哈希）
 *   /admin/<其它>      → index.html（SPA 客户端路由）
 *
 * 目录不存在时（未构建 / 开发环境）不注册任何路由，
 * 请求会自然落到上游的旧版后台，功能不中断。
 * ============================================================ */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'hono';
import { contentTypeFor } from '../bindings/assets.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

function resolveSafe(root: string, pathname: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* 保留原值交由后续校验 */
  }
  const relative = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (!relative || relative.split('/').includes('..')) return null;
  const target = path.join(root, relative);
  const within = path.relative(root, target);
  if (within.startsWith('..') || path.isAbsolute(within)) return null;
  return target;
}

export function adminAppAvailable(distDir: string): boolean {
  try {
    return fs.statSync(path.join(distDir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

export interface AdminAppHandler {
  index: (c: Context) => Promise<Response>;
  asset: (c: Context) => Promise<Response>;
}

export function createAdminAppHandler(distDir: string): AdminAppHandler {
  let shell: { html: string; mtimeMs: number } | null = null;

  async function loadShell(): Promise<string> {
    const file = path.join(distDir, 'index.html');
    const stat = await fsp.stat(file);
    if (!shell || shell.mtimeMs !== stat.mtimeMs) {
      shell = { html: await fsp.readFile(file, 'utf8'), mtimeMs: stat.mtimeMs };
    }
    return shell.html;
  }

  async function sendHtml(c: Context, html: string): Promise<Response> {
    return new Response(c.req.method === 'HEAD' ? null : html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(html)),
        'Cache-Control': 'no-cache',
        // 后台是纯客户端应用，禁掉索引与嵌入
        'X-Robots-Tag': 'noindex, nofollow'
      }
    });
  }

  /** /admin → /admin/：历史路由基线是 /admin/，少一个斜杠会让相对路径解析错位 */
  const index = async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    if (url.pathname === '/admin') {
      return new Response(null, { status: 301, headers: { Location: `/admin/${url.search}` } });
    }
    return sendHtml(c, await loadShell());
  };

  /** /admin/*：优先命中构建产物，未命中则回落到 SPA 外壳 */
  const asset = async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const relative = url.pathname.replace(/^\/admin\/?/, '');

    if (relative) {
      const target = resolveSafe(distDir, relative);
      const stat = target ? await fsp.stat(target).catch(() => null) : null;
      if (target && stat?.isFile()) {
        const headers: Record<string, string> = {
          'Content-Type': contentTypeFor(target),
          'Content-Length': String(stat.size),
          'Cache-Control': relative.startsWith('assets/') ? IMMUTABLE : 'public, max-age=3600',
          ETag: `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
        };
        if (c.req.header('if-none-match') === headers.ETag) {
          return new Response(null, { status: 304, headers });
        }
        if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(BunLikeFileStream(target), { status: 200, headers });
      }
    }

    // SPA 客户端路由（/admin/posts、/admin/media…）
    return sendHtml(c, await loadShell());
  };

  return { index, asset };
}

/** 用 Web 流包装文件读取，避免整文件进内存。 */
function BunLikeFileStream(filePath: string): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(filePath);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
    cancel() {
      nodeStream.destroy();
    }
  });
}