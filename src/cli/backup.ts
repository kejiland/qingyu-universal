/* ============================================================
 * 数据库快照备份（可在服务运行时执行）
 * ------------------------------------------------------------
 * 用 SQLite 的 VACUUM INTO 生成一致性快照，不需要停机，也不会与
 * 正在写入的服务冲突。产物：data/backups/qingyu-<时间>.db
 *
 * 与后台「站点备份」的区别：后台备份是业务级 JSON（可跨版本迁移、
 * 可选择性恢复），这里是整库快照（恢复最快、最完整）。
 *
 * 用法：node dist/cli/backup.js [输出目录]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { createD1 } from '../bindings/d1.js';

const config = loadConfig();
const outDir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let target = '';

if (config.databaseDialect === 'postgres') {
  target = path.join(outDir, `qingyu-${stamp}.dump`);
  const result = spawnSync('pg_dump', [`--dbname=${config.databaseUrl}`, '--format=custom', `--file=${target}`], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pg_dump 失败，退出码 ${result.status}`);
} else {
  target = path.join(outDir, `qingyu-${stamp}.db`);
  const db = createD1(config.dbPath);
  try {
    // VACUUM INTO 要求目标文件不存在
    db.native.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

const stat = fs.statSync(target);
const size = stat.size > 1_048_576 ? `${(stat.size / 1_048_576).toFixed(1)} MB` : `${(stat.size / 1024).toFixed(1)} KB`;
console.log(`[backup] 已生成快照 ${target}（${size}）`);

const keep = Number(process.env.BACKUP_KEEP || 30);
const files = fs
  .readdirSync(outDir)
  .filter((file) => file.startsWith('qingyu-') && (file.endsWith('.db') || file.endsWith('.dump')))
  .sort();
for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
  fs.rmSync(path.join(outDir, stale), { force: true });
  console.log(`[backup] 已清理旧快照 ${stale}`);
}