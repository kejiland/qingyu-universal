/* ============================================================
 * 轻语博客 · 自托管通用版 — 服务入口
 * ------------------------------------------------------------
 * 把 Cloudflare Workers / Pages 形态的应用（app/worker.js）跑在原生 Node 上：
 *   · D1      → node:sqlite（本地文件）
 *   · KV      → SQLite 表
 *   · ASSETS  → public/ 目录
 *   · R2/S3   → S3 兼容直传，或本地磁盘 + 签名上传端点
 *   · AI      → 任意 OpenAI 兼容接口
 *   · Cron    → 进程内调度器
 * ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { loadConfig, buildWorkersEnv, VERSION } from './config.js';
import { createD1 } from './bindings/d1.js';
import { createKV } from './bindings/kv.js';
import { createAssets } from './bindings/assets.js';
import { createAI } from './bindings/ai.js';
import { createLocalStorage } from './bindings/storage.js';
import { createSmtpSender } from './bindings/mail.js';
import { runMigrations } from './migrate.js';
import { startScheduler } from './scheduler.js';
import { toWebRequest, sendWebResponse, serveStaticFile } from './http.js';

const MAX_UPLOAD = 64 * 1024 * 1024; // 上传上限兜底（图片 10MB / 音乐 30MB，留足余量）

const config = loadConfig();

/* ---------- 绑定装配 ---------- */
const db = createD1(config.dbPath, {});
const kv = createKV(db);
const assets = createAssets(config.publicDir);
const bindings = { db: db, kv: kv, assets: assets };

if (config.ai.baseUrl) bindings.ai = createAI(config.ai);
if (config.storageMode === 'local') {
  bindings.storage = createLocalStorage({
    uploadDir: config.uploadDir,
    secret: config.secret,
    baseUrl: config.siteUrl
  });
}
if (config.mail.smtp.host && config.mail.from) {
  bindings.mailSender = createSmtpSender({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    user: config.mail.smtp.user,
    pass: config.mail.smtp.pass,
    secure: config.mail.smtp.secure,
    from: config.mail.from,
    replyTo: config.mail.replyTo
  });
}
const env = buildWorkersEnv(config, bindings);

/* ---------- 数据库结构 ---------- */
const migration = runMigrations(db, config.migrationsDir, console.log);

/* ---------- 上游应用（Cloudflare Workers 形态） ---------- */
const worker = (await import('../app/worker.js')).default;

/* ---------- 自引用 fetch 改写 ----------
 * 本地存储模式下，备份等逻辑会在服务端 fetch 本站地址（SITE_URL）。
 * 若公网域名在容器内不可解析，这里把本站 origin 改写到环回地址，保证必然可达。 */
const nativeFetch = globalThis.fetch;
const internalOrigin = 'http://127.0.0.1:' + config.port;
globalThis.fetch = function patchedFetch(input, init) {
  try {
    const raw = typeof input === 'string' ? input : (input instanceof URL ? input.href : input && input.url);
    if (raw && raw.startsWith(config.siteUrl + '/')) {
      return nativeFetch(raw.replace(config.siteUrl, internalOrigin), init);
    }
  } catch (_) { /* 保持原生行为 */ }
  return nativeFetch(input, init);
};

/* ---------- 请求处理 ---------- */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function handleLocalUpload(req, res, url) {
  if (!bindings.storage) return sendJson(res, 404, { ok: false, error: 'Not Found' });
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }
  const key = url.searchParams.get('key') || '';
  const exp = url.searchParams.get('exp') || '';
  const ct = url.searchParams.get('ct') || '';
  const sig = url.searchParams.get('sig') || '';
  if (!bindings.storage.verify('PUT', key, exp, ct, sig)) {
    return sendJson(res, 403, { ok: false, error: '上传地址无效或已过期' });
  }
  const length = Number(req.headers['content-length'] || 0);
  if (length && length > MAX_UPLOAD) {
    return sendJson(res, 413, { ok: false, error: '文件超出大小限制' });
  }
  const target = bindings.storage.readPath(key);
  if (!target) return sendJson(res, 400, { ok: false, error: '非法的对象 key' });

  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(req, fs.createWriteStream(target));
    if (ct) await fsp.writeFile(target + '.meta', ct, 'utf8').catch(() => {});
    const stat = await fsp.stat(target);
    return sendJson(res, 200, { ok: true, key: key, size: stat.size });
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => {});
    return sendJson(res, 500, { ok: false, error: '写入失败：' + error.message });
  }
}

