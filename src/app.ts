/* ============================================================
 * Hono 应用装配
 * ------------------------------------------------------------
 * 注册顺序即匹配优先级，从具体到兜底：
 *   1. 请求日志
 *   2. 探针（/healthz）
 *   3. 契约路由（/api/posts、/api/search…）—— 校验后转发给上游
 *   4. OpenAPI 文档（/openapi.json）
 *   5. 本地存储路由（/api/local-upload、/media/*…）
 *   6. 服务端 SEO（/ 与 /posts/:id）
 *   7. 前端配置注入（/config.js）
 *   8. 兜底：其余全部交给上游 worker.fetch()
 *
 * 契约路由与兜底路径共用同一份 withEdgeHeaders 实现，行为一致。
 * ============================================================ */
import { Hono } from 'hono';
import type { AppConfig } from './config.js';
import type { D1Database } from './bindings/d1.js';
import type { LocalStorage } from './bindings/storage.js';
import type { MigrationReport } from './migrate.js';
import type { WorkerEnv, WorkerModule } from './types.js';
import { createHealthHandler } from './routes/health.js';
import { createConfigJsHandler } from './routes/config-js.js';
import { adminAppAvailable, createAdminAppHandler } from './routes/admin-app.js';
import { createSeoHandlers, type SeoDeps } from './routes/seo.js';
import {
  createLocalDownloadHandler,
  createLocalUploadHandler,
  createPublicObjectHandler
} from './routes/local-storage.js';
import { registerApiRoutes, type ResponseValidation } from './api/registry.js';
import { adminRoutes } from './api/routes/admin.js';
import { postRoutes } from './api/routes/posts.js';
import { createApiDocument } from './api/document.js';
import { withEdgeHeaders } from './edge.js';

export interface AppDeps {
  config: AppConfig;
  db: D1Database;
  env: WorkerEnv;
  worker: WorkerModule;
  migration: MigrationReport;
  storage?: LocalStorage;
  /** 进程启动时间（健康检查里的 uptime 基准）。 */
  startTime?: number;
  /** 服务端 SEO 渲染依赖；不传则跳过注入（保持上游原始行为）。 */
  seo?: SeoDeps;
  /** 响应契约校验强度，默认 warn。 */
  validateResponses?: ResponseValidation;
  logger?: { warn: (message: string) => void; error: (message: string) => void };
  /** 请求日志注入点，便于测试时静音。 */
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { config } = deps;
  const logger = deps.logger ?? { warn: console.warn, error: console.error };

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const ms = Math.round((performance.now() - started) * 10) / 10;
    deps.onRequest?.({ method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms });
  });

  /* ---------- 探针 ---------- */
  const health = createHealthHandler({
    config,
    db: deps.db,
    migration: deps.migration,
    startedAt: deps.startTime ?? Date.now()
  });
  app.get('/healthz', health);
  app.get('/api/health', health);

  /* ---------- 契约路由 ---------- */
  registerApiRoutes(
    app,
    {
      worker: deps.worker,
      env: deps.env,
      withEdgeHeaders: (c) => withEdgeHeaders(c, config),
      validateResponses: deps.validateResponses ?? 'warn',
      logger
    },
    [...postRoutes, ...adminRoutes]
  );

  /* ---------- OpenAPI 文档 ---------- */
  app.get('/openapi.json', (c) => c.json(createApiDocument(config.siteUrl)));

  /* ---------- 本地存储（仅在未配置对象存储时挂载） ---------- */
  if (deps.storage) {
    const upload = createLocalUploadHandler(deps.storage);
    const download = createLocalDownloadHandler(deps.storage);
    const publicObject = createPublicObjectHandler(deps.storage);

    app.all('/api/local-upload', upload);
    app.all('/api/local-download', download);
    for (const prefix of ['/media/*', '/music/*', '/og/*']) {
      app.on(['GET', 'HEAD'], prefix, publicObject);
    }
  }

  /* ---------- 服务端 SEO：文章页 / 首页 ---------- */
  if (deps.seo) {
    const seo = createSeoHandlers(deps.seo);
    app.on(['GET', 'HEAD'], '/', seo.home);
    app.on(['GET', 'HEAD'], '/posts/:id', seo.article);
    app.on(['GET', 'HEAD'], '/posts/:id/', seo.article);
    app.on(['GET', 'HEAD'], '/archive', seo.archive);
    app.on(['GET', 'HEAD'], '/tags', seo.tags);
    app.on(['GET', 'HEAD'], '/categories', seo.categories);
  }

  /* ---------- 新版后台 ----------
   * 构建产物存在才挂载；否则请求自然落到上游旧版后台，功能不中断。 */
  if (adminAppAvailable(config.adminDistDir)) {
    const adminApp = createAdminAppHandler(config.adminDistDir);
    app.on(['GET', 'HEAD'], '/admin', adminApp.index);
    app.on(['GET', 'HEAD'], '/admin/*', adminApp.asset);
  }

  /* ---------- 前端配置注入 ---------- */
  const configJs = createConfigJsHandler(config);
  app.get('/config.js', configJs);
  app.get('/config.min.js', configJs);

  /* ---------- 兜底：上游应用 ---------- */
  app.all('*', (c) => deps.worker.fetch(withEdgeHeaders(c, config), deps.env));

  return app;
}