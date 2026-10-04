#!/usr/bin/env node
/* ============================================================
 * 数据库快照备份（离线安全，可在服务运行时执行）
 * ------------------------------------------------------------
 * 用 SQLite 的 VACUUM INTO 生成一致性快照，不需要停机，也不会
 * 与正在写入的服务冲突。产物：data/backups/qingyu-<时间>.db
 *
 * 与后台「站点备份」的区别：后台备份是业务级 JSON（可跨版本迁移、
 * 可选择性恢复），这里是整库快照（恢复最快、最完整）。
 *
 * 用法：node scripts/backup.js [输出目录]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createD1 } from '../server/bindings/d1.js';

const config = loadConfig();
const outDir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, 'qingyu-' + stamp + '.db');

const db = createD1(config.dbPath);
try {
  // 注意：VACUUM INTO 的目标文件必须不存在
  db.raw.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
} finally {
  db.close();
}

const stat = fs.statSync(target);
const size = stat.size > 1048576 ? (stat.size / 1048576).toFixed(1) + ' MB' : (stat.size / 1024).toFixed(1) + ' KB';
console.log('[backup] 已生成快照 ' + target + '（' + size + '）');

// 保留策略：默认最多 30 份，与后台备份一致
const keep = Number(process.env.BACKUP_KEEP || 30);
const files = fs.readdirSync(outDir).filter((f) => f.startsWith('qingyu-') && f.endsWith('.db')).sort();
for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
  fs.rmSync(path.join(outDir, stale), { force: true });
  console.log('[backup] 已清理旧快照 ' + stale);
}