/* ============================================================
 * API 契约测试
 * ------------------------------------------------------------
 * 对**真实运行的实例**逐条请求，把响应体直接喂给契约里声明的 schema。
 *
 * 这是整套契约机制的地基：文档、类型、校验都来自同一份 schema，
 * 如果声明和实际返回不一致，这里就会失败——否则「契约」只是装饰。
 * 测试服务器以 strict 模式运行，漂移会直接变成 500。
 * ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';
import {
  CommentCreateResponseSchema,
  CommentListResponseSchema,
  PostListResponseSchema,
  PostResponseSchema,
  SearchResponseSchema,
  SettingsResponseSchema
} from '../src/api/contract/posts.js';
import { ErrorResponseSchema, HealthResponseSchema, OkResponseSchema } from '../src/api/contract/common.js';
import type { ZodType } from 'zod';

let server: TestServer;
let token = '';
let postId = '';

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; data: unknown }> {
  const response = await fetch(server.baseUrl + path, init);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  // strict 模式下契约漂移会被替换成 500，这里直接把原因抛出来便于定位
  if (response.status === 500 && data && typeof data === 'object' && 'issues' in data) {
    throw new Error(`契约漂移：${path}\n${JSON.stringify(data, null, 2)}`);
  }
  return { status: response.status, data };
}

/** 断言响应体符合声明的 schema，失败时给出可读的字段路径。 */
function expectSchema(schema: ZodType, data: unknown): void {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  ');
    throw new Error(`响应不符合契约：\n  ${issues}\n实际值：${JSON.stringify(data).slice(0, 400)}`);
  }
}

const jsonAuth = (extra: Record<string, string> = {}): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  ...extra
});

beforeAll(async () => {
  server = await startTestServer();

  await call('/api/admin/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'Contract-Test-Password-1' })
  });

  const login = await call('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
    body: JSON.stringify({ password: 'Contract-Test-Password-1' })
  });
  token = (login.data as { token?: string }).token ?? '';

  postId = `contract-${Date.now().toString(36)}`;
});

afterAll(async () => {
  await server?.close();
});

describe('API 契约', () => {
  it('GET /healthz', async () => {
    const { status, data } = await call('/healthz');
    expect(status).toBe(200);
    expectSchema(HealthResponseSchema, data);
  });

  it('GET /api/settings', async () => {
    const { status, data } = await call('/api/settings');
    expect(status).toBe(200);
    expectSchema(SettingsResponseSchema, data);
  });

  it('POST /api/posts → 201，响应为 PostResponse', async () => {
    const { status, data } = await call('/api/posts', {
      method: 'POST',
      headers: jsonAuth(),
      body: JSON.stringify({
        id: postId,
        title: '契约测试文章',
        excerpt: '摘要',
        content: '# 正文\n\n契约测试内容。',
        tags: ['契约', '测试'],
        date: '2026-07-01T00:00:00.000Z',
        status: 'published'
      })
    });
    expect(status).toBe(201);
    expectSchema(PostResponseSchema, data);
  });

  it('GET /api/posts → 列表项为 PostSummary', async () => {
    const { status, data } = await call('/api/posts');
    expect(status).toBe(200);
    expectSchema(PostListResponseSchema, data);
    expect((data as { posts: Array<{ id: string }> }).posts.some((p) => p.id === postId)).toBe(true);
  });

  it('GET /api/posts/:id → 详情含正文', async () => {
    const { status, data } = await call(`/api/posts/${postId}`);
    expect(status).toBe(200);
    expectSchema(PostResponseSchema, data);
    const post = (data as { post: { content: string; id: string } }).post;
    expect(post.id).toBe(postId);
    expect(post.content).toContain('契约测试内容');
  });

  it('PUT /api/posts/:id → 更新成功且响应仍符合契约', async () => {
    const { status, data } = await call(`/api/posts/${postId}`, {
      method: 'PUT',
      headers: jsonAuth(),
      body: JSON.stringify({ title: '契约测试文章（已更新）', excerpt: '新摘要', status: 'published' })
    });
    expect(status).toBe(200);
    expectSchema(PostResponseSchema, data);
    expect((data as { post: { title: string } }).post.title).toBe('契约测试文章（已更新）');
  });

  it('POST /api/posts/:id/comments → 201（注意响应不含 post_id）', async () => {
    const { status, data } = await call(`/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: '契约测试', content: '一条评论' })
    });
    expect(status).toBe(201);
    expectSchema(CommentCreateResponseSchema, data);
    expect((data as { comment: { post_id?: unknown } }).comment.post_id).toBeUndefined();
  });

  it('GET /api/posts/:id/comments → 列表项含 post_id 与 rowid', async () => {
    const { status, data } = await call(`/api/posts/${postId}/comments`);
    expect(status).toBe(200);
    expectSchema(CommentListResponseSchema, data);
    const first = (data as { comments: Array<{ post_id: string }> }).comments[0];
    expect(first?.post_id).toBe(postId);
  });

  it('GET /api/search → 检索结果契约', async () => {
    const { status, data } = await call('/api/search?q=' + encodeURIComponent('契约测试'));
    expect(status).toBe(200);
    expectSchema(SearchResponseSchema, data);
  });

  it('DELETE /api/posts/:id → { ok: true }', async () => {
    const { status, data } = await call(`/api/posts/${postId}`, {
      method: 'DELETE',
      headers: jsonAuth()
    });
    expect(status).toBe(200);
    expectSchema(OkResponseSchema, data);
  });

  describe('错误响应也符合契约', () => {
    it('401 未授权', async () => {
      const { status, data } = await call('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'x', title: 'x' })
      });
      expect(status).toBe(401);
      expectSchema(ErrorResponseSchema, data);
    });

    it('400 参数校验失败（缺少 title）', async () => {
      const { status, data } = await call('/api/posts', {
        method: 'POST',
        headers: jsonAuth(),
        body: JSON.stringify({ id: 'no-title' })
      });
      expect(status).toBe(400);
      expectSchema(ErrorResponseSchema, data);
      expect((data as { error: string }).error).toContain('校验失败');
    });

    it('400 正文不是合法 JSON', async () => {
      const { status, data } = await call('/api/posts', {
        method: 'POST',
        headers: jsonAuth(),
        body: '{ 这不是 JSON'
      });
      expect(status).toBe(400);
      expectSchema(ErrorResponseSchema, data);
    });

    it('404 文章不存在', async () => {
      const { status, data } = await call('/api/posts/definitely-not-exists');
      expect(status).toBe(404);
      expectSchema(ErrorResponseSchema, data);
    });

    it('400 检索缺少关键词', async () => {
      const { status, data } = await call('/api/search');
      expect(status).toBe(400);
      expectSchema(ErrorResponseSchema, data);
    });

    it('405 方法不允许（上游返回 error 形状）', async () => {
      const { status, data } = await call('/api/search', { method: 'POST' });
      expect(status).toBe(405);
      expectSchema(ErrorResponseSchema, data);
    });
  });
});