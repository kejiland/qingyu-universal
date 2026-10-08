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
 *   8. 新版后台（/admin/*，构建产物缺失时让位给上游旧版后台）
 *   9. 前端配置注入（/config.js）
 *  10. 兜底：其余全部交给上游 worker.fetch()
 *
 * 契约路由与兜底路径共用同一份 withEdgeHeaders 实现，行为一致。
 * ============================================================ */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './types.js';
import type { LocalStorage } from './bindings/storage.js';
import type { MigrationReport } from './migrate.js';
import type { WorkerEnv, WorkerModule } from './types.js';
import { createHealthHandler } from './routes/health.js';
import { createConfigJsHandler } from './routes/config-js.js';
import { createPostsJsHandler } from './routes/posts-js.js';
import { adminAppAvailable, createAdminAppHandler } from './routes/admin-app.js';
import { createSeoHandlers, type SeoDeps } from './routes/seo.js';
import { createStaticExportHandler } from './routes/static-export.js';
import { createAiConfigHandlers } from './routes/ai-config.js';
import {
  createLocalDownloadHandler,
  createLocalUploadHandler,
  createPublicObjectHandler
} from './routes/local-storage.js';
import { registerApiRoutes, type ResponseValidation } from './api/registry.js';
import { adminRoutes } from './api/routes/admin.js';
import { postRoutes } from './api/routes/posts.js';
import { miscRoutes } from './api/routes/misc.js';
import { createApiDocument } from './api/document.js';
import { withEdgeHeaders } from './edge.js';

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
  /**
   * AI 配置的实时读取器（自托管版专有）。
   * 有它时，每个请求开始前会按库里的开关刷新 env 的 BLOG_AI_ENABLED /
   * BLOG_AI_PUBLIC，后台改完立即生效，不必重启。
   */
  aiSettings?: () => Promise<{ enabled: boolean; publicEnabled: boolean; baseUrl: string }>;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { config } = deps;
  const logger = deps.logger ?? { warn: console.warn, error: console.error };

  app.use('*', async (c, next) => {
    /* AI 开关按库里的值刷新（有 1s 缓存，开销可忽略）。
     * 必须在这里做而不是启动时做一次：env 是进程级单例，
     * 上游 ai.js 的 aiEnabled() 读的是 env.BLOG_AI_ENABLED，
     * 不刷新的话后台改了开关要重启才生效。
     * 「配了但没填网关地址」也按未启用处理——否则 ping 会谎报可用，
     * 前端渲染出 AI 按钮，点下去才报 502。 */
    if (deps.aiSettings) {
      try {
        const ai = await deps.aiSettings();
        const usable = ai.enabled && !!ai.baseUrl;
        const target = deps.env as Record<string, unknown>;
        target.BLOG_AI_ENABLED = usable ? '1' : '0';
        target.BLOG_AI_PUBLIC = ai.publicEnabled ? '1' : '0';
      } catch {
        /* 读库失败就保持 env 原值，不影响请求 */
      }
    }

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
      withEdgeHeaders: (c) => withEdgeHeaders(c, config),
      validateResponses: deps.validateResponses ?? 'warn',
      logger
    },
    [...postRoutes, ...adminRoutes, ...miscRoutes]
  );

  /* ---------- OpenAPI 文档 ---------- */
  app.get('/openapi.json', (c) => c.json(createApiDocument(config.siteUrl)));

  /* ---------- 静态站导出（本地实现，不进契约） ---------- */
  app.get('/api/admin/export-static', createStaticExportHandler({ config, db: deps.db }));

  /* ---------- AI 配置（自托管版专有：后台改网关 / 模型 / Key，立即生效） ----------
   * 上游没有这套配置（Cloudflare 版是平台绑定的 env.AI），所以不进契约注册表，
   * 本地实现、自己鉴权。 */
  const aiConfig = createAiConfigHandlers({ config, db: deps.db });
  app.get('/api/admin/ai-config', aiConfig.get);
  app.put('/api/admin/ai-config', aiConfig.put);
  app.post('/api/admin/ai-config/test', aiConfig.test);

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

  /* ---------- 服务端 SEO：文章页 / 首页 / 列表页 ----------
   * 每个路径都注册「带尾斜杠」与「不带」两种写法。
   * 前台导航用的是不带斜杠的形式（app.js 的 `url: '/archive'`），所以不带斜杠
   * 是主路径；但爬虫、外部链接、以及用户在地址栏补一个 `/` 的场景同样常见，
   * 而 Hono 默认严格区分尾斜杠——只注册无斜杠版时，`/archive/` 会落到末尾兜底，
   * 结果是「同样的页面，有时有 SSR 首屏、有时只剩空壳」，看起来像随机不一致。
   * `app.js` 的 currentRoute() 会归一化尾斜杠（app.js:4363），两种写法渲染同一个页面。 */
  if (deps.seo) {
    const seo = createSeoHandlers(deps.seo);
    const both = (path: string, handler: (c: Context) => Promise<Response>): void => {
      app.on(['GET', 'HEAD'], path, handler);
      app.on(['GET', 'HEAD'], `${path}/`, handler);
    };
    app.on(['GET', 'HEAD'], '/', seo.home);
    both('/posts/:id', seo.article);
    both('/archive', seo.archive);
    both('/tags', seo.tags);
    both('/categories', seo.categories);
    both('/about', seo.about);
    both('/links', seo.links);
    both('/popular', seo.popular);
  }

  /* ---------- 新版后台 ----------
   * 构建产物存在才接管；否则请求自然落到上游旧版后台，功能不中断。
   *
   * 可用性按需判定（结果缓存 1s）：`npm run admin:build` 重新产出 admin/dist 后
   * 无需重启进程即可生效，避免「改了后台却看到旧界面」这类假不一致。
   * 一旦判定不可用就原样转发给上游 worker，与末尾兜底同一条路径。 */
  const adminApp = createAdminAppHandler(config.adminDistDir);
  let adminReady = adminAppAvailable(config.adminDistDir);
  let adminCheckedAt = 0;
  const adminGate = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const now = Date.now();
    if (now - adminCheckedAt > 1000) {
      adminCheckedAt = now;
      adminReady = adminAppAvailable(config.adminDistDir);
    }
    if (!adminReady) return deps.worker.fetch(withEdgeHeaders(c, config), deps.env);
    await next();
  };
  app.use('/admin', adminGate);
  app.use('/admin/*', adminGate);
  app.on(['GET', 'HEAD'], '/admin', adminApp.index);
  app.on(['GET', 'HEAD'], '/admin/*', adminApp.asset);

  /* ---------- 前端配置注入 ---------- */
  const configJs = createConfigJsHandler(config);
  app.get('/config.js', configJs);
  app.get('/config.min.js', configJs);

  /* ---------- 前端文章注入 ----------
   * index.html 会加载 posts.min.js 注入 window.BLOG_POSTS；上游由后台
   * 「导出静态站点」生成，自托管版改为按 DB 实时生成，否则首页会在
   * app.js 启动时先闪骨架屏再长出列表。 */
  if (deps.seo) {
    const postsJs = createPostsJsHandler(deps.seo.db);
    app.get('/posts.js', postsJs);
    app.get('/posts.min.js', postsJs);
  }

  /* ---------- 兜底：上游应用 ---------- */
  app.all('*', (c) => deps.worker.fetch(withEdgeHeaders(c, config), deps.env));

  return app;
}