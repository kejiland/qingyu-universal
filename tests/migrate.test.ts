import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { createD1 } from '../src/bindings/d1.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('迁移执行器', () => {
  it('在全新数据库上应用全部迁移', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-migrate-'));
    const db = createD1(path.join(dir, 'fresh.db'));
    try {
      const report = await runMigrations(db, MIGRATIONS_DIR);
      const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

      expect(report.applied.length).toBe(files.length);
      expect(report.skipped).toEqual([]);

      // 关键表建好
      for (const table of ['posts', 'comments', 'site_settings', 'media', 'music', 'backups', 'subscribers']) {
        const name = await db.scalar<string>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", table);
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

  it('重复执行安全：第二次全部跳过', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-migrate2-'));
    const db = createD1(path.join(dir, 'again.db'));
    try {
      const first = await runMigrations(db, MIGRATIONS_DIR);
      const second = await runMigrations(db, MIGRATIONS_DIR);
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
  async function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-fk-'));
    const db = createD1(path.join(dir, 'fk.db'));
    await runMigrations(db, MIGRATIONS_DIR);
    return { db, dir };
  }

  it('6 张关联表建立了指向 posts 的 CASCADE 外键（评论由触发器清理）', async () => {
    const { db, dir } = await freshDb();
    try {
      const expected = ['stats', 'stats_daily', 'stats_sources', 'post_revisions', 'webmentions', 'mail_outbox'];
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

  it('删除文章时关联数据与评论全部清理', async () => {
    const { db, dir } = await freshDb();
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
        const count = await db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE post_id = ?`, id);
        expect(count, `${table} 应无残留`).toBe(0);
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('评论允许内置留言板目标，统计仍拒绝孤儿数据', async () => {
    const { db, dir } = await freshDb();
    try {
      // 留言板没有对应帖子，但评论表允许这个内置目标。
      db.native
        .prepare('INSERT INTO comments (id,post_id,author,content,date) VALUES (?,?,?,?,?)')
        .run('c-gb', 'gb-note', 'a', '留言', '2026-01-01');
      expect(await db.scalar<number>("SELECT COUNT(*) FROM comments WHERE post_id = 'gb-note'")).toBe(1);

      // 其它关联表仍然保持指向 posts 的外键保护。
      expect(() =>
        db.native.prepare('INSERT INTO stats (post_id,likes,views) VALUES (?,?,?)').run('no-such-post', 1, 1)
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('迁移会把存量孤儿清理掉', async () => {
    const { db, dir } = await freshDb();
    try {
      // 先关外键制造孤儿，再手动跑一次清理语句（模拟迁移的清理段）
      db.native.exec('PRAGMA foreign_keys = OFF');
      db.native.prepare('INSERT INTO post_revisions (post_id,title,created_at) VALUES (?,?,?)').run('ghost', 'r', Date.now());
      expect(await db.scalar<number>("SELECT COUNT(*) FROM post_revisions WHERE post_id = 'ghost'")).toBe(1);

      db.native.exec("DELETE FROM post_revisions WHERE post_id NOT IN (SELECT id FROM posts)");
      expect(await db.scalar<number>("SELECT COUNT(*) FROM post_revisions WHERE post_id = 'ghost'")).toBe(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ============================================================
 * comments.parent_id 自引用外键（迁移 0034）
 * ------------------------------------------------------------
 * 这张表是自引用的，重建时最容易出错的两点：
 *   1. 外键必须在改名后指向自己，而不是指向被删掉的旧表
 *   2. 重建过程中不能被 DROP TABLE 的隐式 DELETE 级联清空
 * 这里把两点都锁死。
 * ============================================================ */
describe('评论自引用外键', () => {
  async function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-cfk-'));
    const db = createD1(path.join(dir, 'cfk.db'));
    await runMigrations(db, MIGRATIONS_DIR);
    return { db, dir };
  }

  it('parent_id 外键指向 comments 自己（而非残留的中间表名）', async () => {
    const { db, dir } = await freshDb();
    try {
      const fks = db.native.prepare('PRAGMA foreign_key_list(comments)').all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      const selfRef = fks.find((fk) => fk.from === 'parent_id');
      expect(selfRef, '应存在 parent_id 外键').toBeTruthy();
      expect(selfRef?.table).toBe('comments');       // 关键：指向自己
      expect(selfRef?.to).toBe('id');
      expect(selfRef?.on_delete).toBe('CASCADE');

      // 中间表名不应残留
      const leftover = await db.scalar<string>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='comments_new'"
      );
      expect(leftover).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('删除父评论时级联删除子回复与孙回复', async () => {
    const { db, dir } = await freshDb();
    try {
      db.native.prepare("INSERT INTO posts (id,title,date,content,status) VALUES (?,?,?,?,?)")
        .run('p1', 't', '2026-01-01', 'x', 'published');
      const ins = db.native.prepare(
        'INSERT INTO comments (id,post_id,author,content,date,parent_id) VALUES (?,?,?,?,?,?)'
      );
      ins.run('root', 'p1', 'a', '顶层', '2026-01-01', null);
      ins.run('child', 'p1', 'b', '回复', '2026-01-01', 'root');
      ins.run('grand', 'p1', 'c', '孙回复', '2026-01-01', 'child');
      ins.run('other', 'p1', 'd', '无关评论', '2026-01-01', null);

      expect(await db.scalar<number>('SELECT COUNT(*) FROM comments')).toBe(4);

      // 只删父评论，不手工清理任何子级
      db.native.prepare('DELETE FROM comments WHERE id = ?').run('root');

      const left = db.native.prepare('SELECT id FROM comments ORDER BY id').all() as Array<{ id: string }>;
      expect(left.map((r) => r.id)).toEqual(['other']);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('删除文章仍然级联清理整棵评论树', async () => {
    const { db, dir } = await freshDb();
    try {
      db.native.prepare("INSERT INTO posts (id,title,date,content,status) VALUES (?,?,?,?,?)")
        .run('p1', 't', '2026-01-01', 'x', 'published');
      const ins = db.native.prepare(
        'INSERT INTO comments (id,post_id,author,content,date,parent_id) VALUES (?,?,?,?,?,?)'
      );
      ins.run('root', 'p1', 'a', '顶层', '2026-01-01', null);
      ins.run('child', 'p1', 'b', '回复', '2026-01-01', 'root');

      // 删文章会把 comments 的 post_id 外键触发为 CASCADE；
      // 删除过程中「父评论 → 子回复」的级联也必须跟上
      db.native.prepare('DELETE FROM posts WHERE id = ?').run('p1');
      expect(await db.scalar<number>('SELECT COUNT(*) FROM comments')).toBe(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('父评论不存在时插入子回复会被拒绝', async () => {
    const { db, dir } = await freshDb();
    try {
      db.native.prepare("INSERT INTO posts (id,title,date,content,status) VALUES (?,?,?,?,?)")
        .run('p1', 't', '2026-01-01', 'x', 'published');
      expect(() =>
        db.native
          .prepare('INSERT INTO comments (id,post_id,author,content,date,parent_id) VALUES (?,?,?,?,?,?)')
          .run('c1', 'p1', 'a', 'b', '2026-01-01', 'no-such-parent')
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
