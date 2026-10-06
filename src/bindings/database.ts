import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../types.js';
import { createD1 } from './d1.js';
import { createPostgres } from './postgres.js';

/** 根据 DATABASE_URL 选择 SQLite 或 PostgreSQL。 */
export function createDatabase(config: AppConfig): AppDatabase {
  return config.databaseUrl ? createPostgres(config.databaseUrl) : createD1(config.dbPath);
}