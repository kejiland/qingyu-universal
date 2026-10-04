/* ============================================================
 * 健康检查路由
 * ------------------------------------------------------------
 * 容器 HEALTHCHECK、负载均衡探针、部署脚本等待逻辑都打这里。
 * 只返回可安全公开的运行时信息，不泄露配置细节。
 * ============================================================ */
import type { Context } from 'hono';
import type { AppConfig } from '../config.js';
import type { D1Database } from '../bindings/d1.js';
import type { MigrationReport } from '../migrate.js';

export interface HealthDeps {
  config: AppConfig;
  db: D1Database;
  migration: MigrationReport;
  startedAt: number;
}

export function createHealthHandler(deps: HealthDeps) {
  return (c: Context): Response => {
    let posts = 0;
    let database: 'ok' | 'error' = 'ok';
    try {
      posts = Number(deps.db.scalar<number>('SELECT COUNT(*) AS n FROM posts') ?? 0);
    } catch {
      database = 'error';
    }

    const payload = {
      ok: database === 'ok',
      version: deps.config.version,
      revision: deps.config.revision || null,
      storage: deps.config.storageMode,
      database: 'sqlite',
      databaseStatus: database,
      posts,
      migrations: { applied: deps.migration.applied.length, skipped: deps.migration.skipped.length },
      uptime: Math.round((Date.now() - deps.startedAt) / 1000)
    };

    return c.json(payload, database === 'ok' ? 200 : 503);
  };
}