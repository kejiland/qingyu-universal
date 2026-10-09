/* ============================================================
 * 对象存储操作（服务端侧）
 * ------------------------------------------------------------
 * 不重写签名逻辑：直接复用上游 app/functions/_lib/music.js 里的
 * presignPut / presignGet / r2DeleteObject —— 与浏览器直传走同一套 SigV4，
 * 避免出现「网页传得上去、服务端迁移传不上去」这种两套实现漂移。
 *
 * 跨语言复用手法与 src/api/audit.ts 一致：tsconfig 是 allowJs:false，
 * 因此用 pathToFileURL + 动态 import() 加载上游 JS 模块。
 * ============================================================ */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentTypeFor } from './assets.js';
import type { WorkerEnv } from '../types.js';

export interface ObjectOps {
  presignPut(
    env: WorkerEnv,
    key: string,
    expiresSec?: number,
    bucket?: string,
    contentType?: string,
    relative?: boolean
  ): Promise<string>;
  presignGet(env: WorkerEnv, key: string, expiresSec?: number, bucket?: string): Promise<string>;
  r2DeleteObject(env: WorkerEnv, key: string, bucket?: string): Promise<boolean>;
}

const cache = new Map<string, Promise<ObjectOps>>();

function loadObjectOps(appDir: string): Promise<ObjectOps> {
  const entry = pathToFileURL(path.join(appDir, 'functions', '_lib', 'music.js')).href;
  let pending = cache.get(entry);
  if (!pending) {
    pending = import(entry).then((mod) => mod as unknown as ObjectOps);
    cache.set(entry, pending);
  }
  return pending;
}

/** 服务端 PUT 一个对象（走预签名地址，签名里含 Content-Type，必须原样带上） */
export async function putObject(
  appDir: string,
  env: WorkerEnv,
  key: string,
  body: Uint8Array,
  contentType: string,
  bucket: string,
  timeoutMs = 120_000
): Promise<void> {
  const ops = await loadObjectOps(appDir);
  const url = await ops.presignPut(env, key, 3600, bucket, contentType, false);
  if (!url) throw new Error('无法签发上传地址（对象存储配置不完整）');
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }
}

/** 服务端删除一个对象（失败不抛出，交由调用方决定是否告警） */
export async function deleteObject(appDir: string, env: WorkerEnv, key: string, bucket: string): Promise<boolean> {
  try {
    const ops = await loadObjectOps(appDir);
    return await ops.r2DeleteObject(env, key, bucket);
  } catch {
    return false;
  }
}

export interface ObjectSelfTestResult {
  ok: boolean;
  ms: number;
  bucket: string;
  key: string;
  error?: string;
}

/**
 * 真机连通性测试：往桶里写一个 1 字节探针对象再删掉。
 * 只做「地址可达 + 凭据有效 + 桶可写」是不够的 —— 还要能删，
 * 所以这里走完整闭环，测完不留下垃圾对象。
 */
export async function objectSelfTest(
  appDir: string,
  env: WorkerEnv,
  bucket: string
): Promise<ObjectSelfTestResult> {
  const started = Date.now();
  const key = `media/.healthcheck/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
  try {
    if (!bucket) throw new Error('未填写桶名');
    await putObject(appDir, env, key, new Uint8Array([0x6f, 0x6b]), 'text/plain', bucket, 30_000);
    const removed = await deleteObject(appDir, env, key, bucket);
    return {
      ok: true,
      ms: Date.now() - started,
      bucket,
      key,
      ...(removed ? {} : { error: '对象写入成功，但探针删除失败（桶可能缺少 DeleteObject 权限）' })
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, bucket, key, error: (e as Error)?.message || String(e) };
  }
}

/* ------------------------------------------------------------
 * 本地磁盘扫描（迁移用）
 * ------------------------------------------------------------ */
/* 本机磁盘连通性测试同样走「写→读回→删」闭环：光看目录存在不够，
 * 容器里常见的是目录在、但挂载点只读（bind mount ro）或磁盘已满。 */
export async function localSelfTest(uploadDir: string): Promise<ObjectSelfTestResult> {
  const started = Date.now();
  const key = `media/.healthcheck/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const body = Buffer.from('ok', 'utf8');
  try {
    if (!uploadDir) throw new Error('未配置上传目录');
    const filePath = path.join(uploadDir, key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, body);
    const back = await fsp.readFile(filePath).catch(() => Buffer.alloc(0));
    if (!back.equals(body)) throw new Error('回读内容与写入不一致');
    await fsp.rm(filePath, { force: true });
    return { ok: true, ms: Date.now() - started, bucket: '本机磁盘', key };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, bucket: '本机磁盘', key, error: (e as Error)?.message || String(e) };
  }
}

/** 允许迁移的前缀 —— 与 storage.ts 的 ALLOWED_PREFIXES 保持一致 */
export const MIGRATABLE_PREFIXES = ['media', 'music', 'og'] as const;

export interface LocalObject {
  /** 对象 key，如 media/abc.png（与桶内 key 一致） */
  key: string;
  /** 磁盘绝对路径 */
  filePath: string;
  bytes: number;
  contentType: string;
}

/** 列出本地磁盘上待迁移的对象；跳过 .meta 旁挂文件与空目录 */
export async function listLocalObjects(uploadDir: string): Promise<LocalObject[]> {
  const out: LocalObject[] = [];
  for (const prefix of MIGRATABLE_PREFIXES) {
    const dir = path.join(uploadDir, prefix);
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue; // 目录不存在 = 该类没有本地文件
    }
    for (const name of names) {
      if (name.endsWith('.meta') || name.startsWith('.')) continue;
      const filePath = path.join(dir, name);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile()) continue;
      const meta = await fsp.readFile(`${filePath}.meta`, 'utf8').catch(() => '');
      out.push({
        key: `${prefix}/${name}`,
        filePath,
        bytes: stat.size,
        contentType: String(meta || '').trim() || contentTypeFor(filePath)
      });
    }
  }
  return out;
}

/** 各类本地对象的数量（后台存储页展示用） */
export async function countLocalObjects(uploadDir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = { media: 0, music: 0, og: 0, total: 0 };
  for (const prefix of MIGRATABLE_PREFIXES) {
    const names = await fsp.readdir(path.join(uploadDir, prefix)).catch(() => [] as string[]);
    const n = names.filter((name) => !name.endsWith('.meta') && !name.startsWith('.')).length;
    out[prefix] = n;
    out.total = (out.total ?? 0) + n;
  }
  return out;
}
