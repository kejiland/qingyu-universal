/* 应用数据库迁移：node dist/cli/migrate.js */
import { loadConfig } from '../config.js';
import { createD1 } from '../bindings/d1.js';
import { runMigrations } from '../migrate.js';
import { logger, bridgeConsole } from '../logger.js';

bridgeConsole(logger);

const config = loadConfig();
const db = createD1(config.dbPath);
try {
  const report = runMigrations(db, config.migrationsDir, (message) => logger.info(message));
  logger.info(`[migrate] 完成：新增 ${report.applied.length} 个，已存在 ${report.skipped.length} 个`);
  logger.info(`[migrate] 数据库：${config.dbPath}`);
} finally {
  db.close();
}