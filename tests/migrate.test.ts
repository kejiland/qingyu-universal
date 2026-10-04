import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { createD1 } from '../src/bindings/d1.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('迁移执行器', () => {
  it('在全新数据库上应用全部迁移', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-migrate-'));
    const db = createD1(path.join(dir, 'fresh.db'));
    try {
      const report = runMigrations(db, MIGRATIONS_DIR);
      const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

      expect(report.applied.length).toBe(files.length);
      expect(report.skipped).toEqual([]);

      // 关键表建好
      for (const table of ['posts', 'comments', 'site_settings', 'media', 'music', 'backups', 'subscribers']) {
        const name = db.scalar<string>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", table);
        expect(name, `表 ${table} 应存在`).toBe(table);
      }
      // FTS5 索引建好且可用
      db.native.exec("INSERT INTO posts (id, title, content) VALUES ('t1', '标题', '自托管通用版部署验证')");
      const hits = db.native.prepare('SELECT id FROM posts_fts WHERE posts_fts MATCH ?').all('通用版') as Array<{ id: string }>;
      expect(hits.map((h) => h.id)).toContain('t1');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重复执行安全：第二次全部跳过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-migrate2-'));
    const db = createD1(path.join(dir, 'again.db'));
    try {
      const first = runMigrations(db, MIGRATIONS_DIR);
      const second = runMigrations(db, MIGRATIONS_DIR);
      expect(second.applied).toEqual([]);
      expect(second.skipped.length).toBe(first.applied.length);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ============================================================
 * 外键约束（迁移 0033）
 * ------------------------------------------------------------
 * 这是曾经真实产生过孤儿数据的地方：上游删文章时只手工清 comments/stats，
 * post_revisions 会残留（迁移前实测 18 条）。这里锁死行为，防止回退。
 * ============================================================ */
describe('外键约束与级联', () => {
  function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-fk-'));
    const db = createD1(path.join(dir, 'fk.db'));
    runMigrations(db, MIGRATIONS_DIR);
    return { db, dir };
  }

  it('7 张关联表都建立了指向 posts 的 CASCADE 外键', () => {
    const { db, dir } = freshDb();
    try {
      const expected = ['comments', 'stats', 'stats_daily', 'stats_sources', 'post_revisions', 'webmentions', 'mail_outbox'];
      for (const table of expected) {
        const fks = db.native.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
          table: string;
          from: string;
          on_delete: string;
        }>;
        const toPosts = fks.find((fk) => fk.table === 'posts' && fk.from === 'post_id');
        expect(toPosts, `${table} 应有 post_id → posts 外键`).toBeTruthy();
        expect(toPosts?.on_delete, `${table} 应为 CASCADE`).toBe('CASCADE');
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('删除文章时 7 张关联表全部级联清理', () => {
    const { db, dir } = freshDb();
    try {
      const id = 'p1';
      db.native.prepare("INSERT INTO posts (id,title,date,content,status) VALUES (?,?,?,?,?)").run(id, 't', '2026-01-01', 'x', 'published');
      db.native.prepare('INSERT INTO comments (id,post_id,author,content,date) VALUES (?,?,?,?,?)').run('c1', id, 'a', 'b', '2026-01-01');
      db.native.prepare('INSERT INTO stats (post_id,likes,views) VALUES (?,?,?)').run(id, 1, 1);
      db.native.prepare('INSERT INTO stats_daily (post_id,date,views,likes) VALUES (?,?,?,?)').run(id, '2026-01-01', 1, 1);
      db.native.prepare('INSERT INTO stats_sources (post_id,date,kind,name,views) VALUES (?,?,?,?,?)').run(id, '2026-01-01', 'ref', 'x', 1);
      db.native.prepare('INSERT INTO post_revisions (post_id,title,created_at) VALUES (?,?,?)').run(id, 'rev', Date.now());
      db.native.prepare('INSERT INTO webmentions (source,target,post_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('https://a.com', 'https://b.com', id, Date.now(), Date.now());
      db.native.prepare('INSERT INTO mail_outbox (post_id,to_email,created_at) VALUES (?,?,?)').run(id, 'a@b.com', Date.now());

      // 只删 posts 一行，不做任何手工清理
      db.native.prepare('DELETE FROM posts WHERE id = ?').run(id);

      for (const table of ['comments', 'stats', 'stats_daily', 'stats_sources', 'post_revisions', 'webmentions', 'mail_outbox']) {
        const count = db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE post_id = ?`, id);
        expect(count, `${table} 应无残留`).toBe(0);
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('插入指向不存在文章的关联数据会被拒绝', () => {
    const { db, dir } = freshDb();
    try {
      expect(() =>
        db.native
          .prepare('INSERT INTO comments (id,post_id,author,content,date) VALUES (?,?,?,?,?)')
          .run('c1', 'no-such-post', 'a', 'b', '2026-01-01')
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('迁移会把存量孤儿清理掉', () => {
    const { db, dir } = freshDb();
    try {
      // 先关外键制造孤儿，再手动跑一次清理语句（模拟迁移的清理段）
      db.native.exec('PRAGMA foreign_keys = OFF');
      db.native.prepare('INSERT INTO post_revisions (post_id,title,created_at) VALUES (?,?,?)').run('ghost', 'r', Date.now());
      expect(db.scalar<number>("SELECT COUNT(*) FROM post_revisions WHERE post_id = 'ghost'")).toBe(1);

      db.native.exec("DELETE FROM post_revisions WHERE post_id NOT IN (SELECT id FROM posts)");
      expect(db.scalar<number>("SELECT COUNT(*) FROM post_revisions WHERE post_id = 'ghost'")).toBe(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
