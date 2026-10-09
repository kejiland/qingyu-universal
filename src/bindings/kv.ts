/* ============================================================
 * KV 兼容层（SQLite 表 / PostgreSQL 表 / Redis）
 * ------------------------------------------------------------
 * 上游用 env.BLOG（Cloudflare KV）存放：限流计数、点赞去重标记、
 * 管理员密码哈希、AI 每日额度计数等「小对象 + TTL」数据。
 * ============================================================ */
import { Redis } from 'ioredis';
import type { AppDatabase, KVGetOptions, KVNamespaceLike } from '../types.js';

const DDL = [
  'CREATE TABLE IF NOT EXISTS _kv_store (',
  '  k TEXT PRIMARY KEY,',
  '  v TEXT NOT NULL,',
  '  expires_at BIGINT',
  ')'
].join('\n');

const SWEEP_INTERVAL_MS = 60_000;

function decodeValue(value: string | null, options?: KVGetOptions | KVGetOptions['type']): unknown {
  if (value === null) return null;
  const type = typeof options === 'string' ? options : options?.type;
  switch (type) {
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    case 'arrayBuffer':
      return new TextEncoder().encode(value).buffer;
    case 'stream':
      return new Response(value).body;
    default:
      return value;
  }
}

function encodeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  return JSON.stringify(value);
}

function expiryOf(options?: { expiration?: number; expirationTtl?: number }): number | null {
  if (options?.expirationTtl) return Date.now() + Number(options.expirationTtl) * 1000;
  if (options?.expiration) return Number(options.expiration) * 1000;
  return null;
}

export class KVNamespace implements KVNamespaceLike {
  readonly #db: AppDatabase;
  /** 惰性建表：构造时不能发起连接，否则 PostgreSQL 还没起来就会变成未处理的 Promise 拒绝。 */
  #ready: Promise<void> | null = null;
  #lastSweep = 0;

  constructor(db: AppDatabase) {
    this.#db = db;
  }

  /** 首次使用时建表；失败会清掉缓存，下次调用重试（数据库稍后就绪时自愈）。 */
  async #ensureReady(): Promise<void> {
    if (!this.#ready) {
      this.#ready = this.#db.exec(DDL).catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    }
    return this.#ready;
  }

  async #sweep(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    await this.#db.prepare('DELETE FROM _kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run().catch(() => {});
  }

  async get(key: string, options?: KVGetOptions | KVGetOptions['type']): Promise<unknown> {
    await this.#ensureReady();
    await this.#sweep();
    const row = await this.#db.first<{ v?: string; expires_at?: number }>('SELECT v, expires_at FROM _kv_store WHERE k = ?', String(key));
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) <= Date.now()) {
      await this.delete(String(key));
      return null;
    }
    return decodeValue(row.v ?? '', options);
  }

  async put(key: string, value: unknown, options?: { expiration?: number; expirationTtl?: number }): Promise<void> {
    await this.#ensureReady();
    await this.#sweep();
    const stored = encodeValue(value);
    const expiresAt = expiryOf(options);
    await this.#db
      .prepare(
        'INSERT INTO _kv_store (k, v, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at'
      )
      .bind(String(key), stored, expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.#ensureReady();
    await this.#db.prepare('DELETE FROM _kv_store WHERE k = ?').bind(String(key)).run();
  }

  async list(prefix = ''): Promise<string[]> {
    await this.#ensureReady();
    const rows = await this.#db.all<{ k: string }>('SELECT k FROM _kv_store WHERE k LIKE ? ORDER BY k', `${prefix}%`);
    return rows.map((row) => row.k);
  }
}

class RedisKVNamespace implements KVNamespaceLike {
  readonly #client: Redis;
  #deadUntil = 0;

  constructor(url: string) {
    this.#client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 250, 3000)
    });
    this.#client.on('error', () => {
      /* 连接失败由调用侧回退 SQLite/PostgreSQL KV。 */
    });
  }

  isAvailable(): boolean {
    return Date.now() >= this.#deadUntil;
  }

  markDead(): void {
    this.#deadUntil = Date.now() + 30_000;
  }

  async get(key: string, options?: KVGetOptions | KVGetOptions['type']): Promise<unknown> {
    return decodeValue(await this.#client.get(String(key)), options);
  }

  async put(key: string, value: unknown, options?: { expiration?: number; expirationTtl?: number }): Promise<void> {
    const stored = encodeValue(value);
    const k = String(key);
    if (options?.expirationTtl) await this.#client.set(k, stored, 'EX', Number(options.expirationTtl));
    else if (options?.expiration) await this.#client.set(k, stored, 'PXAT', Number(options.expiration) * 1000);
    else await this.#client.set(k, stored);
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(String(key));
  }

  /** 与 SQLite 版行为一致：返回匹配前缀的键名（升序）。
   *  用 SCAN 分批而不是 KEYS —— KEYS 在大库上会阻塞整个 Redis 实例。 */
  async list(prefix = ''): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.#client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return out.sort();
  }
}

export function createKV(db: AppDatabase, redisUrl = ''): KVNamespaceLike {
  const local = new KVNamespace(db);
  if (!redisUrl) return local;
  const redis = new RedisKVNamespace(redisUrl);

  /* 合成实现必须覆盖 KVNamespaceLike 的全部方法：此前只转发了 get/put/delete，
   * 漏了 list() —— 上游一旦调用 env.BLOG.list() 就会 TypeError。 */
  return {
    async list(prefix) {
      if (redis.isAvailable()) {
        try {
          return await redis.list(prefix ?? '');
        } catch {
          redis.markDead();
        }
      }
      return local.list(prefix ?? '');
    },
    async get(key, options) {
      if (redis.isAvailable()) {
        try {
          return await redis.get(key, options);
        } catch {
          redis.markDead();
        }
      }
      return local.get(key, options);
    },
    async put(key, value, options) {
      if (redis.isAvailable()) {
        try {
          await redis.put(key, value, options);
          return;
        } catch {
          redis.markDead();
        }
      }
      await local.put(key, value, options);
    },
    async delete(key) {
      if (redis.isAvailable()) {
        try {
          await redis.delete(key);
          return;
        } catch {
          redis.markDead();
        }
      }
      await local.delete(key);
    }
  };
}