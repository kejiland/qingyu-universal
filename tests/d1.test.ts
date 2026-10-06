import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createD1, type D1Database } from '../src/bindings/d1.js';

let dir: string;
let db: D1Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-d1-'));
  db = createD1(path.join(dir, 'test.db'));
  db.native.exec('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, flag INTEGER, note TEXT)');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('D1 兼容层', () => {
  it('insert / all / first 往返一致', async () => {
    await db.prepare('INSERT INTO items (id, name, flag) VALUES (?, ?, ?)').bind('a', '甲', 1).run();

    const all = await db.prepare('SELECT id, name, flag FROM items').all<{ id: string; name: string; flag: number }>();
    expect(all.success).toBe(true);
    expect(all.results).toEqual([{ id: 'a', name: '甲', flag: 1 }]);
    expect(all.meta.rows_read).toBe(1);

    const first = await db.prepare('SELECT name FROM items WHERE id = ?').bind('a').first<{ name: string }>();
    expect(first?.name).toBe('甲');
  });

  it('first() 无结果返回 null，支持取单列', async () => {
    expect(await db.prepare('SELECT * FROM items WHERE id = ?').bind('nope').first()).toBeNull();
    await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('b', '乙').run();
    expect(await db.prepare('SELECT name FROM items WHERE id = ?').bind('b').first<string>('name')).toBe('乙');
  });

  it('run() 返回 D1 形状的 meta', async () => {
    const result = await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('c', '丙').run();
    expect(result.success).toBe(true);
    expect(result.meta.changes).toBe(1);
    expect(result.meta.last_row_id).toBeGreaterThan(0);
  });

  it('undefined 归一化为 NULL、boolean 归一化为 0/1', async () => {
    await db.prepare('INSERT INTO items (id, name, flag, note) VALUES (?, ?, ?, ?)').bind('d', '丁', true, undefined).run();
    const row = await db.prepare('SELECT flag, note FROM items WHERE id = ?').bind('d').first<{ flag: number; note: null }>();
    expect(row?.flag).toBe(1);
    expect(row?.note).toBeNull();
  });

  it('bind() 返回新语句，不污染原语句', async () => {
    const statement = db.prepare('SELECT name FROM items WHERE id = ?');
    await statement.bind('e1').run().catch(() => undefined);
    await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('e1', '戊一').run();
    await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('e2', '戊二').run();
    expect(await statement.bind('e1').first<string>('name')).toBe('戊一');
    expect(await statement.bind('e2').first<string>('name')).toBe('戊二');
  });

  it('batch() 在单个事务中提交', async () => {
    await db.batch([
      db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('f1', '己一'),
      db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('f2', '己二')
    ]);
    const count = await db.scalar<number>('SELECT COUNT(*) FROM items');
    expect(count).toBe(2);
  });

  it('batch() 出错时整体回滚', async () => {
    await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('g1', '庚一').run();
    await expect(
      db.batch([
        db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('g2', '庚二'),
        db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind('g1', '主键冲突') // 违反 PRIMARY KEY
      ])
    ).rejects.toThrow();
    const count = await db.scalar<number>('SELECT COUNT(*) FROM items');
    expect(count).toBe(1);
  });

  it('支持 FTS5 trigram（中文子串搜索）', async () => {
    db.native.exec("CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='trigram')");
    db.native.exec("INSERT INTO fts (body) VALUES ('自托管通用版本地部署验证')");
    const rows = db.native.prepare("SELECT body FROM fts WHERE fts MATCH ?").all('通用版') as Array<{ body: string }>;
    expect(rows).toHaveLength(1);
  });
});