async function handleLocalDownload(req, res, url) {
  if (!bindings.storage) return sendJson(res, 404, { ok: false, error: 'Not Found' });
  const key = url.searchParams.get('key') || '';
  const exp = url.searchParams.get('exp') || '';
  const sig = url.searchParams.get('sig') || '';
  if (!bindings.storage.verify('GET', key, exp, '', sig)) {
    return sendJson(res, 403, { ok: false, error: '下载地址无效或已过期' });
  }
  const target = bindings.storage.readPath(key);
  if (!target || !(await serveStaticFile(req, res, target, { cacheControl: 'no-store' }))) {
    return sendJson(res, 404, { ok: false, error: '对象不存在' });
  }
}

/** 公开对象：/media/* /music/* /og/* —— 由本地存储直接提供，支持 Range。 */
async function handlePublicObject(req, res, pathname) {
  if (!bindings.storage) return false;
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative.split('/').includes('..')) {
    res.writeHead(400); res.end('Bad Request'); return true;
  }
  const target = path.join(config.uploadDir, relative);
  const within = path.relative(config.uploadDir, target);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(400); res.end('Bad Request'); return true;
  }
  const meta = await fsp.readFile(target + '.meta', 'utf8').catch(() => '');
  const served = await serveStaticFile(req, res, target, {
    contentType: meta.trim() || undefined,
    cacheControl: 'public, max-age=31536000, immutable'
  });
  if (!served) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
  return true;
}

function handleHealth(res) {
  let posts = 0;
  try { posts = Number((db.raw.prepare('SELECT COUNT(*) AS n FROM posts').get() || {}).n || 0); } catch (_) { /* ignore */ }
  sendJson(res, 200, {
    ok: true,
    version: VERSION,
    storage: config.storageMode,
    database: 'sqlite',
    posts: posts,
    uptime: Math.round(process.uptime())
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', internalOrigin);
  const pathname = url.pathname;

  if (pathname === '/healthz' || pathname === '/api/health') return handleHealth(res);
  if (pathname === '/api/local-upload') return handleLocalUpload(req, res, url);
  if (pathname === '/api/local-download') return handleLocalDownload(req, res, url);
  if (/^\/(media|music|og)\//.test(pathname)) {
    if (await handlePublicObject(req, res, pathname)) return;
  }

  const request = toWebRequest(req, config);
  const response = await worker.fetch(request, env);
  await sendWebResponse(res, response, req.method);
}

const server = http.createServer((req, res) => {
  req.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
  handle(req, res).catch((error) => {
    console.error('[server] 未捕获异常：', error && error.stack || error);
    if (res.headersSent) { try { res.destroy(); } catch (_) { /* ignore */ } return; }
    sendJson(res, 500, { ok: false, error: '服务端内部错误' });
  });
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

const scheduler = startScheduler(worker, env, { instanceId: process.env.INSTANCE_ID || '1' });

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('  轻语博客 · 自托管通用版 v' + VERSION);
  console.log('  ------------------------------------------------------------');
  console.log('  站点地址   ' + config.siteUrl);
  console.log('  本地监听   http://' + shown + ':' + config.port);
  console.log('  数据库     ' + config.dbPath + '（SQLite / WAL）');
  console.log('  存储方式   ' + (config.storageMode === 's3' ? 'S3 兼容对象存储' : '本地磁盘 ' + config.uploadDir));
  console.log('  AI 助手    ' + (bindings.ai ? '已启用（' + (config.ai.model || '默认模型') + '）' : '未配置'));
  console.log('  邮件通知   ' + (bindings.mailSender || config.mail.resendApiKey ? '已配置' : '未配置'));
  console.log('  已应用迁移 ' + migration.applied.length + ' 个（跳过 ' + migration.skipped.length + ' 个）');
  console.log('  ------------------------------------------------------------');
  if (!config.admin.setupKey) {
    console.log('  ⚠ 未设置 BLOG_ADMIN_SETUP_KEY，首次初始化未设保护，建议尽快在 .env 中补上。');
  } else {
    console.log('  初始化密钥 BLOG_ADMIN_SETUP_KEY（首次打开 /admin 时填写）');
  }
  console.log('  第一次使用：浏览器打开 ' + config.siteUrl + '/admin 完成初始化');
  console.log('');
});

function shutdown(signal) {
  console.log('[server] 收到 ' + signal + '，正在退出…');
  scheduler.stop();
  server.close(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));