/* 回归: 写路径必须落 created_at / updated_at，且 PUT 推进 updated_at 保留 created_at */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server.js';

let server: TestServer;
let token = '';
let db: any;

async function json(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(server.baseUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }
  });
  const t = await r.text();
  try { return { status: r.status, body: t ? JSON.parse(t) : null }; } catch { return { status: r.status, body: t }; }
}

beforeAll(async () => {
  server = await startTestServer();
  db = (server as any).db;
  await json('/api/admin/setup', { method: 'POST', headers: { 'X-Setup-Key': server.setupKey }, body: JSON.stringify({ password: 'Ts-Test-Pw-123' }) });
  const login = await json('/api/admin/login', { method: 'POST', headers: { 'X-Setup-Key': server.setupKey }, body: JSON.stringify({ password: 'Ts-Test-Pw-123' }) });
  token = login.body?.token ?? '';
});

afterAll(async () => { await server?.close(); });

describe('posts.created_at / updated_at 写入路径', () => {
  it('POST /api/posts 落上两个时间戳', async () => {
    const before = new Date().toISOString();
    const res = await json('/api/posts', { method: 'POST', body: JSON.stringify({ id: 'ts-post-1', title: '时间戳测试', content: 'body' }) });
    expect(res.status).toBe(201);
    const row = await db.first('SELECT created_at, updated_at FROM posts WHERE id = ?', 'ts-post-1');
    expect(row.created_at).not.toBe('');
    expect(row.updated_at).not.toBe('');
    expect(row.created_at >= before.slice(0, 19)).toBe(true);
  });

  it('PUT /api/posts/:id 推进 updated_at 且保留 created_at', async () => {
    const before = await db.first('SELECT created_at, updated_at FROM posts WHERE id = ?', 'ts-post-1');
    await new Promise((r) => setTimeout(r, 1100));
    const res = await json('/api/posts/ts-post-1', { method: 'PUT', body: JSON.stringify({ title: '时间戳测试·改', content: 'body2' }) });
    expect(res.status).toBe(200);
    const after = await db.first('SELECT created_at, updated_at FROM posts WHERE id = ?', 'ts-post-1');
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at >= after.updated_at).toBe(true);
    expect(after.updated_at).not.toBe(before.updated_at);
  });

  it('旧数据的空时间戳由 0039 迁移回填成 date', async () => {
    await db.prepare("INSERT INTO posts (id, title, date, created_at, updated_at, status) VALUES (?, ?, ?, '', '', 'published')").bind('ts-old-1', '老文章', '2025-01-01').run();
    const { runMigrations } = await import('../src/migrate.js');
    const { MIGRATIONS_DIR } = await import('../src/config.js');
    // 0039 在服务器首次启动时已应用过；抹掉记录再跑一次，验证该迁移对老数据确实生效
    await db.prepare("DELETE FROM _migrations WHERE name = '0039_posts_timestamps.sql'").run();
    const report = await runMigrations(db, MIGRATIONS_DIR);
    expect(report.applied).toContain('0039_posts_timestamps.sql');
    const row = await db.first('SELECT created_at, updated_at FROM posts WHERE id = ?', 'ts-old-1');
    expect(row.created_at).toBe('2025-01-01');
    expect(row.updated_at).toBe('2025-01-01');
  });
});
