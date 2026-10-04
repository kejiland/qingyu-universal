/* ============================================================
 * 配置加载：.env → 运行时配置 → Workers 风格 env 绑定
 * ------------------------------------------------------------
 * 上游应用只认识 Cloudflare 的绑定名（DB / BLOG / ASSETS / AI / R2_*）。
 * 这里把所有差异收敛在一处：自托管配置项（S3_* / SMTP_* / AI_*）
 * 映射成上游期望的名字，业务代码因此保持零感知。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(ROOT, 'app');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
export const VERSION = '0.1.0';

function readEnvFile(file) {
  if (!fs.existsSync(file)) return;
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
    else {
      // Node 22.0-22.4 兜底：手写最小 .env 解析
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        if (process.env[match[1]] !== undefined) continue;
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch (error) {
    console.warn('[config] .env 解析失败（已忽略）：' + error.message);
  }
}

const s = (name, fallback = '') => {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
};
const n = (name, fallback) => {
  const value = Number(s(name, ''));
  return Number.isFinite(value) && value !== 0 ? value : fallback;
};
const b = (name, fallback = false) => {
  const value = s(name, '').toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

function persistentSecret(dataDir, envValue) {
  if (envValue) return envValue;
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

export function loadConfig() {
  const envFile = process.env.QINGYU_ENV_FILE || path.join(ROOT, '.env');
  readEnvFile(envFile);

  const dataDir = path.resolve(ROOT, s('DATA_DIR', './data'));
  fs.mkdirSync(dataDir, { recursive: true });

  const port = n('PORT', 8787);
  const host = s('HOST', '127.0.0.1');
  const siteUrl = (s('SITE_URL', 'http://localhost:' + port) || ('http://localhost:' + port)).replace(/\/+$/, '');

  // 本地存储签名密钥：优先 BLOG_PREVIEW_SECRET，否则在 data/.secret 持久化随机值。
  const secret = persistentSecret(dataDir, s('BLOG_PREVIEW_SECRET'));

  const s3 = {
    endpoint: s('S3_ENDPOINT', s('R2_ENDPOINT', '')),
    region: s('S3_REGION', s('R2_REGION', 'auto')) || 'auto',
    accessKeyId: s('S3_ACCESS_KEY_ID', s('R2_ACCESS_KEY_ID', '')),
    secretAccessKey: s('S3_SECRET_ACCESS_KEY', s('R2_SECRET_ACCESS_KEY', '')),
    mediaBucket: s('S3_MEDIA_BUCKET', s('R2_MEDIA_BUCKET', '')),
    mediaPublicBase: s('S3_MEDIA_PUBLIC_BASE', s('R2_MEDIA_PUBLIC_BASE', '')),
    musicBucket: s('S3_MUSIC_BUCKET', s('R2_BUCKET', '')),
    musicPublicBase: s('S3_MUSIC_PUBLIC_BASE', s('R2_PUBLIC_BASE', '')),
    backupBucket: s('S3_BACKUP_BUCKET', s('R2_BACKUP_BUCKET', ''))
  };
  const s3Configured = !!(s3.endpoint && s3.accessKeyId && s3.secretAccessKey);

  return {
    version: VERSION,
    root: ROOT,
    appDir: APP_DIR,
    publicDir: PUBLIC_DIR,
    migrationsDir: MIGRATIONS_DIR,
    envFile,
    host,
    port,
    siteUrl,
    dataDir,
    dbPath: path.join(dataDir, 'qingyu.db'),
    uploadDir: path.join(dataDir, 'uploads'),
    secret,
    trustProxy: b('TRUST_PROXY', true),
    geoipHeader: s('GEOIP_HEADER', 'CF-IPCountry'),
    storageMode: s3Configured ? 's3' : 'local',
    s3,
    mail: {
      smtp: {
        host: s('SMTP_HOST', ''),
        port: n('SMTP_PORT', 587),
        user: s('SMTP_USER', ''),
        pass: s('SMTP_PASS', ''),
        secure: b('SMTP_SECURE', false)
      },
      resendApiKey: s('RESEND_API_KEY', ''),
      from: s('BLOG_MAIL_FROM', ''),
      replyTo: s('BLOG_MAIL_REPLY_TO', '')
    },
    ai: {
      baseUrl: s('AI_BASE_URL', ''),
      apiKey: s('AI_API_KEY', ''),
      model: s('AI_MODEL', '')
    },
    admin: {
      setupKey: s('BLOG_ADMIN_SETUP_KEY', ''),
      writeToken: s('BLOG_WRITE_TOKEN', ''),
      email: s('BLOG_ADMIN_EMAIL', '')
    },
    flags: {
      aiEnabled: s('BLOG_AI_ENABLED', ''),
      aiPublic: s('BLOG_AI_PUBLIC', '')
    },
    extra: {
      commentBlocklist: s('COMMENT_BLOCKLIST', '')
    }
  };
}

/** 把运行时配置 + 适配器实例组装成上游期望的 Workers env 对象。 */
export function buildWorkersEnv(config, bindings) {
  const env = {
    DB: bindings.db,
    BLOG: bindings.kv,
    ASSETS: bindings.assets,
    SITE_URL: config.siteUrl,
    BLOG_ADMIN_SETUP_KEY: config.admin.setupKey,
    BLOG_WRITE_TOKEN: config.admin.writeToken,
    BLOG_PREVIEW_SECRET: config.secret,
    BLOG_ADMIN_EMAIL: config.admin.email,
    BLOG_MAIL_FROM: config.mail.from,
    BLOG_MAIL_REPLY_TO: config.mail.replyTo,
    BLOG_AI_ENABLED: config.flags.aiEnabled,
    BLOG_AI_PUBLIC: config.flags.aiPublic,
    COMMENT_BLOCKLIST: config.extra.commentBlocklist,
    RESEND_API_KEY: config.mail.resendApiKey,
    ASSET_ORIGIN: config.siteUrl
  };

  if (bindings.ai) env.AI = bindings.ai;
  if (bindings.mailSender) env.MAIL_SEND = bindings.mailSender;
  if (bindings.storage) env.LOCAL_STORAGE = bindings.storage;

  if (config.storageMode === 's3') {
    env.R2_ENDPOINT = config.s3.endpoint;
    env.R2_REGION = config.s3.region;
    env.R2_ACCESS_KEY_ID = config.s3.accessKeyId;
    env.R2_SECRET_ACCESS_KEY = config.s3.secretAccessKey;
    env.R2_MEDIA_BUCKET = config.s3.mediaBucket;
    env.R2_MEDIA_PUBLIC_BASE = config.s3.mediaPublicBase;
    env.R2_BUCKET = config.s3.musicBucket;
    env.R2_PUBLIC_BASE = config.s3.musicPublicBase;
    env.R2_BACKUP_BUCKET = config.s3.backupBucket;
  } else {
    // 本地磁盘模式：给出哨兵值让上游的 *_configured() 判定通过，
    // 真正的读写由上面对应的 presign*/delete 钩子转发给 LOCAL_STORAGE。
    env.R2_ENDPOINT = 'http://local-storage.invalid';
    env.R2_REGION = 'auto';
    env.R2_ACCESS_KEY_ID = 'local-disk';
    env.R2_SECRET_ACCESS_KEY = 'local-disk';
    env.R2_MEDIA_BUCKET = 'media';
    env.R2_MEDIA_PUBLIC_BASE = config.siteUrl;
    env.R2_BUCKET = 'music';
    env.R2_PUBLIC_BASE = config.siteUrl;
    env.R2_BACKUP_BUCKET = 'backups';
  }
  return env;
}