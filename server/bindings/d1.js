/* ============================================================
 * D1 兼容层（node:sqlite）
 * ------------------------------------------------------------
 * 上游应用全部通过 Cloudflare D1 的 PreparedStatement API 访问数据库：
 *   db.prepare(sql).bind(...).all() / .first() / .run() / db.batch([...])
 * 这里用 Node 内置的 node:sqlite（Node >= 22.5，24 起稳定）实现同款接口，
 * 因此 app/ 下的业务代码无需任何改动即可读写本地 SQLite 文件。
 * D1 本身就是 SQLite，SQL 方言天然一致（含 FTS5 / trigram 全文索引）。
 * ============================================================ */
import { DatabaseSync } from 'node:sqlite';

/** D1 只接受 null / number / string / bigint / ArrayBuffer / ArrayBufferView。
 *  JS 的 undefined / boolean 需归一化，否则 node:sqlite 会直接抛参数类型错误。 */
function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** node:sqlite 返回的行可能是 null 原型对象；转成普通对象，
 *  避免 JSON.stringify / Object.keys 等在上游代码中出现意外行为差异。 */
function toPlainRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of Object.keys(row)) out[key] = row[key];
  return out;
}

class PreparedStatement {
  constructor(database, sql, params) {
    this.sql = sql;
    this._db = database;
    this._params = params || [];
    this._stmt = null;
  }

  bind(...params) {
    return new PreparedStatement(this._db, this.sql, params.map(normalize));
  }

  _statement() {
    if (!this._stmt) this._stmt = this._db.cache(this.sql);
    return this._stmt;
  }

  all() {
    const rows = this._statement().all(...this._params).map(toPlainRow);
    return { results: rows, success: true, meta: { rows_read: rows.length, changes: 0 } };
  }

  /** D1 的 first() 支持传入列名取单列；上游只用无参形式，这里两种都兼容。 */
  first(column) {
    const row = this._statement().get(...this._params);
    if (row === undefined) return null;
    if (column) {
      const plain = toPlainRow(row);
      return plain[column] === undefined ? null : plain[column];
    }
    return toPlainRow(row);
  }

  run() {
    const result = this._statement().run(...this._params);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0),
        changed_db: Number(result.changes || 0) > 0
      }
    };
  }

  /** 返回二维数组（D1 的 raw 语义），供潜在的高级用法使用。 */
  raw() {
    const rows = this._statement().all(...this._params);
    return rows.map((row) => Object.values(toPlainRow(row)));
  }
}

export class D1Database {
  constructor(filePath, options) {
    const opts = options || {};
    this.path = filePath;
    this.raw = new DatabaseSync(filePath);
    this._cache = new Map();

    // WAL + 合理的同步级别：并发读不阻塞、崩溃安全性好、单机博客的最优默认。
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA temp_store = MEMORY');
    if (opts.cacheSizeKb) this.raw.exec('PRAGMA cache_size = -' + Number(opts.cacheSizeKb));
  }

  /** 预编译语句缓存：同一 SQL 只编译一次。 */
  cache(sql) {
    let stmt = this._cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      if (this._cache.size > 400) this._cache.clear();
      this._cache.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql) {
    return new PreparedStatement(this, sql, []);
  }

  /** D1 batch：一个隐式事务，全部成功或全部回滚。 */
  batch(statements) {
    const list = Array.from(statements || []);
    if (!list.length) return [];
    const results = [];
    this.raw.exec('BEGIN');
    try {
      for (const statement of list) {
        const params = (statement._params || []).map(normalize);
        const stmt = this.cache(statement.sql);
        const isRead = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(statement.sql);
        if (isRead) {
          const rows = stmt.all(...params).map(toPlainRow);
          results.push({ results: rows, success: true, meta: { rows_read: rows.length, changes: 0 } });
        } else {
          const result = stmt.run(...params);
          results.push({
            success: true,
            results: [],
            meta: {
              changes: Number(result.changes || 0),
              last_row_id: Number(result.lastInsertRowid || 0),
              changed_db: Number(result.changes || 0) > 0
            }
          });
        }
      }
      this.raw.exec('COMMIT');
    } catch (error) {
      try { this.raw.exec('ROLLBACK'); } catch (_) { /* 忽略回滚异常，抛出原始错误 */ }
      throw error;
    }
    return results;
  }

  /** 多语句脚本执行（迁移用）。 */
  exec(sql) {
    this.raw.exec(sql);
    return { count: 1, duration: 0 };
  }

  close() {
    this._cache.clear();
    this.raw.close();
  }
}

export function createD1(filePath, options) {
  return new D1Database(filePath, options);
}