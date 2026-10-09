/* ============================================================
 * 服务入口
 * ------------------------------------------------------------
 * 启动顺序：加载配置 → 装配绑定 → 迁移数据库 → 加载上游 worker →
 * 挂载 Hono → 启动 HTTP 与定时任务。
 * ============================================================ */
import { serve } from '@hono/node-server';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, describeConfig } from './config.js';
import { createDatabase } from './bindings/database.js';
import { createKV } from './bindings/kv.js';
import { createAssets } from './bindings/assets.js';
import { createLocalStorage, normalizeLocalObjectUrls } from './bindings/storage.js';
import { aiRuntime, envDefaults, loadAiConfigFromDb, mergeAiConfig } from './bindings/ai-config.js';
import {
  loadStorageConfigFromDb,
  mergeStorageConfig,
  storageEnvDefaults,
  storageRuntime
} from './bindings/storage-config.js';
import { createSmtpSender, type SmtpSender } from './bindings/mail.js';
import { buildWorkerEnv } from './bindings/worker-env.js';
import { runMigrations } from './migrate.js';
import { startScheduler } from './scheduler.js';
import { createApp } from './app.js';
import { logger, bridgeConsole } from './logger.js';
import { withAsciiHeaders } from './header-guard.js';
import type { Bindings, WorkerEnv, WorkerModule } from './types.js';

/* ---------- 日志：接管上游 console.* ---------- */
bridgeConsole(logger);

const startedAt = Date.now();
const config = loadConfig();

/* ---------- 绑定装配 ---------- */
const db = createDatabase(config);
const kv = createKV(db, config.redisUrl);
const assets = createAssets(config.publicDir);

/* 本地磁盘实例**始终创建**（不再只在 local 模式创建）：
 *   · 它是「新上传」的目标 —— 是否真的用它由 storageRuntime 动态决定（见 LOCAL_STORAGE getter）；
 *   · 它同时承担 /media/* /music/* /og/* 的本地读取 —— 常驻挂载，
 *     这样即便切到对象存储，库里相对地址的老文件仍能正常访问，不会 404。 */
const storage = createLocalStorage({
  uploadDir: config.uploadDir,
  secret: config.secret,
  baseUrl: `http://127.0.0.1:${config.port}`
});

/* AI 绑定改为动态（见 worker-env.ts 的 getter）：这里不再按启动配置决定有无 AI，
 * 而是等迁移完成后把「环境变量默认值 + 数据库后台配置」合并进 aiRuntime。 */
const smtp: SmtpSender | undefined = config.mail.smtp.host
  ? createSmtpSender({
      host: config.mail.smtp.host,
      port: config.mail.smtp.port,
      user: config.mail.smtp.user,
      pass: config.mail.smtp.pass,
      secure: config.mail.smtp.secure,
      from: config.mail.from,
      replyTo: config.mail.replyTo
    })
  : undefined;

const bindings: Bindings = {
  db,
  kv,
  assets,
  storage,
  ...(smtp ? { mailSender: smtp.send } : {})
};

const env: WorkerEnv = buildWorkerEnv(config, bindings);

/* ---------- 数据库结构 ---------- */
const migration = await runMigrations(db, config.migrationsDir, (message) => logger.info(message), path.join(config.root, 'deploy', 'postgres', 'schema.sql'));

/* ---------- 对象存储配置（环境变量兜底，后台配置优先） ----------
 * 表在迁移之后才存在，所以放在这里读；写回由 /api/admin/storage 负责。
 * 后台保存时会同步刷新 storageRuntime，env.R2_* / LOCAL_STORAGE 的动态 getter
 * 立即反映 → 无需重启即生效（与 AI 助手同一套机制）。 */
{
  const defaults = storageEnvDefaults({
    mode: config.storageMode,
    ...config.s3
  });
  const fromDb = await loadStorageConfigFromDb(db);
  const merged = mergeStorageConfig(defaults, fromDb);
  // 本地实例已由 buildWorkerEnv 登记进 storageRuntime，这里只补默认值与生效配置
  storageRuntime.setDefaults(defaults);
  storageRuntime.set(merged.config, merged.source);
  const snap = storageRuntime.snapshot();
  logger.info(
    snap.useLocalUpload
      ? `[storage] 本机磁盘 ${snap.uploadDir}（来源：${snap.source}`
        + `${snap.degraded ? '，已选对象存储但配置不完整，暂降级为本地盘' : ''}）`
      : `[storage] 对象存储 ${snap.config.endpoint}（来源：${snap.source}，媒体桶 ${snap.config.mediaBucket}）`
  );
}

/* 只在「实际生效」的存储方式是本地磁盘时才回写历史绝对地址。
 * 注意判据必须是 storageRuntime 的**生效值**，不能再用 config.storageMode ——
 * 后台切到云之后环境变量仍是 local，若照旧执行会把刚迁移过去的绝对地址又改回相对，白干。 */
if (storageRuntime.snapshot().mode === 'local') {
  const normalized = await normalizeLocalObjectUrls(db, config.siteUrl);
  if (normalized > 0) logger.info(`[storage] 已修正 ${normalized} 行本地对象地址`);
}

