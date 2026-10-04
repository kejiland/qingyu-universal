/* ============================================================
 * 迁移执行器
 * ------------------------------------------------------------
 * 按文件名顺序执行 app/migrations/*.sql，并把已执行的迁移记入
 * _migrations 表，重复运行安全（ALTER TABLE 类迁移不会被二次执行）。
 * 每个迁移在独立事务中执行：失败即整体回滚，不会留下半截结构。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import type { D1Database } from './bindings/d1.js';

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export type MigrationLogger = (message: string) => void;

/** 与上游 deploy.yml 一致的「幂等」判定：SQLite 不支持 ADD COLUMN IF NOT EXISTS。 */
const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;

export function runMigrations(db: D1Database, dir: string, log: MigrationLogger = () => {}): MigrationReport {
  db.native.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

  const applied = new Set(
    (db.native.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((row) => row.name)
  );

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const report: MigrationReport = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file)) {
      report.skipped.push(file);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.native.exec('BEGIN');
    try {
      db.native.exec(sql);
      db.native
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      db.native.exec('COMMIT');
      report.applied.push(file);
      log(`[migrate] 已应用 ${file}`);
    } catch (error) {
      try {
        db.native.exec('ROLLBACK');
      } catch {
        /* 回滚失败时抛出原始错误 */
      }

      const message = error instanceof Error ? error.message : String(error);
      if (BENIGN_MIGRATION_ERROR.test(message)) {
        db.native
          .prepare('INSERT OR REPLACE INTO _migrations (name, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
        report.applied.push(file);
        log(`[migrate] 已应用 ${file}（对象已存在，按幂等处理）`);
        continue;
      }
      throw new Error(`迁移 ${file} 执行失败：${message}`);
    }
  }

  return report;
}

/** 列出已应用的迁移名（运维/诊断用）。 */
export function listAppliedMigrations(db: D1Database): string[] {
  try {
    return (db.native.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>).map(
      (row) => row.name
    );
  } catch {
    return [];
  }
}