#!/usr/bin/env node
/* ============================================================
 * SQLite → PostgreSQL 数据迁移
 * ------------------------------------------------------------
 * 仅拷贝数据，不改变正在运行的 SQLite 实例。
 *
 * 用法：
 *   DATABASE_URL=postgres://user:pass@host:5432/qingyu \
 *   node scripts/sqlite-to-postgres.mjs --sqlite ./data/qingyu.db
 *
 * 选项：
 *   --sqlite <path>     SQLite 文件，默认 data/qingyu.db
 *   --url <url>         PostgreSQL 连接串，默认 DATABASE_URL
 *   --schema <path>     PostgreSQL schema，默认 deploy/postgres/schema.sql
 *   --truncate          导入前清空目标业务表（危险，仅空库/测试用）
 *   --dry-run           只输出将迁移的数据量，不写入
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Client } = pg;

const args = process.argv.slice(2);
function option(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const sqlitePath = path.resolve(option('--sqlite', process.env.SQLITE_PATH || 'data/qingyu.db'));
const databaseUrl = option('--url', process.env.DATABASE_URL || '');
const schemaPath = path.resolve(option('--schema', 'deploy/postgres/schema.sql'));
const dryRun = args.includes('--dry-run');
const truncate = args.includes('--truncate');

if (!databaseUrl) {
  console.error('缺少 PostgreSQL 连接串：--url 或 DATABASE_URL');
  process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite 文件不存在：${sqlitePath}`);
  process.exit(1);
}

const TABLES = [
  'posts', 'comments', 'stats', 'admin_auth', 'admin_sessions', 'admin_fails',
  'site_files', 'site_settings', 'stats_daily', 'media', 'music', 'post_revisions',
  'backups', 'subscribers', 'mail_outbox', 'audit_log', 'stats_sources', 'error_logs',
  'webmentions', '_migrations', '_kv_store'
];

const BIGSERIAL_TABLES = ['post_revisions', 'mail_outbox', 'error_logs', 'webmentions'];

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqliteRows(db, table) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return [];
  const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    return out;
  });
}

const sqlite = new DatabaseSync(sqlitePath);
const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  console.log(`SQLite : ${sqlitePath}`);
  console.log(`Postgres: ${new URL(databaseUrl).host}${new URL(databaseUrl).pathname}`);
  console.log(`Schema : ${schemaPath}`);

  if (!dryRun) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('PostgreSQL schema 已应用');
  }

  let totalRows = 0;
  const summary = [];

  if (truncate && !dryRun) {
    const list = TABLES.map(quoteIdent).reverse().join(', ');
    await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    console.log('目标表已清空（--truncate）');
  }

  await client.query('BEGIN');
  try {
    for (const table of TABLES) {
      const rows = sqliteRows(sqlite, table);
      if (!rows.length) {
        summary.push([table, 0]);
        continue;
      }
      if (dryRun) {
        summary.push([table, rows.length]);
        totalRows += rows.length;
        continue;
      }

      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      for (const row of rows) {
        const values = columns.map((column) => row[column] === undefined ? null : row[column]);
        await client.query(sql, values);
      }
      summary.push([table, rows.length]);
      totalRows += rows.length;
    }

    if (!dryRun) {
      for (const table of BIGSERIAL_TABLES) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${quoteIdent(table)}`,
          [table]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  for (const [table, count] of summary) console.log(`  ${table.padEnd(20)} ${count}`);
  console.log(`${dryRun ? '预计迁移' : '已迁移'} ${totalRows} 行`);

  if (!dryRun) {
    let mismatch = 0;
    for (const [table, expected] of summary) {
      const result = await client.query(`SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)}`);
      const actual = result.rows[0]?.n ?? 0;
      if (actual < expected) {
        mismatch++;
        console.error(`[!] ${table}: SQLite ${expected} 行，PostgreSQL 只有 ${actual} 行`);
      }
    }
    if (mismatch) {
      console.error(`迁移校验失败：${mismatch} 张表行数不足`);
      process.exitCode = 1;
    } else {
      console.log('迁移完成，行数校验通过');
    }
  }
} finally {
  sqlite.close();
  await client.end();
}