/* ---------- AI 助手配置（环境变量兜底，后台配置优先） ----------
 * 表在迁移之后才存在，所以放在这里读；写回由 /api/admin/ai 负责。
 * 后台保存时会同步刷新 aiRuntime，env.AI 的动态 getter 立即反映 → 无需重启。 */
{
  const defaults = envDefaults({
    ...config.ai,
    enabled: config.flags.aiEnabled,
    publicGenerate: config.flags.aiPublic
  });
  const fromDb = await loadAiConfigFromDb(db);
  const merged = mergeAiConfig(defaults, fromDb);
  // defaults 存进 runtime：后台接口保存后要用它重新合并，才能立刻回显真实生效值
  aiRuntime.setDefaults(defaults);
  aiRuntime.set(merged.config, merged.source);
  logger.info(
    merged.config.enabled && merged.config.baseUrl
      ? `[ai] 已启用（来源：${merged.source}，模型：${merged.config.model || '（上游默认）'}）`
      : '[ai] 未启用（可在后台「设置 → AI 助手」配置）'
  );
}

/* ---------- 上游应用（Cloudflare Workers 形态） ---------- */
const workerEntry = pathToFileURL(path.join(config.appDir, 'worker.js')).href;
const workerModule = (await import(workerEntry)) as { default: WorkerModule };
const worker = workerModule.default;

/* ---------- 复用上游的安全响应头 ----------
 * SEO 路由直接返回 HTML，不经过 worker，因此这里把上游的 securityHeaders()
 * 借过来，保证两条路径的安全头完全一致（避免各写一份导致漂移）。 */
const apiCoreEntry = pathToFileURL(path.join(config.appDir, 'functions/_lib/api-core.js')).href;
const apiCore = (await import(apiCoreEntry)) as { securityHeaders?: () => Record<string, string> };
const securityHeaders = typeof apiCore.securityHeaders === 'function' ? apiCore.securityHeaders : undefined;

/* ---------- 自引用 fetch 改写 ----------
 * 本地存储模式下备份等逻辑会在服务端 fetch 本站地址（SITE_URL）。
 * 若公网域名在容器内不可解析，这里把本站 origin 改写到环回地址，保证必然可达。 */
const nativeFetch = globalThis.fetch.bind(globalThis);
const internalOrigin = `http://127.0.0.1:${config.port}`;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith(`${config.siteUrl}/`)) {
      return nativeFetch(raw.replace(config.siteUrl, internalOrigin), init);
    }
  } catch {
    /* 保持原生行为 */
  }
  return nativeFetch(input, init);
}) as typeof fetch;

/* ---------- HTTP ---------- */
const app = createApp({
  config,
  db,
  env,
  worker,
  migration,
  storage,
  seo: { config, db, securityHeaders },
  validateResponses: config.validateResponses,
  logger: { warn: (message) => logger.warn(message), error: (message) => logger.error(message) },
  startTime: startedAt,
  // quiet 的请求（正常返回的静态资源）走 debug，不刷屏
  onRequest: (info) => {
    const { quiet, ...rest } = info;
    if (quiet) logger.debug(rest, 'http');
    else logger.info(rest, 'http');
  }
});

/** 终端显示宽度：CJK 字符占两列，直接用 padEnd 会错位。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1;
  }
  return width;
}
const padTo = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

const server = serve(
  {
    // 最靠外的可拦截点：把响应交给 @hono/node-server 写出之前先消毒头值
    // 最靠外的可拦截点：交给 @hono/node-server 写出之前先消毒头值。
    // 这里断言是必要的：Hono 的 fetch 与 node-server 的 FetchCallback 在
    // 可选参数上类型不兼容，但运行时签名一致。
    fetch: ((request: Request) => withAsciiHeaders(app.fetch(request))) as never,
    hostname: config.host,
    port: config.port
  },
  () => {
  const lines = describeConfig(config);
  const width = Math.max(...lines.map(([label]) => displayWidth(label))) + 4;

  logger.info('');
  logger.info(`  轻语博客 · 自托管通用版 v${config.version}${config.revision ? ' (' + config.revision + ')' : ''}`);
  logger.info(`  ${'─'.repeat(60)}`);
  for (const [label, value] of lines) logger.info(`  ${padTo(label, width)}${value}`);
  logger.info(`  ${padTo('已应用迁移', width)}${migration.applied.length} 个（跳过 ${migration.skipped.length} 个）`);
  logger.info(`  ${'─'.repeat(60)}`);
  logger.info(`  第一次使用：浏览器打开 ${config.siteUrl}/admin 完成初始化`);
  logger.info('');
});

/* ---------- 定时任务 ---------- */
const scheduler = startScheduler(worker, env, {
  instanceId: config.instanceId,
  backupCron: config.cron.backup,
  timezone: config.cron.timezone,
  logger: { info: (message) => logger.info(message), error: (message) => logger.error(message) }
});

/* ---------- SMTP 自检（失败不阻塞启动，只告警） ---------- */
if (smtp) {
  void smtp
    .verify()
    .then(() => logger.info('[mail] SMTP 连接与认证自检通过'))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[mail] SMTP 自检失败（订阅邮件将无法发送）：${message}`);
    });
}

/* ---------- 优雅退出 ---------- */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[server] 收到 ${signal}，正在退出…`);
  scheduler.stop();
  smtp?.close();

  server.close(() => {
    try {
      db.close();
    } catch {
      /* 忽略关闭异常 */
    }
    process.exit(0);
  });

  // 兜底：连接迟迟不释放时强制退出
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
