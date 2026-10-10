/* ============================================================
 * 测试用服务器：在临时目录里起一个真实实例
 * ------------------------------------------------------------
 * 用固定高位端口（按 pid 派生，避免并发冲突），因为 config.siteUrl 在
 * loadConfig() 时就冻结了，必须先知道端口。
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';

import { loadConfig, ROOT } from '../../src/config.js';
import { createD1 } from '../../src/bindings/d1.js';
import { createKV } from '../../src/bindings/kv.js';
import { createAssets } from '../../src/bindings/assets.js';
import { createLocalStorage } from '../../src/bindings/storage.js';
import { buildWorkerEnv } from '../../src/bindings/worker-env.js';
import { runMigrations } from '../../src/migrate.js';
import { createApp } from '../../src/app.js';
import type { WorkerModule } from '../../src/types.js';

export interface TestServer {
  baseUrl: string;
  setupKey: string;
  /** 直接访问测试库，方便验证写路径/迁移 */
  db: ReturnType<typeof createD1>;
  /** 开启后，响应不符合契约会直接返回 500，而不是只告警 */
  close(): Promise<void>;
}

const MANAGED_ENV = [
  'QINGYU_ENV_FILE',
  'DATA_DIR',
  'SITE_URL',
  'SITE_DOMAIN',
  'HOST',
  'PORT',
  'BLOG_ADMIN_SETUP_KEY',
  'BLOG_WRITE_TOKEN',
  'BLOG_PREVIEW_SECRET',
  'API_VALIDATE_RESPONSES',
  'LOG_PRETTY',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY'
];

export async function startTestServer(): Promise<TestServer> {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-ct-'));
  const port = 19000 + (process.pid % 2000);
  const setupKey = 'contract-test-setup-key';

  process.env.QINGYU_ENV_FILE = path.join(dir, 'missing.env');
  process.env.DATA_DIR = dir;
  process.env.SITE_URL = `http://127.0.0.1:${port}`;
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(port);
  process.env.BLOG_ADMIN_SETUP_KEY = setupKey;
  process.env.LOG_PRETTY = '0';

  const config = loadConfig();
  const db = createD1(config.dbPath);
  const kv = createKV(db);
  const assets = createAssets(config.publicDir);
  const storage = createLocalStorage({
    uploadDir: config.uploadDir,
    secret: config.secret,
    baseUrl: config.siteUrl
  });

  const env = buildWorkerEnv(config, { db, kv, assets, storage });
  const migration = await runMigrations(db, config.migrationsDir);

  const workerEntry = pathToFileURL(path.join(config.appDir, 'worker.js')).href;
  const worker = ((await import(workerEntry)) as { default: WorkerModule }).default;

  /* 与 src/index.ts 保持一致：接入服务端 SEO 路由。
   * 少了这一段，/ 与 /posts/:id 会落到兜底的外壳 HTML，
   * 于是文章页的压缩头、缓存头、SSR 正文在测试里全都测不到。 */
  const apiCoreEntry = pathToFileURL(path.join(config.appDir, 'functions/_lib/api-core.js')).href;
  const apiCore = (await import(apiCoreEntry)) as { securityHeaders?: () => Record<string, string> };
  const securityHeaders = typeof apiCore.securityHeaders === 'function' ? apiCore.securityHeaders : undefined;

  const app = createApp({
    config,
    db,
    env,
    worker,
    migration,
    storage,
    seo: { config, db, securityHeaders },
    // 测试环境一律 strict：schema 与实际响应不符就当作失败
    validateResponses: 'strict'
  });

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setupKey,
    db,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  };
}

export { ROOT };