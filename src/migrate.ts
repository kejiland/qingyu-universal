/* ============================================================
 * 迁移执行器
 * ------------------------------------------------------------
 * SQLite：按文件名顺序执行 app/migrations/*.sql。
 * PostgreSQL：应用 deploy/postgres/schema.sql，并写入 schema 版本标记。
 * 两种模式都重复执行安全。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import type { D1Database } from './bindings/d1.js';
import type { AppDatabase } from './types.js';

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export type MigrationLogger = (message: string) => void;

const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;
const POSTGRES_SCHEMA_MARKER = 'postgres/schema.sql';

async function runSqliteMigrations(db: D1Database, dir: string, log: MigrationLogger): Promise<MigrationReport> {
  db.native.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.native.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((row) => row.name)
  );
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const report: MigrationReport = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file)) {
      report.skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const foreignKeysOff = /^\s*--\s*@foreign-keys-off/m.test(sql.slice(0, 400));
    if (foreignKeysOff) {
      db.native.exec('PRAGMA foreign_keys = OFF');
      db.native.exec('PRAGMA legacy_alter_table = ON');
    }
    db.native.exec('BEGIN');
    try {
      db.native.exec(sql);
      db.native.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      db.native.exec('COMMIT');
      report.applied.push(file);
      log(`[migrate] 已应用 ${file}`);
    } catch (error) {
      try { db.native.exec('ROLLBACK'); } catch { /* ignore */ }
      const message = error instanceof Error ? error.message : String(error);
      if (BENIGN_MIGRATION_ERROR.test(message)) {
        db.native.prepare('INSERT OR REPLACE INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
        report.applied.push(file);
        log(`[migrate] 已应用 ${file}（对象已存在，按幂等处理）`);
        continue;
      }
      throw new Error(`迁移 ${file} 执行失败：${message}`);
    } finally {
      if (foreignKeysOff) {
        db.native.exec('PRAGMA legacy_alter_table = OFF');
        db.native.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
  return report;
}

/**
 * 等待 PostgreSQL 就绪。
 * compose 同时拉起 app 与 postgres 时，app 很可能先起来几秒 —— 这里重试而不是
 * 直接崩溃，用户不需要手动「再 up 一次」。只重试连接类错误：密码错、库名错这类
 * 配置问题重试多少次都一样，应该立刻抛出来让人看见。
 */
async function retryOnConnectionError<T>(task: () => Promise<T>, log: MigrationLogger): Promise<T> {
  const CONNECTION_ERROR = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|Connection terminated|Connection refused|timeout expired|the database system is starting up|starting up/i;
  let attempt = 0;
  for (;;) {
    try {
      return await task();
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 30 || !CONNECTION_ERROR.test(message)) throw error;
      if (attempt === 1 || attempt % 5 === 0) log(`[migrate] 数据库尚未就绪，等待中（${attempt}/30）：${message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function runPostgresMigrations(db: AppDatabase, schemaPath: string, log: MigrationLogger): Promise<MigrationReport> {
  await retryOnConnectionError(
    () => db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'),
    log
  );
  const existing = await db.first<{ name: string }>('SELECT name FROM _migrations WHERE name = ?', POSTGRES_SCHEMA_MARKER);

  if (!fs.existsSync(schemaPath)) throw new Error(`PostgreSQL schema 不存在：${schemaPath}`);
  /* [self-host] schema.sql 必须保持**幂等**（IF NOT EXISTS / CREATE OR REPLACE /
   * DROP TRIGGER IF EXISTS），每次启动都重跑一遍。
   * 否则老库永远拿不到首装之后新增的表、索引与数据回填 —— SQLite 端有
   * migrations 逐个追加，PG 端此前只在首装执行一次，两边会长期不一致。 */
  await db.exec(fs.readFileSync(schemaPath, 'utf8'));
  await db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING')
    .bind(POSTGRES_SCHEMA_MARKER, new Date().toISOString())
    .run();
  if (existing) return { applied: [], skipped: [POSTGRES_SCHEMA_MARKER] };
  log(`[migrate] 正在应用 ${POSTGRES_SCHEMA_MARKER}`);
  return { applied: [POSTGRES_SCHEMA_MARKER], skipped: [] };
}

export async function runMigrations(
  db: AppDatabase,
  dir: string,
  log: MigrationLogger = () => {},
  postgresSchemaPath = path.resolve('deploy/postgres/schema.sql')
): Promise<MigrationReport> {
  if (db.dialect === 'postgres') return runPostgresMigrations(db, postgresSchemaPath, log);
  return runSqliteMigrations(db as D1Database, dir, log);
}

/** 列出已应用的迁移名（运维/诊断用）。 */
export async function listAppliedMigrations(db: AppDatabase): Promise<string[]> {
  try {
    const rows = await db.all<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
    return rows.map((row) => row.name);
  } catch {
    return [];
  }
}