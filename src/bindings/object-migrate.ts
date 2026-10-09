/* ============================================================
 * 本地磁盘对象 → 对象存储 迁移
 * ------------------------------------------------------------
 * 用途：部署初期文件落在本机磁盘，后来配上了 S3/R2，把已有文件搬上云，
 *       并把库里那些 `/media/x.png` 之类的相对地址改写成云上的外链地址。
 *
 * 两个安全设计：
 *   1. **按对象逐个改写**：只有确认某个 key 已经传上桶，才会改写引用它的行；
 *      不用「一把全改」，避免出现「库里指向云、云上没这个文件」的坏引用。
 *   2. **默认不删本地文件**：迁移后本地仍有副本，桶一旦不可达还能兜底；
 *      想彻底搬走再显式传 deleteLocal。
 *
 * 成功后 /media/* 本地路由仍然保留（见 app.ts 的常驻挂载），所以即使
 * 只迁移了一部分，没迁移到的老文件也照常可访问，不存在中间态 404 窗口。
 * ============================================================ */
import fsp from 'node:fs/promises';
import { deleteObject, listLocalObjects, putObject, type LocalObject } from './object-ops.js';
import { storageRuntime } from './storage-config.js';
import type { AppDatabase, WorkerEnv } from '../types.js';

export interface MigrateOptions {
  /** 迁移完成后删除本地文件（默认 false，保留副本更安全） */
  deleteLocal?: boolean;
  /** 单次最多处理多少个对象（防止一个大站把请求拖到超时） */
  limit?: number;
}

export interface MigrateDetail {
  key: string;
  status: 'migrated' | 'skipped' | 'failed';
  bytes?: number;
  error?: string;
}

export interface MigrateReport {
  ok: boolean;
  /** 本地磁盘上待迁移的对象总数（含本次未处理的） */
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  /** 被改写的数据库行数 */
  rewroteRows: number;
  deletedLocal: number;
  details: MigrateDetail[];
  error?: string;
}

const DEFAULT_LIMIT = 500;

/** 表 → 需要改写的列（顺序与 SQL 里的列名一致） */
const REWRITE_TABLES: Array<{ table: string; columns: string[] }> = [
  { table: 'media', columns: ['url', 'thumb_url'] },
  { table: 'music', columns: ['url', 'cover'] },
  { table: 'posts', columns: ['cover', 'og_image'] }
];

/** 判断某个本地相对地址该改写成什么；不该改写时返回 null */
function rewriteValue(value: unknown, bases: { media: string; music: string; og: string }, uploaded: Set<string>): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const key = value.slice(1);
  if (!uploaded.has(key)) return null;
  const prefix = key.split('/')[0];
  const base = prefix === 'music' ? bases.music : prefix === 'og' ? bases.og : bases.media;
  if (!base) return null;
  return base + value;
}

async function rewriteDatabase(
  db: AppDatabase,
  bases: { media: string; music: string; og: string },
  uploaded: Set<string>
): Promise<number> {
  let changed = 0;
  for (const { table, columns } of REWRITE_TABLES) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await db.all<Record<string, unknown>>(`SELECT id, ${columns.join(',')} FROM ${table}`);
    } catch {
      continue; // 表不存在（迁移未跑到）时跳过，不影响整体
    }
    const stmts: Array<{ sql: string; params: unknown[] }> = [];
    for (const row of rows) {
      const updates: Array<[string, string]> = [];
      for (const column of columns) {
        const next = rewriteValue(row[column], bases, uploaded);
        if (next !== null) updates.push([column, next]);
      }
      if (!updates.length) continue;
      // 逐列改写：同一行的 url 与 thumb_url 可能一个命中一个不命中
      for (const [column, next] of updates) {
        stmts.push({
          sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
          params: [next, String(row.id)]
        });
      }
      changed += 1;
    }
    // 分批提交，避免一次性塞入过多语句
    for (let i = 0; i < stmts.length; i += 200) {
      const chunk = stmts.slice(i, i + 200);
      await db.batch(chunk.map((s) => db.prepare(s.sql).bind(...s.params)));
    }
  }
  return changed;
}

async function removeLocal(object: LocalObject): Promise<boolean> {
  try {
    await fsp.rm(object.filePath, { force: true });
    await fsp.rm(`${object.filePath}.meta`, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行迁移。任何单个对象失败都不会中断整体 —— 逐个记录到 details 里，
 * 现场可读、可重跑（已迁成功的对象再跑一次只是重复覆盖，幂等）。
 */
export async function migrateLocalObjects(
  db: AppDatabase,
  env: WorkerEnv,
  appDir: string,
  options: MigrateOptions = {}
): Promise<MigrateReport> {
  const snap = storageRuntime.snapshot();
  const { mediaBucket, musicBucket } = snap.config;

  if (snap.useLocalUpload) {
    return {
      ok: false,
      total: 0, migrated: 0, skipped: 0, failed: 0, rewroteRows: 0, deletedLocal: 0, details: [],
      error: snap.degraded
        ? '已选择对象存储但配置不完整（至少需要端点、Access Key、Secret、媒体桶与媒体公开域名）'
        : '当前使用本机磁盘存储，无需迁移'
    };
  }

  const all = await listLocalObjects(snap.uploadDir);
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const targets = all.slice(0, limit);

  const details: MigrateDetail[] = [];
  const uploaded = new Set<string>();
  let migrated = 0;
  let failed = 0;

  for (const object of targets) {
    const bucket = object.key.startsWith('music/') ? (musicBucket || mediaBucket) : mediaBucket;
    if (!bucket) {
      details.push({ key: object.key, status: 'failed', bytes: object.bytes, error: '未配置对应桶名' });
      failed += 1;
      continue;
    }
    try {
      const body = await fsp.readFile(object.filePath);
      await putObject(appDir, env, object.key, new Uint8Array(body), object.contentType, bucket);
      uploaded.add(object.key);
      migrated += 1;
      details.push({ key: object.key, status: 'migrated', bytes: object.bytes });
    } catch (e) {
      failed += 1;
      details.push({ key: object.key, status: 'failed', bytes: object.bytes, error: (e as Error)?.message || String(e) });
    }
  }

  // 超出 limit 的对象明确标为 skipped，避免界面看起来「还剩一堆却不知道」
  const rest = all.slice(limit);
  for (const object of rest) details.push({ key: object.key, status: 'skipped', bytes: object.bytes });

  const mediaBase = snap.config.mediaPublicBase;
  const rewroteRows = uploaded.size
    ? await rewriteDatabase(
        db,
        {
          media: mediaBase,
          // 音乐域名留空时上游会回退到媒体域名，这里保持同样的回退逻辑
          music: snap.config.musicPublicBase || mediaBase,
          og: mediaBase
        },
        uploaded
      )
    : 0;

  let deletedLocal = 0;
  if (options.deleteLocal && uploaded.size) {
    for (const object of targets) {
      if (!uploaded.has(object.key)) continue;
      if (await removeLocal(object)) deletedLocal += 1;
    }
  }

  return {
    ok: failed === 0,
    total: all.length,
    migrated,
    skipped: rest.length,
    failed,
    rewroteRows,
    deletedLocal,
    details
  };
}

/** 供后台「存储」页做清理用：删掉云上一个对象（不删本地） */
export async function deleteRemoteObject(appDir: string, env: WorkerEnv, key: string): Promise<boolean> {
  const snap = storageRuntime.snapshot();
  const bucket = key.startsWith('music/') ? (snap.config.musicBucket || snap.config.mediaBucket) : snap.config.mediaBucket;
  if (!bucket) return false;
  return deleteObject(appDir, env, key, bucket);
}
