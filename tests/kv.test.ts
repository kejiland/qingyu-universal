import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createD1, type D1Database } from '../src/bindings/d1.js';
import { createKV } from '../src/bindings/kv.js';

let dir: string;
let db: D1Database;
let kv: ReturnType<typeof createKV>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-kv-'));
  db = createD1(path.join(dir, 'test.db'));
  kv = createKV(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('KV 兼容层', () => {
  it('put / get 字符串往返', async () => {
    await kv.put('greeting', '你好');
    expect(await kv.get('greeting')).toBe('你好');
  });

  it("get(key, 'json') 解析 JSON 值", async () => {
    await kv.put('counter', { n: 3, tags: ['a', 'b'] });
    expect(await kv.get('counter', 'json')).toEqual({ n: 3, tags: ['a', 'b'] });
  });

  it('不存在的键返回 null', async () => {
    expect(await kv.get('missing')).toBeNull();
  });

  it('delete 移除键', async () => {
    await kv.put('temp', 'x');
    await kv.delete('temp');
    expect(await kv.get('temp')).toBeNull();
  });

  it('expirationTtl 到期后不可读', async () => {
    await kv.put('stale', 'x', { expirationTtl: -1 });
    expect(await kv.get('stale')).toBeNull();
  });

  it('expiration 绝对时间戳到期后不可读', async () => {
    await kv.put('stale2', 'x', { expiration: Math.floor(Date.now() / 1000) - 10 });
    expect(await kv.get('stale2')).toBeNull();
  });

  it('覆盖写生效', async () => {
    await kv.put('k', 'first');
    await kv.put('k', 'second');
    expect(await kv.get('k')).toBe('second');
  });

  it('限流场景：计数递增可被读取', async () => {
    const key = 'rate:1.2.3.4';
    const current = Number((await kv.get(key)) ?? 0);
    await kv.put(key, String(current + 1), { expirationTtl: 60 });
    expect(await kv.get(key)).toBe('1');
  });
});