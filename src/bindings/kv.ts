/* ============================================================
 * KV 兼容层（SQLite 表实现）
 * ------------------------------------------------------------
 * 上游用 env.BLOG（Cloudflare KV）存放：限流计数、点赞去重标记、
 * 管理员密码哈希、AI 每日额度计数等「小对象 + TTL」数据。
 * 这里用同一 SQLite 文件里的一张 KV 表实现同款语义，单机场景下比
 * 云端 KV 更强一致（KV 最终一致，这里强一致），限流因此更准确。
 * ============================================================ */
import type { D1Database } from './d1.js';
import { Redis } from 'ioredis';
import type { KVGetOptions, KVNamespaceLike } from '../types.js';

const DDL = [
  'CREATE TABLE IF NOT EXISTS _kv_store (',
  '  k TEXT PRIMARY KEY,',
  '  v TEXT NOT NULL,',
  '  expires_at INTEGER',
  ')'
].join('\n');

const SWEEP_INTERVAL_MS = 60_000;

export class KVNamespace implements KVNamespaceLike {
  readonly #db: D1Database;
  #lastSweep = 0;

  constructor(db: D1Database) {
    this.#db = db;
    this.#db.exec(DDL);
  }

  /** 惰性清理过期键：以 60 秒为节流，避免每次读写都全表扫描。 */
  #sweep(): void {
    const now = Date.now();
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    try {
      this.#db.native
        .prepare('DELETE FROM _kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?')
        .run(now);
    } catch {
      /* 清理失败不影响正常读写 */
    }
  }

  async get(key: string, options?: KVGetOptions | KVGetOptions['type']): Promise<unknown> {
    this.#sweep();
    const row = this.#db.native
      .prepare('SELECT v, expires_at FROM _kv_store WHERE k = ?')
      .get(String(key)) as { v?: string; expires_at?: number } | undefined;

    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) <= Date.now()) {
      await this.delete(String(key));
      return null;
    }

    const value = row.v ?? '';
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

  async put(key: string, value: unknown, options?: { expiration?: number; expirationTtl?: number }): Promise<void> {
    this.#sweep();

    let stored: string;
    if (typeof value === 'string') stored = value;
    else if (value instanceof ArrayBuffer) stored = new TextDecoder().decode(value);
    else if (ArrayBuffer.isView(value)) {
      stored = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    }
    else stored = JSON.stringify(value);

    let expiresAt: number | null = null;
    if (options?.expirationTtl) expiresAt = Date.now() + Number(options.expirationTtl) * 1000;
    else if (options?.expiration) expiresAt = Number(options.expiration) * 1000;

    this.#db.native
      .prepare(
        'INSERT INTO _kv_store (k, v, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at'
      )
      .run(String(key), stored, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.#db.native.prepare('DELETE FROM _kv_store WHERE k = ?').run(String(key));
  }

  /** 运维用：列出键（上游未使用，保留以便排查）。 */
  async list(prefix = ''): Promise<string[]> {
    const rows = this.#db.native
      .prepare('SELECT k FROM _kv_store WHERE k LIKE ? ORDER BY k')
      .all(`${prefix}%`) as Array<{ k: string }>;
    return rows.map((row) => row.k);
  }
}

function decodeRedisValue(value: string | null, options?: KVGetOptions | KVGetOptions['type']): unknown {
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
      /* 连接失败由调用侧回退到 SQLite；这里吞掉事件避免进程崩溃。 */
    });
  }

  isAvailable(): boolean {
    return Date.now() >= this.#deadUntil;
  }

  markDead(): void {
    this.#deadUntil = Date.now() + 30_000;
  }

  async get(key: string, options?: KVGetOptions | KVGetOptions['type']): Promise<unknown> {
    return decodeRedisValue(await this.#client.get(String(key)), options);
  }

  async put(key: string, value: unknown, options?: { expiration?: number; expirationTtl?: number }): Promise<void> {
    let stored: string;
    if (typeof value === 'string') stored = value;
    else if (value instanceof ArrayBuffer) stored = new TextDecoder().decode(value);
    else if (ArrayBuffer.isView(value)) stored = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    else stored = JSON.stringify(value);

    const k = String(key);
    if (options?.expirationTtl) await this.#client.set(k, stored, 'EX', Number(options.expirationTtl));
    else if (options?.expiration) await this.#client.set(k, stored, 'PXAT', Number(options.expiration) * 1000);
    else await this.#client.set(k, stored);
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(String(key));
  }

  async close(): Promise<void> {
    await this.#client.quit().catch(() => this.#client.disconnect());
  }
}

/**
 * 默认使用 SQLite KV；配置 REDIS_URL 后优先走 Redis/Valkey。
 * Redis 短暂不可用时回退到本地 KV，避免限流/会话功能直接把站点打挂。
 */
export function createKV(db: D1Database, redisUrl = ''): KVNamespaceLike {
  const local = new KVNamespace(db);
  if (!redisUrl) return local;
  const redis = new RedisKVNamespace(redisUrl);

  return {
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