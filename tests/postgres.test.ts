/* ============================================================
 * PostgreSQL 适配器测试
 * ------------------------------------------------------------
 * 前半部分是纯 SQL 翻译单测，任何环境都能跑；
 * 后半部分需要一个**可丢弃的空 PostgreSQL 库**，设置了
 * TEST_DATABASE_URL 才执行，没设就自动跳过，不影响 CI：
 *
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/qingyu_test npm test
 * ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgres, translatePostgresSql } from '../src/bindings/postgres.js';
import { runMigrations } from '../src/migrate.js';
import { KVNamespace } from '../src/bindings/kv.js';
import { MIGRATIONS_DIR, ROOT } from '../src/config.js';
import path from 'node:path';

describe('PostgreSQL SQL 翻译', () => {
  it('? 占位符按位置转成 $1/$2，字符串字面量里的 ? 不动', () => {
    expect(translatePostgresSql('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2'
    );
    expect(translatePostgresSql("SELECT '?' AS q WHERE a = ?")).toBe("SELECT '?' AS q WHERE a = $1");
    expect(translatePostgresSql('SELECT "col?umn" FROM t WHERE a = ?')).toBe('SELECT "col?umn" FROM t WHERE a = $1');
    expect(translatePostgresSql("SELECT 'it''s ?' WHERE a = ?")).toBe("SELECT 'it''s ?' WHERE a = $1");
  });

  it('INSERT OR IGNORE → ON CONFLICT DO NOTHING', () => {
    const sql = translatePostgresSql('INSERT OR IGNORE INTO stats (post_id) VALUES (?)');
    expect(sql).toContain('INSERT INTO stats');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('$1');
    expect(sql).not.toContain('OR IGNORE');
  });

  it('INSERT OR REPLACE → ON CONFLICT ... DO UPDATE（带列清单）', () => {
    const sql = translatePostgresSql('INSERT OR REPLACE INTO site_settings (k, v) VALUES (?, ?)');
    expect(sql).toContain('INSERT INTO site_settings');
    expect(sql).toContain('ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v');
  });

  it('INSERT OR REPLACE 用预置的复合冲突键', () => {
    const sql = translatePostgresSql('INSERT OR REPLACE INTO stats_daily (post_id, date, views) VALUES (?, ?, ?)');
    expect(sql).toContain('ON CONFLICT (post_id,date) DO UPDATE SET views = EXCLUDED.views');
  });

  it('SQLite 方言函数与表达式被替换', () => {
    expect(translatePostgresSql('SELECT instr(name, ?) FROM t')).toContain('strpos(name,');
    expect(translatePostgresSql('SELECT rowid FROM t')).toContain('SELECT seq FROM t');
    expect(translatePostgresSql('SELECT MAX(1, likes) FROM t')).toContain('GREATEST(1, likes)');
    expect(translatePostgresSql('SELECT MIN(likes + 1, 9999999) FROM t')).toMatch(/LEAST\(likes\s*\+\s*1,\s*9999999\)/);
  });
});

const TEST_URL = process.env.TEST_DATABASE_URL || '';

describe.skipIf(!TEST_URL)('PostgreSQL 真实数据库', () => {
  const db = createPostgres(TEST_URL, 4);
  const token = `pgtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const schemaPath = path.join(ROOT, 'deploy', 'postgres', 'schema.sql');
    // 测试库可能被反复使用：先抹掉版本标记，制造一次「全新安装」，
    // 这样既能验证 schema 真的会被应用，也能验证重复执行是幂等的。
    await db.prepare('DELETE FROM _migrations WHERE name = ?').bind('postgres/schema.sql').run().catch(() => undefined);

    const first = await runMigrations(db, MIGRATIONS_DIR, () => {}, schemaPath);
    expect(first.applied).toContain('postgres/schema.sql');

    const second = await runMigrations(db, MIGRATIONS_DIR, () => {}, schemaPath);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('postgres/schema.sql');

    // 关键表确实建好了
    const tables = await db.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = tables.map((row) => row.table_name);
    for (const table of ['posts', 'comments', 'site_settings', 'media', 'music', '_kv_store']) {
      expect(names, `表 ${table} 应存在`).toContain(table);
    }
  }, 60_000);

  afterAll(async () => {
    // 只清理本测试写入的数据，不动别人的库
    await db.prepare('DELETE FROM posts WHERE id LIKE ?').bind(`${token}%`).run().catch(() => undefined);
    await db.prepare('DELETE FROM stats WHERE post_id LIKE ?').bind(`${token}%`).run().catch(() => undefined);
    await db.prepare('DELETE FROM _kv_store WHERE k LIKE ?').bind(`${token}%`).run().catch(() => undefined);
    await db.close();
  });

  it('D1 契约：prepare/bind/run/first/all/scalar', async () => {
    const id = `${token}-post`;
    const insert = await db
      .prepare('INSERT INTO posts (id, title, content, status) VALUES (?, ?, ?, ?)')
      .bind(id, 'PostgreSQL 集成测试', '内容 content', 'published')
      .run();
    expect(insert.success).toBe(true);
    expect(insert.meta.changes).toBe(1);

    const row = await db.prepare('SELECT title, content FROM posts WHERE id = ?').bind(id).first<{ title: string }>();
    expect(row?.title).toBe('PostgreSQL 集成测试');

    const count = await db.scalar<number>('SELECT COUNT(*) FROM posts WHERE id = ?', id);
    expect(Number(count)).toBe(1);

    const rows = await db.all<{ id: string }>('SELECT id FROM posts WHERE id = ?', id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });

  it('INSERT OR IGNORE 在真实库上按「已存在则跳过」执行', async () => {
    // stats.post_id 有外键，先建文章再统计
    const postId = `${token}-stats`;
    await db.prepare('INSERT INTO posts (id, title, status) VALUES (?, ?, ?)').bind(postId, '统计测试', 'published').run();
    await db.prepare('INSERT INTO stats (post_id, views) VALUES (?, ?)').bind(postId, 1).run();
    const ignored = await db
      .prepare('INSERT OR IGNORE INTO stats (post_id, views) VALUES (?, ?)')
      .bind(postId, 999)
      .run();
    expect(ignored.meta.changes).toBe(0);
    const views = await db.scalar<number>('SELECT views FROM stats WHERE post_id = ?', postId);
    expect(Number(views)).toBe(1);
  });

  it('search_vector 全文检索可用', async () => {
    const id = `${token}-fts`;
    await db
      .prepare('INSERT INTO posts (id, title, content, status) VALUES (?, ?, ?, ?)')
      .bind(id, `${token} 关键词`, '全文检索应该能命中', 'published')
      .run();
    const hits = await db.all<{ id: string }>(
      "SELECT id FROM posts WHERE search_vector @@ to_tsquery('simple', ?)",
      `${token}:*`
    );
    expect(hits.map((row) => row.id)).toContain(id);
  });

  it('batch() 在事务里执行，出错整体回滚', async () => {
    const okId = `${token}-batch-ok`;
    const badId = `${token}-batch-bad`;
    const statements = [
      db.prepare('INSERT INTO posts (id, title, status) VALUES (?, ?, ?)').bind(okId, 'batch 正常', 'published'),
      // 重复主键 → 违反唯一约束，整批回滚
      db.prepare('INSERT INTO posts (id, title, status) VALUES (?, ?, ?)').bind(okId, 'batch 冲突', 'published')
    ];
    await expect(db.batch(statements)).rejects.toThrow();
    const row = await db.prepare('SELECT id FROM posts WHERE id = ?').bind(okId).first();
    expect(row).toBeNull();
    expect(badId).toContain(token);
  });

  it('KV 层：写入、读取、过期清理', async () => {
    const kv = new KVNamespace(db);
    await kv.put(`${token}-kv`, { hello: 'pg' }, { expirationTtl: 60 });
    expect(await kv.get(`${token}-kv`, 'json')).toEqual({ hello: 'pg' });

    await kv.put(`${token}-expired`, 'gone', { expirationTtl: 1 });
    // 直接把过期时间改到过去，不必真等一秒
    await db
      .prepare('UPDATE _kv_store SET expires_at = ? WHERE k = ?')
      .bind(Date.now() - 1000, `${token}-expired`)
      .run();
    expect(await kv.get(`${token}-expired`)).toBeNull();

    await kv.delete(`${token}-kv`);
    expect(await kv.get(`${token}-kv`)).toBeNull();
  });
});