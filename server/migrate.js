/* ============================================================
 * 迁移执行器
 * ------------------------------------------------------------
 * 按文件名顺序执行 app/migrations/*.sql，并把已执行的迁移记入
 * _migrations 表，重复运行安全（ALTER TABLE 类迁移不会被二次执行）。
 * 每个迁移在独立事务中执行：失败即整体回滚，不会留下半截结构。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

export function runMigrations(db, dir, logger) {
  const log = logger || function () {};
  db.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.raw.prepare('SELECT name FROM _migrations').all().map((row) => row.name)
  );

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const result = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file)) { result.skipped.push(file); continue; }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.raw.exec('BEGIN');
    try {
      db.raw.exec(sql);
      db.raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      db.raw.exec('COMMIT');
      result.applied.push(file);
      log('[migrate] 已应用 ' + file);
    } catch (error) {
      try { db.raw.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      // 与上游 deploy.yml 一致：SQLite 不支持 ADD COLUMN IF NOT EXISTS，
      // 「列已存在」视为该迁移已达成目的，记录为已应用并继续，而不是中断部署。
      if (/duplicate column name|already exists/i.test(error.message)) {
        db.raw.prepare('INSERT OR REPLACE INTO _migrations (name, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
        result.applied.push(file);
        log('[migrate] 已应用 ' + file + '（列/对象已存在，按幂等处理）');
        continue;
      }
      throw new Error('迁移 ' + file + ' 执行失败：' + error.message);
    }
  }
  return result;
}

/** 直接运行时：node server/migrate.js */
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href) {
  const { loadConfig, MIGRATIONS_DIR } = await import('./config.js');
  const { createD1 } = await import('./bindings/d1.js');
  const config = loadConfig();
  const db = createD1(config.dbPath);
  const result = runMigrations(db, MIGRATIONS_DIR, console.log);
  console.log('[migrate] 完成：新增 ' + result.applied.length + ' 个，已存在 ' + result.skipped.length + ' 个');
  console.log('[migrate] 数据库：' + config.dbPath);
  db.close();
}