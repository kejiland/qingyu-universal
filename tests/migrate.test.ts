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