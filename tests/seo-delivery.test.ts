/* ============================================================
 * 文章页的传输层：压缩 + 缓存
 * ------------------------------------------------------------
 * 「首次打开一篇文章有点久」的两条服务器侧原因，都在这里被钉住：
 *   1. SSR 出来的 HTML 之前**完全没有压缩**（静态 CSS/JS 有，HTML 没有），
 *      一篇长文章的正文要走完整字节数。
 *   2. 文章页发的是 Cache-Control: no-cache —— 浏览器缓存形同虚设，
 *      每次打开都要重新向服务器要整份 HTML。
 * 现在：Node 层直接压缩（直连部署也生效），已发布文章允许短期复用，
 * 并用 ETag 保证文章一旦更新就立刻回源。
 * ============================================================ */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';

let server: TestServer;
let token = '';
const postId = 'delivery-test-article';

async function json(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(server.baseUrl + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** 不经过 fetch 解压，直接数响应体在网络上的字节数。 */
function rawBytes(pathname: string, acceptEncoding = 'gzip'): Promise<number> {
  const url = new URL(server.baseUrl + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: Number(url.port), path: url.pathname, headers: { 'accept-encoding': acceptEncoding } },
      (res) => {
        let total = 0;
        res.on('data', (chunk: Buffer) => { total += chunk.length; });
        res.on('end', () => resolve(total));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  server = await startTestServer();
  await json('/api/admin/setup', {
    method: 'POST',
    headers: { 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'Delivery-Test-Pw-1' })
  });
  const login = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'Delivery-Test-Pw-1' })
  });
  token = login?.token ?? '';
  await json('/api/posts', {
    method: 'POST',
    body: JSON.stringify({
      id: postId,
      title: '传输测试文章',
      date: '2026-10-09T00:00:00.000Z',
      status: 'published',
      content: '传输测试正文，重复段落用于撑起体积。'.repeat(60)
    })
  });
});

afterAll(async () => {
  await server?.close();
});

describe('文章页传输：压缩与缓存', () => {
  it('带 Accept-Encoding 时 HTML 被压缩，实际传输字节数明显更小', async () => {
    const plain = await fetch(`${server.baseUrl}/posts/${postId}/`, { headers: { 'accept-encoding': 'identity' } });
    const plainText = await plain.text();
    expect(plain.headers.get('content-encoding')).toBeNull();

    const zipped = await fetch(`${server.baseUrl}/posts/${postId}/`, { headers: { 'accept-encoding': 'gzip' } });
    expect(zipped.headers.get('content-encoding')).toBe('gzip');

    // fetch 会自动解压，必须回到原始 socket 量「真正过网线的字节数」
    const onWire = await rawBytes('/posts/' + postId + '/');
    expect(onWire).toBeLessThan(Buffer.byteLength(plainText));
  });

  it('文章页允许短期复用，并带 ETag', async () => {
    const res = await fetch(`${server.baseUrl}/posts/${postId}/`);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    expect(res.headers.get('cache-control')).toContain('stale-while-revalidate');
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('If-None-Match 命中返回 304，不重复传输正文', async () => {
    const first = await fetch(`${server.baseUrl}/posts/${postId}/`);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const second = await fetch(`${server.baseUrl}/posts/${postId}/`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
  });

  it('文章更新后 ETag 变化，不会命中旧缓存', async () => {
    const before = await fetch(`${server.baseUrl}/posts/${postId}/`);
    const etag = before.headers.get('etag') ?? '';
    await json(`/api/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: postId,
        title: '传输测试文章（已更新）',
        date: '2026-10-09T00:00:00.000Z',
        status: 'published',
        content: '更新后的正文内容。'
      })
    });
    const after = await fetch(`${server.baseUrl}/posts/${postId}/`);
    expect(after.headers.get('etag')).not.toBe(etag);
  });

  it('不存在的文章仍是 no-cache，不被公共缓存缓存住', async () => {
    const res = await fetch(`${server.baseUrl}/posts/no-such-post/`);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('首页与列表页：同样的压缩与缓存策略', () => {
  const pages = ['/', '/archive', '/tags', '/categories', '/about'];

  it.each(pages)('%s 允许短期复用并带 ETag', async (path) => {
    const res = await fetch(server.baseUrl + path);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    expect(res.headers.get('cache-control')).toContain('stale-while-revalidate');
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it.each(pages)('%s 的 HTML 也被压缩', async (path) => {
    const zipped = await fetch(server.baseUrl + path, { headers: { 'accept-encoding': 'gzip' } });
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    const plain = await fetch(server.baseUrl + path, { headers: { 'accept-encoding': 'identity' } });
    const plainText = await plain.text();
    expect(await rawBytes(path)).toBeLessThan(Buffer.byteLength(plainText));
  });

  it.each(pages)('%s 的 If-None-Match 命中返回 304', async (path) => {
    const first = await fetch(server.baseUrl + path);
    const etag = first.headers.get('etag') ?? '';
    const second = await fetch(server.baseUrl + path, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
  });

  it('不同筛选条件的首页不会共用同一个 ETag（否则 304 会返回错误的列表）', async () => {
    const all = await fetch(server.baseUrl + '/');
    const byTag = await fetch(server.baseUrl + '/?tag=%E4%BC%A0%E8%BE%93');
    expect(byTag.headers.get('etag')).not.toBe(all.headers.get('etag'));
  });

  it('新文章发布后首页 ETag 变化，不会被旧缓存压住', async () => {
    const before = await fetch(server.baseUrl + '/');
    const etag = before.headers.get('etag') ?? '';
    await json('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        id: 'delivery-test-new-post',
        title: '让首页 ETag 变化的新文章',
        date: '2026-10-09T01:00:00.000Z',
        status: 'published',
        content: '新文章正文。'
      })
    });
    const after = await fetch(server.baseUrl + '/');
    expect(after.headers.get('etag')).not.toBe(etag);
  });
});
