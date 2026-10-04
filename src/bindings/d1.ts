/* ============================================================
 * D1 兼容层（node:sqlite）
 * ------------------------------------------------------------
 * 上游业务代码全部通过 Cloudflare D1 的 PreparedStatement API 访问数据库：
 *   db.prepare(sql).bind(...).all() / .first() / .run() / db.batch([...])
 * 这里用 Node 内置的 node:sqlite 实现同一契约，因此 app/ 下的业务逻辑
 * 无需改动即可读写本地 SQLite（含 FTS5 trigram 全文索引）。
 *
 * 为什么不用 better-sqlite3 / Drizzle：
 *   node:sqlite 是一方 API，随 Node 升级维护，且无需原生编译（Alpine 镜像
 *   里少一层 build-base/python）。上游 214 处调用全是裸 SQL，ORM 在这里
 *   带不来收益——真正的约束是「必须兼容 D1 的语句对象契约」。
 * ============================================================ */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from '../types.js';

/** D1 只接受 null / number / string / bigint / ArrayBuffer / ArrayBufferView。 */
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toPlainRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row as Record<string, unknown>)) {
    out[key] = (row as Record<string, unknown>)[key];
  }
  return out;
}

interface InternalStatement {
  sql: string;
  params?: unknown[];
}

interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

class PreparedStatement implements D1PreparedStatement {
  readonly sql: string;
  readonly #db: D1Database;
  readonly params: unknown[];
  #statement: StatementSync | null = null;

  constructor(db: D1Database, sql: string, params: unknown[]) {
    this.#db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new PreparedStatement(this.#db, this.sql, values.map(normalize));
  }

  #stmt(): StatementSync {
    if (!this.#statement) this.#statement = this.#db.statement(this.sql);
    return this.#statement;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.#stmt().all(...(this.params as never[])).map(toPlainRow) as T[];
    return { results: rows, success: true, meta: { rows_read: rows.length, changes: 0 } };
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.#stmt().get(...(this.params as never[]));
    if (row === undefined) return null;
    const plain = toPlainRow(row);
    if (column) return (plain[column] ?? null) as T;
    return plain as T;
  }

  async run(): Promise<D1Result> {
    const result = this.#stmt().run(...(this.params as never[])) as unknown as RunResult;
    const changes = Number(result.changes ?? 0);
    return {
      results: [],
      success: true,
      meta: {
        changes,
        last_row_id: Number(result.lastInsertRowid ?? 0),
        changed_db: changes > 0
      }
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.#stmt().all(...(this.params as never[]));
    return rows.map((row) => Object.values(toPlainRow(row)) as unknown as T);
  }
}

export interface D1Options {
  /** SQLite page cache（KB），默认交给 SQLite 自行决定。 */
  cacheSizeKb?: number;
}

export class D1Database implements D1DatabaseLike {
  readonly path: string;
  /** 暴露原生句柄：迁移、快照、健康检查等运维路径需要。 */
  readonly native: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();

  constructor(filePath: string, options: D1Options = {}) {
    this.path = filePath;
    this.native = new DatabaseSync(filePath);

    // WAL + NORMAL：并发读不阻塞写、崩溃安全，单机博客的最优默认组合。
    this.native.exec('PRAGMA journal_mode = WAL');
    this.native.exec('PRAGMA synchronous = NORMAL');
    this.native.exec('PRAGMA foreign_keys = ON');
    this.native.exec('PRAGMA busy_timeout = 5000');
    this.native.exec('PRAGMA temp_store = MEMORY');
    if (options.cacheSizeKb) this.native.exec(`PRAGMA cache_size = -${Math.trunc(options.cacheSizeKb)}`);
  }

  /** 预编译语句缓存：同一 SQL 只编译一次。 */
  statement(sql: string): StatementSync {
    let statement = this.#cache.get(sql);
    if (!statement) {
      statement = this.native.prepare(sql);
      if (this.#cache.size > 400) this.#cache.clear();
      this.#cache.set(sql, statement);
    }
    return statement;
  }

  prepare(sql: string): D1PreparedStatement {
    return new PreparedStatement(this, sql, []);
  }

  /** D1 batch：单个隐式事务，全部成功或全部回滚。 */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const list = Array.from(statements ?? []);
    if (list.length === 0) return [];

    const results: D1Result[] = [];
    const isRead = (sql: string): boolean => /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(sql);

    this.native.exec('BEGIN');
    try {
      for (const statement of list) {
        const internal = statement as unknown as InternalStatement;
        const params = (internal.params ?? []) as never[];
        const sql = internal.sql;
        const prepared = this.statement(sql);

        if (isRead(sql)) {
          const rows = prepared.all(...params).map(toPlainRow);
          results.push({ results: rows, success: true, meta: { rows_read: rows.length, changes: 0 } });
        } else {
          const raw = prepared.run(...params) as unknown as RunResult;
          const changes = Number(raw.changes ?? 0);
          results.push({
            results: [],
            success: true,
            meta: { changes, last_row_id: Number(raw.lastInsertRowid ?? 0), changed_db: changes > 0 }
          });
        }
      }
      this.native.exec('COMMIT');
    } catch (error) {
      try {
        this.native.exec('ROLLBACK');
      } catch {
        /* 回滚失败时抛出原始错误，避免掩盖根因 */
      }
      throw error;
    }
    return results;
  }

  /** 多语句脚本执行（迁移用）。 */
  exec(sql: string): { count: number; duration: number } {
    this.native.exec(sql);
    return { count: 1, duration: 0 };
  }

  /** 只读查询助手（运维脚本 / 健康检查用，不经过 D1 契约）。 */
  scalar<T = number>(sql: string, ...params: unknown[]): T | null {
    const row = this.native.prepare(sql).get(...(params.map(normalize) as never[]));
    if (!row) return null;
    const values = Object.values(toPlainRow(row));
    return (values[0] ?? null) as T | null;
  }

  close(): void {
    this.#cache.clear();
    this.native.close();
  }
}

export function createD1(filePath: string, options?: D1Options): D1Database {
  return new D1Database(filePath, options);
}