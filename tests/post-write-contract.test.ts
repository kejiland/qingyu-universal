/* ============================================================
 * 文章写接口的契约容忍度 —— 回归测试
 * ------------------------------------------------------------
 * 背景（2026-10-09 真实故障）：后台「发布文章」直接 400
 *   「保存失败参数校验失败：body.publishAt: Invalid input」
 * 根因：编辑器恒定带 publishAt，非定时文章传的是 **null**
 *       （admin.js 的 savePost 里 `var publishAt = null;`），
 *       而契约把 publishAt 声明成 number|string —— 比上游更严。
 *
 * 上游 normalizePost() 对每个字段都做强制转换（String / !! / Number），
 * 任何 JSON 值（含 null）都吃得下去，只拦三项：
 *   缺 id、缺 title、定时发布却没给时间。
 * 契约层是**只读校验**，绝不能比上游更严 —— 这里把这条不变式写死。
 *
 * 判定「到底是谁在拒绝」的关键：契约层拒绝的文案是「参数校验失败：…」，
 * 上游业务拒绝的文案是「缺少 id 或 title」之类。下面每条断言都据此区分。
 * ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';

let server: TestServer;
let token = '';

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  const response = await fetch(server.baseUrl + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 300) }; }
  return { status: response.status, data };
}

const auth = (): RequestInit => ({ headers: {} });

/** 契约层拒绝的特征文案 */
const rejectedByContract = (data: any): boolean =>
  typeof data?.error === 'string' && data.error.indexOf('参数校验失败') === 0;

/** 后台编辑器 savePost() 实际构造的请求体（非定时文章） —— 逐字对齐真实提交 */
function editorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `editor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: '编辑器提交的文章',
    date: '2026-10-09 13:00:00',
    // 非定时文章：编辑器传的是 null。这一行就是当初 400 的元凶。
    publishAt: null,
    series: '',
    author: '',
    ogImage: '',
    seriesOrder: 0,
    excerpt: '摘要',
    content: '# 正文\n\n内容。',
    cover: '',
    seo: { title: '', desc: '', canonical: '', noindex: false },
    protected: false,
    enc: null,
    pinned: false,
    tags: ['测试'],
    category: '',
    status: 'published',
    ...overrides
  };
}

beforeAll(async () => {
  server = await startTestServer();
  await call('/api/admin/setup', {
    method: 'POST',
    headers: { 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'Post-Write-Test-Pw-1' })
  });
  const login = await call('/api/admin/login', {
    method: 'POST',
    headers: { 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'Post-Write-Test-Pw-1' })
  });
  token = login.data?.token ?? '';
});

afterAll(async () => {
  await server?.close();
});

describe('文章写接口：契约不得比上游更严', () => {
  it('拿到管理员会话', () => {
    expect(token).toBeTruthy();
  });

  it('★ 编辑器真实提交体（publishAt=null）能发布成功，不再 400', async () => {
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify(editorPayload())
    });
    expect(rejectedByContract(data)).toBe(false);
    expect(status).toBe(201);
    expect(data.post?.status).toBe('published');
    // 上游 normalizePublishAt 把非定时文章的 publishAt 归一为 null
    expect(data.post?.publishAt).toBeNull();
  });

  it('★ PUT 更新同样接受 publishAt=null', async () => {
    const id = `put-${Date.now().toString(36)}`;
    await call('/api/posts', { method: 'POST', body: JSON.stringify(editorPayload({ id })) });
    const { status, data } = await call(`/api/posts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(editorPayload({ id, title: '更新后标题' }))
    });
    expect(rejectedByContract(data)).toBe(false);
    expect(status).toBe(200);
    expect(data.post?.title).toBe('更新后标题');
  });

  it('★ 所有字段同时为 null 也不该由契约层拒绝（上游全量强制转换）', async () => {
    const { data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        id: `allnull-${Date.now().toString(36)}`,
        title: '全空字段',
        date: null, excerpt: null, content: null, cover: null,
        ogImage: null, og_image: null, pinned: null, protected: null, enc: null,
        category: null, series: null, seriesOrder: null, series_order: null,
        author: null, status: null, publishAt: null, publish_at: null,
        seo: null, tags: null
      })
    });
    // 允许上游因为业务原因拒绝，但**绝不能**是契约层在拒绝
    expect(rejectedByContract(data)).toBe(false);
    if (data?.ok) {
      // 上游把 null 归一化后的结果
      expect(data.post.status).toBe('published');   // 非 draft/scheduled 一律 published
      expect(data.post.publishAt).toBeNull();
      expect(data.post.pinned).toBe(false);
      expect(Array.isArray(data.post.tags)).toBe(true);
    }
  });

  it('★ 数字型字段给字符串也能过（上游用 Number() 转换）', async () => {
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify(editorPayload({
        id: `numstr-${Date.now().toString(36)}`,
        pinned: 1, protected: 0, seriesOrder: '3'
      }))
    });
    expect(rejectedByContract(data)).toBe(false);
    expect(status).toBe(201);
    expect(data.post.pinned).toBe(true);
    expect(data.post.protected).toBe(false);
    expect(data.post.seriesOrder).toBe(3);
  });

  it('★ 上游容忍的蛇形别名与字符串标签仍然可用', async () => {
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify(editorPayload({
        id: `alias-${Date.now().toString(36)}`,
        og_image: 'https://example.com/og.png',
        series_order: 2,
        publish_at: null,
        tags: '标签A,标签B'
      }))
    });
    expect(rejectedByContract(data)).toBe(false);
    expect(status).toBe(201);
    expect(data.post.ogImage).toBe('https://example.com/og.png');
    expect(data.post.seriesOrder).toBe(2);
    expect(data.post.tags).toEqual(['标签A', '标签B']);
  });

  it('定时发布带时间戳：publishAt 被保留', async () => {
    const at = Date.now() + 3600_000;
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify(editorPayload({
        id: `sched-${Date.now().toString(36)}`,
        status: 'scheduled',
        publishAt: at
      }))
    });
    expect(status).toBe(201);
    expect(data.post.status).toBe('scheduled');
    expect(data.post.publishAt).toBe(Math.floor(at));
  });

  it('定时发布缺时间：由**上游**拒绝（错误来自业务，不是契约层）', async () => {
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify(editorPayload({
        id: `schedbad-${Date.now().toString(36)}`,
        status: 'scheduled',
        publishAt: null
      }))
    });
    expect(status).toBe(400);
    expect(rejectedByContract(data)).toBe(false);
    expect(String(data.error)).toContain('定时发布');
  });

  it('缺 title：由**上游**拒绝（错误来自业务，不是契约层）', async () => {
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ id: `notitle-${Date.now().toString(36)}` })
    });
    expect(status).toBe(400);
    expect(rejectedByContract(data)).toBe(false);
  });

  it('契约层仍然会拦「类型明显不可转换」的请求（没有一味放宽）', async () => {
    // tags 给对象：上游会 String() 出一个 "[object Object]" 标签，属于客户端 bug，
    // 契约层拦下来是合理的（这条也防止上面的放宽被误读成「一律放行」）
    const { data } = await call('/api/posts', {
      method: 'POST',
      body: JSON.stringify(editorPayload({ id: `obj-${Date.now().toString(36)}`, tags: { a: 1 } }))
    });
    expect(rejectedByContract(data)).toBe(true);
  });
});
