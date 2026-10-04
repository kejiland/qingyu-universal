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
import { createD1 } from './bindings/d1.js';
import { createKV } from './bindings/kv.js';
import { createAssets } from './bindings/assets.js';
import { createLocalStorage } from './bindings/storage.js';
import { createAI } from './bindings/ai.js';
import { createSmtpSender, type SmtpSender } from './bindings/mail.js';
import { buildWorkerEnv } from './bindings/worker-env.js';
import { runMigrations } from './migrate.js';
import { startScheduler } from './scheduler.js';
import { createApp } from './app.js';
import { logger, bridgeConsole } from './logger.js';
import type { Bindings, WorkerEnv, WorkerModule } from './types.js';

/* ---------- 日志：接管上游 console.* ---------- */
bridgeConsole(logger);

const startedAt = Date.now();
const config = loadConfig();

/* ---------- 绑定装配 ---------- */
const db = createD1(config.dbPath);
const kv = createKV(db);
const assets = createAssets(config.publicDir);

const storage =
  config.storageMode === 'local'
    ? createLocalStorage({ uploadDir: config.uploadDir, secret: config.secret, baseUrl: config.siteUrl })
    : undefined;

const ai = config.ai.baseUrl ? createAI(config.ai) : undefined;

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
  ...(ai ? { ai } : {}),
  ...(storage ? { storage } : {}),
  ...(smtp ? { mailSender: smtp.send } : {})
};

const env: WorkerEnv = buildWorkerEnv(config, bindings);

/* ---------- 数据库结构 ---------- */
const migration = runMigrations(db, config.migrationsDir, (message) => logger.info(message));

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
  onRequest: (info) => logger.info(info, 'http')
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

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  const lines = describeConfig(config);
  const width = Math.max(...lines.map(([label]) => displayWidth(label))) + 4;

  logger.info('');
  logger.info(`  轻语博客 · 自托管通用版 v${config.version}`);
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
