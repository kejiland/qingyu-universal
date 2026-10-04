/* ============================================================
 * Hono 应用装配
 * ------------------------------------------------------------
 * 分工：
 *   · 自托管专有路由（健康检查、本地上传、配置注入、公开对象）用 Hono 原生写法
 *   · 其余全部请求转交给上游 worker.fetch()——它已经是标准的
 *     fetch(Request) → Response 形态，不需要改写成 Hono 路由
 * 这样既拿到了框架的路由/中间件/流式响应能力，又保住了与上游的同步能力。
 * ============================================================ */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppConfig } from './config.js';
import type { D1Database } from './bindings/d1.js';
import type { LocalStorage } from './bindings/storage.js';
import type { MigrationReport } from './migrate.js';
import type { WorkerEnv, WorkerModule } from './types.js';
import { createHealthHandler } from './routes/health.js';
import { createSeoHandlers, type SeoDeps } from './routes/seo.js';
import { createConfigJsHandler } from './routes/config-js.js';
import {
  createLocalDownloadHandler,
  createLocalUploadHandler,
  createPublicObjectHandler
} from './routes/local-storage.js';

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
  /** 请求日志注入点，便于测试时静音。 */
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void;
}

/** 解析真实客户端 IP：信任反代时读转发头，否则回落到 socket 地址。 */
function resolveClientIp(c: Parameters<typeof getConnInfo>[0], config: AppConfig): string {
  const header = (name: string): string => (c.req.header(name) ?? '').trim();

  if (config.trustProxy) {
    const forwarded = header('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
    const realIp = header('x-real-ip');
    if (realIp) return realIp;
  }

  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

/**
 * 上游只信任 CDN 注入的 CF-Connecting-IP（不读 X-Forwarded-For，因为该头
 * 客户端可伪造）。本进程就是可信边界，因此在这里统一注入，使限流 / 点赞去重 /
 * 来源统计拿到稳定的客户端标识。
 */
function withEdgeHeaders(c: Parameters<typeof getConnInfo>[0], config: AppConfig): Request {
  const original = c.req.raw;
  const headers = new Headers(original.headers);

  const ip = resolveClientIp(c, config);
  if (ip) headers.set('CF-Connecting-IP', ip);

  // 可选地理统计：反代注入国家码（Caddy + GeoIP2 / Nginx geoip2）。
  const geoHeader = config.geoipHeader.toLowerCase();
  const country = geoHeader ? (headers.get(geoHeader) ?? '').trim().toUpperCase().slice(0, 2) : '';
  if (country) headers.set('CF-IPCountry', country);

  const hasBody = original.method !== 'GET' && original.method !== 'HEAD' && original.body !== null;
  const init = {
    method: original.method,
    headers,
    ...(hasBody ? { body: original.body, duplex: 'half' } : {})
  } as RequestInit;

  const request = new Request(original.url, init);
  if (country) {
    try {
      Object.defineProperty(request, 'cf', { value: { country }, configurable: true });
    } catch {
      /* 只读环境下忽略：上游会回落到空国家码 */
    }
  }
  return request;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { config } = deps;

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

  /* ---------- 服务端 SEO：文章页 / 首页 ----------
   * 必须在 catch-all 之前注册，否则会被上游 worker 的 SPA 回退吞掉。 */
  if (deps.seo) {
    const seo = createSeoHandlers(deps.seo);
    app.on(['GET', 'HEAD'], '/', seo.home);
    app.on(['GET', 'HEAD'], '/posts/:id', seo.article);
    app.on(['GET', 'HEAD'], '/posts/:id/', seo.article);
  }

  /* ---------- 前端配置注入 ---------- */
  const configJs = createConfigJsHandler(config);
  app.get('/config.js', configJs);
  app.get('/config.min.js', configJs);

  /* ---------- 兜底：上游应用 ---------- */
  app.all('*', (c) => deps.worker.fetch(withEdgeHeaders(c, config), deps.env));

  return app;
}