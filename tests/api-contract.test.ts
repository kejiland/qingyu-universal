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
  PostRelationsResponseSchema,
  PostResponseSchema,
  PostStatsResponseSchema,
  SearchResponseSchema,
  SettingsResponseSchema
} from '../src/api/contract/posts.js';
import { ErrorResponseSchema, HealthResponseSchema, OkResponseSchema } from '../src/api/contract/common.js';
import {
  AuditLogResponseSchema,
  BackupCreateResponseSchema,
  BackupListResponseSchema,
  CommentAdminListResponseSchema,
  CommentBulkResponseSchema,
  ErrorLogResponseSchema,
  LoginResponseSchema,
  MediaListResponseSchema,
  MediaRegisterResponseSchema,
  MediaUploadTicketSchema,
  OgUploadResponseSchema,
  StatsSourcesResponseSchema,
  StatsTrendResponseSchema,
  SubscriberListResponseSchema,
  SubscriberUpdateResponseSchema,
  WebmentionListResponseSchema
} from '../src/api/contract/admin.js';
import type { ZodType } from 'zod';

let server: TestServer;
let token = '';
let postId = '';
let statsPostId = '';

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

  it('留言板评论（gb-note）不依赖 posts 表也能发表', async () => {
    const created = await call('/api/posts/gb-note/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: '留言板契约', content: '留言板评论' })
    });
    expect(created.status).toBe(201);
    expectSchema(CommentCreateResponseSchema, created.data);

    const listed = await call('/api/posts/gb-note/comments');
    expect(listed.status).toBe(200);
    expectSchema(CommentListResponseSchema, listed.data);
    const first = (listed.data as { comments: Array<{ post_id: string; content: string }> }).comments[0];
    expect(first?.post_id).toBe('gb-note');
    expect(first?.content).toBe('留言板评论');
  });

  it('向不存在的文章发评论返回 404，而不是外键 500', async () => {
    const { status, data } = await call('/api/posts/no-such-post/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: '测试', content: '不应写入' })
    });
    expect(status).toBe(404);
    expectSchema(ErrorResponseSchema, data);
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

/* ============================================================
 * 后台域契约：认证 / 媒体 / 评论管理 / 审计 / 日志 / 备份
 * ============================================================ */
describe('后台域 API 契约', () => {
  let mediaId = '';
  let commentId = '';

  it('POST /api/admin/login → LoginResponse', async () => {
    const { status, data } = await call('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
      body: JSON.stringify({ password: 'Contract-Test-Password-1' })
    });
    expect(status).toBe(200);
    expectSchema(LoginResponseSchema, data);
    expect((data as { token: string }).token.length).toBeGreaterThan(0);
  });

  it('GET /api/media → MediaListResponse', async () => {
    const { status, data } = await call('/api/media', { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(200);
    expectSchema(MediaListResponseSchema, data);
  });

  it('POST /api/media/upload-url → MediaUploadTicket', async () => {
    const { status, data } = await call('/api/media/upload-url', {
      method: 'POST',
      headers: jsonAuth(),
      body: JSON.stringify({ filename: 'contract.png', size: 512, makeThumb: true })
    });
    expect(status).toBe(200);
    expectSchema(MediaUploadTicketSchema, data);
    mediaId = (data as { key: string }).key;
  });

  it('POST /api/media → 登记元数据', async () => {
    const { status, data } = await call('/api/media', {
      method: 'POST',
      headers: jsonAuth(),
      body: JSON.stringify({
        name: 'contract.png',
        url: '/media/contract.png',
        type: 'image/png',
        size: 512
      })
    });
    expect(status).toBe(201);
    expectSchema(MediaRegisterResponseSchema, data);
    mediaId = (data as { media: { id: string } }).media.id;
  });

  it('DELETE /api/media/:id', async () => {
    const { status, data } = await call(`/api/media/${encodeURIComponent(mediaId)}`, {
      method: 'DELETE',
      headers: jsonAuth()
    });
    expect(status).toBe(200);
    expectSchema(OkResponseSchema, data);
  });

  it('GET /api/comments → 管理列表（带 post_title）', async () => {
    const { status, data } = await call('/api/comments?status=all', { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(200);
    expectSchema(CommentAdminListResponseSchema, data);

    const first = (data as { comments: Array<{ id: string; post_title?: string | null }> }).comments[0];
    if (first) commentId = first.id;
  });

  it('PUT /api/comments/:id → 审核通过', async () => {
    if (!commentId) return;
    const { status, data } = await call(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: 'PUT',
      headers: jsonAuth(),
      body: JSON.stringify({ status: 'approved' })
    });
    expect(status).toBe(200);
    expectSchema(OkResponseSchema, data);
  });

  it('POST /api/admin/comments/bulk → 批量操作', async () => {
    if (!commentId) return;
    const { status, data } = await call('/api/admin/comments/bulk', {
      method: 'POST',
      headers: jsonAuth(),
      body: JSON.stringify({ op: 'approve', ids: [commentId] })
    });
    expect(status).toBe(200);
    expectSchema(CommentBulkResponseSchema, data);
  });

  it('GET /api/admin/audit → 审计日志', async () => {
    const { status, data } = await call('/api/admin/audit?limit=20', { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(200);
    expectSchema(AuditLogResponseSchema, data);
  });

  it('GET /api/admin/errors → 错误日志', async () => {
    const { status, data } = await call('/api/admin/errors', { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(200);
    expectSchema(ErrorLogResponseSchema, data);
  });

  it('GET /api/admin/backups → 备份列表（本地磁盘模式亦可用）', async () => {
    const { status, data } = await call('/api/admin/backups', { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(200);
    expectSchema(BackupListResponseSchema, data);
    expect((data as { configured: boolean }).configured).toBe(true);
  });

  it('POST /api/admin/backups → 创建备份', async () => {
    const { status, data } = await call('/api/admin/backups', { method: 'POST', headers: jsonAuth() });
    expect(status).toBe(201);
    expectSchema(BackupCreateResponseSchema, data);
  });

  it('POST /api/admin/logout → 撤销会话', async () => {
    const { status, data } = await call('/api/admin/logout', { method: 'POST', headers: jsonAuth() });
    expect(status).toBe(200);
    expectSchema(OkResponseSchema, data);
  });

  it('媒体接口未授权时返回 401', async () => {
    const { status, data } = await call('/api/media');
    expect(status).toBe(401);
    expectSchema(ErrorResponseSchema, data);
  });
});

describe('订阅 / Webmention / 统计 契约', () => {
  // 前一个 describe 的最后一个用例登出了会话，这里重新登录
  beforeAll(async () => {
    const again = await call('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Key': server.setupKey },
      body: JSON.stringify({ password: 'Contract-Test-Password-1' })
    });
    token = (again.data as { token?: string }).token ?? '';

    // 关联阅读 / 单篇统计要一篇仍然存在的已发布文章（上面那篇在 DELETE 用例里已删掉）
    statsPostId = 'contract-stats-' + Date.now().toString(36);
    const created = await call('/api/posts', {
      method: 'POST',
      headers: jsonAuth(),
      body: JSON.stringify({
        id: statsPostId,
        title: '契约测试文章（统计与关联）',
        excerpt: '给关联阅读和阅读数接口用',
        content: '# 正文\n\n统计用例正文。',
        tags: ['契约', '统计'],
        series: '契约系列',
        date: '2026-07-02T00:00:00.000Z',
        status: 'published'
      })
    });
    expect(created.status).toBe(201);
  });
  it('GET /api/admin/subscribers → SubscriberListResponse', async () => {
    const { status, data } = await call('/api/admin/subscribers', { headers: jsonAuth() });
    expect(status).toBe(200);
    expectSchema(SubscriberListResponseSchema, data);
  });

  it('PUT /api/admin/subscribers/:id → SubscriberUpdateResponse', async () => {
    const { status, data } = await call('/api/admin/subscribers/nonexistent-id', {
      method: 'PUT',
      headers: { ...jsonAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: ['朋友', 'RSS'] })
    });
    expect(status).toBe(200);
    expectSchema(SubscriberUpdateResponseSchema, data);
  });
  it('GET /api/admin/webmentions → WebmentionListResponse', async () => {
    const { status, data } = await call('/api/admin/webmentions', { headers: jsonAuth() });
    expect(status).toBe(200);
    expectSchema(WebmentionListResponseSchema, data);
  });

  it('GET /api/stats/trend → StatsTrendResponse', async () => {
    const { status, data } = await call('/api/stats/trend', { headers: jsonAuth() });
    expect(status).toBe(200);
    expectSchema(StatsTrendResponseSchema, data);
  });

  it('GET /api/posts/:id/relations → PostRelationsResponse', async () => {
    const { status, data } = await call('/api/posts/' + encodeURIComponent(statsPostId) + '/relations');
    expect(status).toBe(200);
    expectSchema(PostRelationsResponseSchema, data);
    const body = data as { postId: string; related: unknown[]; backlinks: unknown[] };
    expect(body.postId).toBe(statsPostId);
    expect(Array.isArray(body.related)).toBe(true);
    expect(Array.isArray(body.backlinks)).toBe(true);
  });

  it('GET /api/posts/:id/stats → PostStatsResponse', async () => {
    const { status, data } = await call('/api/posts/' + encodeURIComponent(statsPostId) + '/stats');
    expect(status).toBe(200);
    expectSchema(PostStatsResponseSchema, data);
    expect((data as { postId: string }).postId).toBe(statsPostId);
  });

  it('POST /api/posts/:id/stats → 上报阅读数（重复上报幂等）', async () => {
    const { status, data } = await call('/api/posts/' + encodeURIComponent(statsPostId) + '/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'views' })
    });
    expect(status).toBe(200);
    expectSchema(PostStatsResponseSchema, data);
    expect(typeof (data as { stats: { views: number } }).stats.views).toBe('number');
  });

  it('POST /api/admin/og-upload-url → OgUploadResponse', async () => {
    const { status, data } = await call('/api/admin/og-upload-url', {
      method: 'POST',
      headers: { ...jsonAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: 'contract-og-test' })
    });
    expect(status).toBe(200);
    expectSchema(OgUploadResponseSchema, data);
    const body = data as { uploadUrl: string; publicUrl: string; expiresIn: number };
    expect(body.uploadUrl).toBeTruthy();
    expect(body.publicUrl).toBeTruthy();
    expect(body.expiresIn).toBeGreaterThan(0);
  });

  it('GET /api/admin/stats/sources → StatsSourcesResponse', async () => {
    const { status, data } = await call('/api/admin/stats/sources', { headers: jsonAuth() });
    expect(status).toBe(200);
    expectSchema(StatsSourcesResponseSchema, data);
  });

  it('订阅者接口未授权返回 401', async () => {
    const { status, data } = await call('/api/admin/subscribers');
    expect(status).toBe(401);
    expectSchema(ErrorResponseSchema, data);
  });
});
