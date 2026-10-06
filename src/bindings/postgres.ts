/* ============================================================
 * PostgreSQL 数据库适配器
 * ------------------------------------------------------------
 * 上游业务代码使用 D1 prepared statement 契约；这里用 pg Pool 实现
 * 同一接口，并把少量 SQLite 方言翻译成 PostgreSQL 方言：
 *   ? 占位符 → $1/$2
 *   INSERT OR IGNORE → ON CONFLICT DO NOTHING
 *   INSERT OR REPLACE → ON CONFLICT (...) DO UPDATE
 *   rowid → seq（comments 等表由 PostgreSQL schema 提供 seq）
 *   instr() → strpos()
 * ============================================================ */
import pg from 'pg';
import type { AppDatabase, D1PreparedStatement, D1Result, WorkerEnv } from '../types.js';

const { Pool, types } = pg;
// PostgreSQL BIGINT 默认返回字符串；本项目的时间戳都在安全整数范围内。
types.setTypeParser(20, (value) => Number(value));

const CONFLICT_TARGETS: Record<string, string> = {
  _migrations: 'name',
  site_settings: 'k',
  admin_auth: 'k',
  stats: 'post_id',
  stats_daily: 'post_id,date',
  stats_sources: 'post_id,date,kind,name'
};

function parseTableColumns(sql: string): { table: string; columns: string[] } | null {
  const match = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([`"[\]]?[\w.]+[`"[\]]?)\s*\(([^)]+)\)\s+VALUES/i.exec(sql);
  if (!match) return null;
  const table = match[1].replace(/[`"[\]]/g, '');
  const columns = match[2].split(',').map((column) => column.trim().replace(/[`"[\]]/g, ''));
  return { table, columns };
}

function translateInsertOrReplace(sql: string): string {
  if (!/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) return sql;
  const parsed = parseTableColumns(sql);
  if (!parsed) throw new Error('无法解析 INSERT OR REPLACE：' + sql.slice(0, 120));
  const { table, columns } = parsed;
  const target = CONFLICT_TARGETS[table] || (columns.includes('id') ? 'id' : columns[0]);
  const targetColumns = target.split(',').map((column) => column.trim());
  const updates = columns.filter((column) => !targetColumns.includes(column));
  const conflict = updates.length
    ? ` ON CONFLICT (${target}) DO UPDATE SET ${updates.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`
    : ` ON CONFLICT (${target}) DO NOTHING`;
  return sql.replace(/^\s*INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO').replace(/\s*;?\s*$/, conflict);
}

function translateInsertOrIgnore(sql: string): string {
  if (!/\bINSERT\s+OR\s+IGNORE\b/i.test(sql)) return sql;
  const converted = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  return /\bON\s+CONFLICT\b/i.test(converted) ? converted : converted.replace(/\s*;?\s*$/, ' ON CONFLICT DO NOTHING');
}

/** 把未引用字符串中的 ? 转成 $1/$2；简单状态机足以覆盖当前所有 SQL。 */
function translatePlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let single = false;
  let double = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" && !double) {
      if (single && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      single = !single;
      out += ch;
      continue;
    }
    if (ch === '"' && !single) {
      if (double && sql[i + 1] === '"') {
        out += '""';
        i += 1;
        continue;
      }
      double = !double;
      out += ch;
      continue;
    }
    if (ch === '?' && !single && !double) {
      index += 1;
      out += `$${index}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export function translatePostgresSql(sql: string): string {
  let out = String(sql);
  out = translateInsertOrIgnore(out);
  out = translateInsertOrReplace(out);
  out = out.replace(/\browid\b/gi, 'seq');
  out = out.replace(/\binstr\s*\(/gi, 'strpos(');
  out = out.replace(/\bMAX\s*\(\s*1\s*,/gi, 'GREATEST(1,');
  out = out.replace(/\bMIN\s*\(\s*COALESCE\(likes\s*,\s*0\)\s*\+\s*1\s*,\s*999999\s*\)/gi, 'LEAST(COALESCE(likes,0)+1,999999)');
  out = out.replace(/\bMIN\s*\(\s*((?:\w+\.)?likes)\s*\+\s*1\s*,\s*9999999\s*\)/gi, 'LEAST($1+1,9999999)');
  out = out.replace(/\bMIN\s*\(\s*((?:\w+\.)?views)\s*\+\s*1\s*,\s*9999999\s*\)/gi, 'LEAST($1+1,9999999)');
  return translatePlaceholders(out);
}

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) => value === undefined ? null : value);
}

class PostgresStatement implements D1PreparedStatement {
  readonly sql: string;
  readonly params: unknown[];
  readonly #db: PostgresDatabase;

  constructor(db: PostgresDatabase, sql: string, params: unknown[]) {
    this.#db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new PostgresStatement(this.#db, this.sql, normalizeParams(values));
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.#db.query(this.sql, this.params);
    return { results: result.rows as T[], success: true, meta: { rows_read: result.rowCount ?? result.rows.length, changes: 0 } };
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const result = await this.#db.query(this.sql, this.params);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run(): Promise<D1Result> {
    const result = await this.#db.query(this.sql, this.params);
    return {
      results: [],
      success: true,
      meta: {
        changes: result.rowCount ?? 0,
        changed_db: (result.rowCount ?? 0) > 0
      }
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const result = await this.#db.query(this.sql, this.params);
    return result.rows.map((row) => Object.values(row) as unknown as T);
  }
}

export interface PostgresOptions {
  connectionString: string;
  max?: number;
}

export class PostgresDatabase implements AppDatabase {
  readonly dialect = 'postgres' as const;
  readonly location: string;
  readonly #pool: pg.Pool;

  constructor(options: PostgresOptions | string) {
    const connectionString = typeof options === 'string' ? options : options.connectionString;
    this.location = connectionString;
    this.#pool = new Pool({
      connectionString,
      max: typeof options === 'string' ? 10 : (options.max ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }

  prepare(sql: string): D1PreparedStatement {
    return new PostgresStatement(this, sql, []);
  }

  async query(sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
    return this.#pool.query(translatePostgresSql(sql), normalizeParams(params));
  }

  async exec(sql: string): Promise<void> {
    await this.#pool.query(sql);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.rows as T[];
  }

  async first<T = unknown>(sql: string, ...params: unknown[]): Promise<T | null> {
    const result = await this.query(sql, params);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async scalar<T = unknown>(sql: string, ...params: unknown[]): Promise<T | null> {
    const row = await this.first<Record<string, unknown>>(sql, ...params);
    if (!row) return null;
    return Object.values(row)[0] as T;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const client = await this.#pool.connect();
    const results: D1Result[] = [];
    try {
      await client.query('BEGIN');
      for (const statement of statements) {
        const internal = statement as unknown as PostgresStatement;
        const result = await client.query(translatePostgresSql(internal.sql), normalizeParams(internal.params));
        const isRead = /^\s*(SELECT|WITH|EXPLAIN)/i.test(internal.sql);
        results.push({
          results: isRead ? (result.rows as Record<string, unknown>[]) : [],
          success: true,
          meta: { changes: isRead ? 0 : (result.rowCount ?? 0), rows_read: isRead ? result.rows.length : 0, changed_db: !isRead && (result.rowCount ?? 0) > 0 }
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return results;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export function createPostgres(connectionString: string, max = 10): PostgresDatabase {
  return new PostgresDatabase({ connectionString, max });
}

/** 上游兼容：给 WorkerEnv 注入数据库方言，搜索逻辑据此选择 FTS / tsvector。 */
export function decorateWorkerEnv(env: WorkerEnv, dialect: 'sqlite' | 'postgres'): WorkerEnv {
  return { ...env, DB_DIALECT: dialect };
}
