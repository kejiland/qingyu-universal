/* ============================================================
 * 从数据库快照恢复
 * ------------------------------------------------------------
 * 用法：node dist/cli/restore.js <快照文件>
 * 安全措施：恢复前先把当前库另存为 qingyu-pre-restore-<时间>.db，
 * 恢复后清理 WAL/SHM 残留。请先停止服务再执行（避免写入竞争）。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';

const config = loadConfig();
const source = process.argv[2];
if (!source) {
  console.error('用法：node dist/cli/restore.js <快照文件.db>');
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`[restore] 找不到快照：${source}`);
  process.exit(1);
}

// 先验证快照本身是可用的 SQLite 文件
let postCount: number | bigint = 0;
const probe = new DatabaseSync(source, { readOnly: true });
try {
  const row = probe.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n?: number | bigint } | undefined;
  postCount = row?.n ?? 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[restore] 快照校验失败：${message}`);
  process.exit(1);
} finally {
  probe.close();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const preRestore = path.join(path.dirname(config.dbPath), `qingyu-pre-restore-${stamp}.db`);
if (fs.existsSync(config.dbPath)) {
  fs.copyFileSync(config.dbPath, preRestore);
  console.log(`[restore] 已备份当前数据库 → ${preRestore}`);
}
for (const suffix of ['-wal', '-shm']) {
  fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
}
fs.copyFileSync(source, config.dbPath);
console.log(`[restore] 已恢复 ${source} → ${config.dbPath}`);
console.log(`[restore] 快照内文章数：${postCount}`);
console.log('[restore] 现在可以重新启动服务：npm start');