/* 应用数据库迁移：node dist/cli/migrate.js */
import { loadConfig } from '../config.js';
import { createDatabase } from '../bindings/database.js';
import { runMigrations } from '../migrate.js';
import { logger, bridgeConsole } from '../logger.js';

bridgeConsole(logger);

const config = loadConfig();
const db = createDatabase(config);
try {
  const report = await runMigrations(db, config.migrationsDir, (message) => logger.info(message), `${config.root}/deploy/postgres/schema.sql`);
  logger.info(`[migrate] 完成：新增 ${report.applied.length} 个，已存在 ${report.skipped.length} 个`);
  logger.info(`[migrate] 数据库：${config.databaseDialect === 'postgres' ? 'PostgreSQL' : config.dbPath}`);
} finally {
  db.close();
}
