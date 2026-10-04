/* ============================================================
 * KV 兼容层（SQLite 表实现）
 * ------------------------------------------------------------
 * 上游用 env.BLOG（Cloudflare KV）存放：限流计数、点赞去重标记、
 * 管理员密码哈希、AI 每日额度计数等「小对象 + TTL」数据。
 * 这里用同一 SQLite 文件里的一张 KV 表实现同款语义：
 *   get(key, type?) / put(key, value, {expirationTtl|expiration}) / delete(key)
 * 单机场景下比 KV 更强一致（KV 最终一致，这里强一致），限流更准确。
 * ============================================================ */

const DDL = 'CREATE TABLE IF NOT EXISTS _kv_store (' +
  'k TEXT PRIMARY KEY, ' +
  'v TEXT NOT NULL, ' +
  'expires_at INTEGER' +
  ')';

export class KVNamespace {
  constructor(db) {
    this.db = db;
    this.db.exec(DDL);
    this.statements = {
      get: db.prepare('SELECT v, expires_at FROM _kv_store WHERE k = ?'),
      put: db.prepare('INSERT INTO _kv_store (k, v, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at'),
      del: db.prepare('DELETE FROM _kv_store WHERE k = ?'),
      sweep: db.prepare('DELETE FROM _kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?')
    };
    this._lastSweep = 0;
  }

  _sweep() {
    const now = Date.now();
    if (now - this._lastSweep < 60000) return;
    this._lastSweep = now;
    try { this.statements.sweep.bind(now).run(); } catch (_) { /* 清理失败不影响读写 */ }
  }

  async get(key, options) {
    this._sweep();
    const row = this.statements.get.bind(String(key)).first();
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) <= Date.now()) {
      this.statements.del.bind(String(key)).run();
      return null;
    }
    const value = row.v;
    const type = typeof options === 'string' ? options : (options && options.type);
    if (type === 'json') { try { return JSON.parse(value); } catch (_) { return null; } }
    if (type === 'arrayBuffer') return new TextEncoder().encode(value).buffer;
    if (type === 'stream') return new Response(value).body;
    return value;
  }

  async put(key, value, options) {
    this._sweep();
    let stored;
    if (typeof value === 'string') stored = value;
    else if (value instanceof ArrayBuffer) stored = new TextDecoder().decode(value);
    else if (ArrayBuffer.isView(value)) stored = new TextDecoder().decode(value);
    else stored = JSON.stringify(value);
    let expiresAt = null;
    if (options && options.expirationTtl) {
      expiresAt = Date.now() + Number(options.expirationTtl) * 1000;
    } else if (options && options.expiration) {
      expiresAt = Number(options.expiration) * 1000;
    }
    this.statements.put.bind(String(key), stored, expiresAt).run();
  }

  async delete(key) {
    this.statements.del.bind(String(key)).run();
  }

  async list(options) {
    const prefix = (options && options.prefix) || '';
    const rows = this.db.prepare('SELECT k FROM _kv_store WHERE k LIKE ? ORDER BY k')
      .bind(prefix + '%').all().results;
    return { keys: rows.map((r) => ({ name: r.k })), list_complete: true, cursor: '' };
  }
}

export function createKV(db) {
  return new KVNamespace(db);
}