/* ============================================================
 * Hono 应用装配
 * ------------------------------------------------------------
 * 注册顺序即匹配优先级，从具体到兜底：
 *   1. 请求日志
 *   2. 探针（/healthz）
 *   3. 契约路由（/api/posts、/api/search…）—— 校验后转发给上游
 *   4. OpenAPI 文档（/openapi.json）
 *   5. 静态站导出（/api/admin/export-static）
 *   6. 本地存储路由（/api/local-upload、/media/*…）
 *   7. 服务端 SEO（/ 与 /posts/:id）
 *   8. 前端配置注入（/config.js）
 *   9. 兜底：其余全部交给上游 worker.fetch()
 *
 * 契约路由与兜底路径共用同一份 withEdgeHeaders 实现，行为一致。
 * ============================================================ */
import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './types.js';
import type { LocalStorage } from './bindings/storage.js';
import type { MigrationReport } from './migrate.js';
import type { WorkerEnv, WorkerModule } from './types.js';
import { createHealthHandler } from './routes/health.js';
import { createConfigJsHandler } from './routes/config-js.js';
import { adminAppAvailable, createAdminAppHandler } from './routes/admin-app.js';
import { createSeoHandlers, type SeoDeps } from './routes/seo.js';
import { createStaticExportHandler } from './routes/static-export.js';
import { createImageProxyHandler } from './routes/image-proxy.js';
import { configureImageProxy, hostOfUrl } from './lib/image-url.js';
import {
  createLocalDownloadHandler,
  createLocalUploadHandler,
  createPublicObjectHandler
} from './routes/local-storage.js';
import { registerApiRoutes, type ResponseValidation } from './api/registry.js';
import { adminAiRoutes } from './api/routes/admin-ai.js';
import { adminStorageRoutes } from './api/routes/admin-storage.js';
import { adminRoutes } from './api/routes/admin.js';
import { postRoutes } from './api/routes/posts.js';
import { miscRoutes } from './api/routes/misc.js';
import { createApiDocument } from './api/document.js';
import { resolveClientIp, withEdgeHeaders } from './edge.js';

export interface AppDeps {
  config: AppConfig;
  db: AppDatabase;
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
  onRequest?: (info: { method: string; path: string; status: number; ms: number; quiet?: boolean }) => void;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // 服务端直接提供文本压缩，兼容不经 Caddy 的直连/端口部署。
  // 只压缩小于阈值不划算的响应，已有 Content-Encoding 的响应由中间件跳过。
  app.use(compress({ threshold: 1024 }));
  const { config } = deps;
  const logger = deps.logger ?? { warn: console.warn, error: console.error };

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const path = new URL(c.req.url).pathname;
    // 静态资源（css/js/图片/字体）不按 info 记录 —— 一次页面浏览就有几十个这种请求，
    // 而 Docker 默认不限制日志大小，小 VPS 上会慢慢把磁盘写满。
    // 它们降到 debug（默认不输出），需要排查时把 LOG_LEVEL 调成 debug 即可。
    const isStatic = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|m4a|ogg|opus|wav|flac)$/i.test(path);
    deps.onRequest?.({
      method: c.req.method,
      path,
      status: c.res.status,
      ms,
      quiet: isStatic && c.res.status < 400
    });
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
      db: deps.db,
      appDir: config.appDir,
      clientIp: (c) => resolveClientIp(c, config),
      withEdgeHeaders: (c) => withEdgeHeaders(c, config),
      validateResponses: deps.validateResponses ?? 'warn',
      logger
    },
    [...postRoutes, ...adminAiRoutes, ...adminStorageRoutes, ...adminRoutes, ...miscRoutes]
  );

  /* ---------- OpenAPI 文档 ---------- */
  app.get('/openapi.json', (c) => c.json(createApiDocument(config.siteUrl)));

  /* ---------- 静态站导出（本地实现，不进契约） ---------- */
  app.get('/api/admin/export-static', createStaticExportHandler({ config, db: deps.db }));

  /* ---------- 本地磁盘对象（常驻挂载） ----------
   * 以前只在本地模式挂载，导致切到对象存储后，库里相对地址的老文件全部 404。
   * 现在始终挂载：新上传往哪走由 env.LOCAL_STORAGE 决定，而**读取**永远可以回本地磁盘取。
   * 写入端点（/api/local-upload）需要 HMAC 签名，只有本地模式才会签发，因此常驻无安全隐患。 */
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

  /* ---------- 外链图片本地缓存反代（/api/img） ----------
   * 首屏封面 / 头像原先要浏览器直连境外图床（实测 TLS 握手就 0.4~0.5s），
   * 改为服务端抓取一次 + 落盘缓存，浏览器只连本站。
   * SSR 侧（src/lib/image-url.ts）用同一份开关决定是否改写地址，
   * 这样关闭反代时前后端行为一致，不会出现「一半走代理一半直连」。 */
  configureImageProxy({
    enabled: config.imageProxy.enabled,
    selfHost: hostOfUrl(config.siteUrl)
  });
  const imageProxy = createImageProxyHandler({
    cacheDir: path.join(config.dataDir, 'cache', 'img'),
    enabled: config.imageProxy.enabled,
    maxBytes: config.imageProxy.maxBytes,
    cacheBytes: config.imageProxy.cacheBytes,
    passthroughHosts: [hostOfUrl(config.siteUrl), hostOfUrl(config.s3.mediaPublicBase), hostOfUrl(config.s3.musicPublicBase)],
    logger: (message) => logger.warn(message)
  });
  app.on(['GET', 'HEAD'], '/api/img', imageProxy);

  /* ---------- 服务端 SEO：文章页 / 首页 ---------- */
  if (deps.seo) {
    const seo = createSeoHandlers(deps.seo);
    app.on(['GET', 'HEAD'], '/', seo.home);
    app.on(['GET', 'HEAD'], '/posts/:id', seo.article);
    app.on(['GET', 'HEAD'], '/posts/:id/', seo.article);
    app.on(['GET', 'HEAD'], '/archive', seo.archive);
    app.on(['GET', 'HEAD'], '/tags', seo.tags);
    app.on(['GET', 'HEAD'], '/categories', seo.categories);
    app.on(['GET', 'HEAD'], '/about', seo.about);
    app.on(['GET', 'HEAD'], '/links', seo.links);
    app.on(['GET', 'HEAD'], '/popular', seo.popular);
    // 补齐此前缺失 SSR 的两个公开页（首屏不再空白等 app.js）
    app.on(['GET', 'HEAD'], '/series', seo.series);
    app.on(['GET', 'HEAD'], '/guestbook', seo.guestbook);
  }

  /* ---------- 后台 ----------
   * 默认 **不挂载** Vue SPA：/admin 落到下面的兜底，由上游 worker 返回 SPA 外壳，
   * 再经 app.js 的 ensureAdminBundle() 加载 app/public/admin.min.js（上游原生后台），
   * 于是 /admin 保持上游的 UI / 布局 / 样式。
   *
   * 只有显式配置 ADMIN_SPA=1 时才挂载 Vue 版（构建产物需存在），
   * 它会重新遮住 /admin，仅用于对照与排障。 */
  if (config.adminSpa && adminAppAvailable(config.adminDistDir)) {
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
