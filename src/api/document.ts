/* ============================================================
 * API 文档工厂
 * ------------------------------------------------------------
 * 运行时（/openapi.json 路由）与构建期（generated/openapi.json）
 * 共用同一个函数，避免两处定义漂移。
 * ============================================================ */
import { VERSION } from '../config.js';
import { buildOpenApiDocument } from './openapi.js';
import { adminRoutes } from './routes/admin.js';
import { postRoutes } from './routes/posts.js';
import { miscRoutes } from './routes/misc.js';

export const API_TITLE = '轻语博客 API';

export function createApiDocument(serverUrl: string): Record<string, unknown> {
  return buildOpenApiDocument([...postRoutes, ...adminRoutes, ...miscRoutes], {
    title: API_TITLE,
    version: VERSION,
    description:
      '契约来自 src/api/routes/*.ts 的路由注册表：同一份 zod schema 同时驱动运行时校验、' +
      '本文档与客户端类型生成。未列出的 /api/* 路径仍由上游提供，行为与 Cloudflare 版一致。',
    serverUrl
  });
}