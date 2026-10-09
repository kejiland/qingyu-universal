/* ============================================================
 * 审计日志写入 —— 供「自托管新增」的本地接口复用上游实现
 * ------------------------------------------------------------
 * `recordAudit` 的唯一实现在上游 JS 里：app/functions/_lib/api-core.js。
 * tsconfig 没开 allowJs，TS 不能直接 import 它；但本进程启动时本来就
 * `await import(config.appDir + '/worker.js')` 动态加载了上游应用，
 * 所以这里沿用同一手法按需加载 —— **保证全站只有一份实现**
 * （含保留策略与裁剪逻辑），不会演变成「TS 一套、JS 一套」慢慢分叉。
 *
 * 请求：不能直接复用「读过的」原始请求重建 —— 局部路由里请求体已被 ctx.c.req.json()
 * 消费，withEdgeHeaders() 再 new Request(body) 会抛（body locked）。
 * 而上游 clientIp() 只读 CF-Connecting-IP 一个头，所以这里构造一个**无体的最小请求**
 * 把解析好的 IP 塞进去即可，既拿到真实 IP 又不会踩到流已消费的问题。
 * ============================================================ */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerEnv } from '../types.js';
import type { ApiContext } from './registry.js';

interface AuditWriter {
  recordAudit: (
    env: unknown,
    request: Request | null,
    action: string,
    target?: string,
    detail?: string
  ) => Promise<void>;
}

const cache = new Map<string, Promise<AuditWriter>>();

function loadAuditWriter(appDir: string): Promise<AuditWriter> {
  const entry = pathToFileURL(path.join(appDir, 'functions', '_lib', 'api-core.js')).href;
  let pending = cache.get(entry);
  if (!pending) {
    pending = import(entry).then((mod) => mod as unknown as AuditWriter);
    cache.set(entry, pending);
  }
  return pending;
}

/** 记录一条审计日志（永不抛出）。 */
export async function recordAudit(
  appDir: string,
  env: WorkerEnv,
  request: Request | null,
  action: string,
  target?: string,
  detail?: string
): Promise<void> {
  try {
    const writer = await loadAuditWriter(appDir);
    await writer.recordAudit(env, request, action, target, detail);
  } catch {
    /* 审计不可用（模块缺失等）不影响主业务流程 */
  }
}

/** 便捷版：直接用契约路由的上下文记录，自动带上真实客户端 IP。 */
export function auditFromContext(
  ctx: ApiContext,
  action: string,
  target?: string,
  detail?: string
): Promise<void> {
  let request: Request | null = null;
  try {
    const ip = ctx.clientIp(ctx.c);
    request = new Request('http://audit.local/', ip ? { headers: { 'CF-Connecting-IP': ip } } : {});
  } catch {
    /* 拿不到 IP 就退化为空记录（ip 记为 unknown），不影响主流程 */
  }
  return recordAudit(ctx.appDir, ctx.env, request, action, target, detail);
}
