/* ============================================================
 * 配置加载：dotenv + zod 校验
 * ------------------------------------------------------------
 * 所有环境变量在这里一次性校验并归一化，后续模块只消费强类型对象，
 * 不再各自读 process.env。配置错误在启动时就报出来，而不是运行到
 * 某个分支才炸。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** 项目根目录（源码在 src/，构建后在 dist/，两种情况下上一级都是根）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(ROOT, 'app');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
export const VERSION = '0.3.0';

/**
 * 构建版本：构建镜像时注入的 git 短 SHA（见 deploy/Dockerfile 的 BUILD_REVISION）。
 * 有它才能回答「我升级到底生效了没有」—— 仅靠语义版本号是做不到的，
 * 因为同一个版本号下可能有很多次提交。压缩包安装时无法取到 SHA，则为空。
 */
export const BUILD_REVISION = String(process.env.BUILD_REVISION || '').trim();

/* ---------- zod 助手 ---------- */
const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const value = (raw ?? '').trim().toLowerCase();
      if (!value) return fallback;
      return value === '1' || value === 'true' || value === 'yes' || value === 'on';
    });

/** 只保留非空变量，让 schema 的 .default() 能对「空字符串」生效。 */
function pruneEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

const EnvSchema = z.object({
  /* 服务 */
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().trim().default('127.0.0.1'),
  SITE_URL: z.string().trim().optional(),
  SITE_DOMAIN: z.string().trim().default(''),
  DATA_DIR: z.string().trim().default('./data'),
  ADMIN_DIST_DIR: z.string().trim().default(''),
  TRUST_PROXY: booleanish(true),
  GEOIP_HEADER: z.string().trim().default('CF-IPCountry'),
  LOG_LEVEL: z.string().trim().default(''),

  /* 管理员 */
  BLOG_ADMIN_SETUP_KEY: z.string().trim().default(''),
  BLOG_WRITE_TOKEN: z.string().trim().default(''),
  BLOG_PREVIEW_SECRET: z.string().trim().default(''),
  BLOG_ADMIN_EMAIL: z.string().trim().default(''),

  /* 对象存储（S3 兼容） */
  S3_ENDPOINT: z.string().trim().default(''),
  S3_REGION: z.string().trim().default('auto'),
  S3_ACCESS_KEY_ID: z.string().trim().default(''),
  S3_SECRET_ACCESS_KEY: z.string().trim().default(''),
  S3_MEDIA_BUCKET: z.string().trim().default(''),
  S3_MEDIA_PUBLIC_BASE: z.string().trim().default(''),
  S3_MUSIC_BUCKET: z.string().trim().default(''),
  S3_MUSIC_PUBLIC_BASE: z.string().trim().default(''),
  S3_BACKUP_BUCKET: z.string().trim().default(''),

  /* 兼容 Cloudflare 版变量名（便于从线上版直接迁移配置） */
  R2_ENDPOINT: z.string().trim().default(''),
  R2_REGION: z.string().trim().default(''),
  R2_ACCESS_KEY_ID: z.string().trim().default(''),
  R2_SECRET_ACCESS_KEY: z.string().trim().default(''),
  R2_MEDIA_BUCKET: z.string().trim().default(''),
  R2_MEDIA_PUBLIC_BASE: z.string().trim().default(''),
  R2_BUCKET: z.string().trim().default(''),
  R2_PUBLIC_BASE: z.string().trim().default(''),
  R2_BACKUP_BUCKET: z.string().trim().default(''),

  /* 邮件 */
  SMTP_HOST: z.string().trim().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().trim().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_SECURE: booleanish(false),
  RESEND_API_KEY: z.string().trim().default(''),
  BLOG_MAIL_FROM: z.string().trim().default(''),
  BLOG_MAIL_REPLY_TO: z.string().trim().default(''),

  /* AI */
  AI_BASE_URL: z.string().trim().default(''),
  AI_API_KEY: z.string().trim().default(''),
  AI_MODEL: z.string().trim().default(''),
  BLOG_AI_ENABLED: z.string().trim().default(''),
  BLOG_AI_PUBLIC: z.string().trim().default(''),

  /* 其它 */
  COMMENT_BLOCKLIST: z.string().default(''),
  REDIS_URL: z.string().trim().default(''),
  INSTANCE_ID: z.string().trim().default('1'),
  API_VALIDATE_RESPONSES: z.enum(['off', 'warn', 'strict']).optional(),
  CRON_TIMEZONE: z.string().trim().default('UTC'),
  BACKUP_CRON: z.string().trim().default('0 19 * * *'),
  TZ: z.string().trim().default('')
});

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  mediaBucket: string;
  mediaPublicBase: string;
  musicBucket: string;
  musicPublicBase: string;
  backupBucket: string;
}

export interface AppConfig {
  readonly version: string;
  /** 构建时的 git 短 SHA；取不到则为空串。 */
  readonly revision: string;
  readonly root: string;
  readonly appDir: string;
  readonly publicDir: string;
  readonly migrationsDir: string;
  readonly envFile: string;
  readonly host: string;
  readonly port: number;
  readonly siteUrl: string;
  readonly siteDomain: string;
  readonly dataDir: string;
  /** 新版后台的构建产物目录（不存在时自动回落到旧版后台）。 */
  readonly adminDistDir: string;
  readonly dbPath: string;
  readonly uploadDir: string;
  readonly secret: string;
  readonly redisUrl: string;
  readonly trustProxy: boolean;
  readonly geoipHeader: string;
  readonly logLevel: string;
  readonly instanceId: string;
  /** 响应契约校验：off=关闭，warn=只告警，strict=不符即 500（测试用）。 */
  readonly validateResponses: 'off' | 'warn' | 'strict';
  readonly cron: { readonly timezone: string; readonly backup: string };
  readonly storageMode: 'local' | 's3';
  readonly s3: StorageConfig;
  readonly mail: {
    readonly smtp: { host: string; port: number; user: string; pass: string; secure: boolean };
    readonly resendApiKey: string;
    readonly from: string;
    readonly replyTo: string;
  };
  readonly ai: { baseUrl: string; apiKey: string; model: string };
  readonly admin: { setupKey: string; writeToken: string; email: string };
  readonly flags: { aiEnabled: string; aiPublic: string };
  readonly extra: { commentBlocklist: string };
}

/** 取第一个非空值：优先自托管变量名，其次 Cloudflare 版变量名。 */
const pick = (primary: string, fallback: string): string => primary || fallback;

/**
 * 本地存储签名密钥：优先显式配置，否则在 DATA_DIR/.secret 持久化一个随机值。
 * 持久化很关键——密钥变化会让已签发的上传地址立即失效。
 */
function persistentSecret(dataDir: string, explicit: string): string {
  if (explicit) return explicit;
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadConfig(): AppConfig {
  const envFile = process.env.QINGYU_ENV_FILE || path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) loadDotenv({ path: envFile, quiet: true });

  const parsed = EnvSchema.safeParse(pruneEmpty(process.env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  · ${issue.path.join('.') || '(root)'}：${issue.message}`)
      .join('\n');
    throw new Error('配置校验失败：\n' + details);
  }
  const env = parsed.data;

  const dataDir = path.resolve(ROOT, env.DATA_DIR);
  fs.mkdirSync(dataDir, { recursive: true });

  const siteUrl = normalizeBaseUrl(env.SITE_URL || `http://localhost:${env.PORT}`);
  const secret = persistentSecret(dataDir, env.BLOG_PREVIEW_SECRET);

  const s3: StorageConfig = {
    endpoint: normalizeBaseUrl(pick(env.S3_ENDPOINT, env.R2_ENDPOINT)),
    region: pick(env.S3_REGION, env.R2_REGION) || 'auto',
    accessKeyId: pick(env.S3_ACCESS_KEY_ID, env.R2_ACCESS_KEY_ID),
    secretAccessKey: pick(env.S3_SECRET_ACCESS_KEY, env.R2_SECRET_ACCESS_KEY),
    mediaBucket: pick(env.S3_MEDIA_BUCKET, env.R2_MEDIA_BUCKET),
    mediaPublicBase: normalizeBaseUrl(pick(env.S3_MEDIA_PUBLIC_BASE, env.R2_MEDIA_PUBLIC_BASE)),
    musicBucket: pick(env.S3_MUSIC_BUCKET, env.R2_BUCKET),
    musicPublicBase: normalizeBaseUrl(pick(env.S3_MUSIC_PUBLIC_BASE, env.R2_PUBLIC_BASE)),
    backupBucket: pick(env.S3_BACKUP_BUCKET, env.R2_BACKUP_BUCKET)
  };
  const storageMode: 'local' | 's3' =
    s3.endpoint && s3.accessKeyId && s3.secretAccessKey ? 's3' : 'local';

  const isSmtpReady = Boolean(env.SMTP_HOST && env.BLOG_MAIL_FROM);

  return Object.freeze({
    version: VERSION,
    revision: BUILD_REVISION,
    root: ROOT,
    appDir: APP_DIR,
    publicDir: PUBLIC_DIR,
    migrationsDir: MIGRATIONS_DIR,
    envFile,
    host: env.HOST,
    port: env.PORT,
    siteUrl,
    siteDomain: env.SITE_DOMAIN,
    dataDir,
    adminDistDir: path.resolve(ROOT, env.ADMIN_DIST_DIR || path.join('admin', 'dist')),
    dbPath: path.join(dataDir, 'qingyu.db'),
    uploadDir: path.join(dataDir, 'uploads'),
    secret,
    redisUrl: env.REDIS_URL,
    trustProxy: env.TRUST_PROXY,
    geoipHeader: env.GEOIP_HEADER,
    logLevel: env.LOG_LEVEL,
    instanceId: env.INSTANCE_ID,
    validateResponses: env.API_VALIDATE_RESPONSES ?? (process.env.NODE_ENV === 'production' ? 'off' : 'warn'),
    cron: { timezone: env.CRON_TIMEZONE, backup: env.BACKUP_CRON },
    storageMode,
    s3,
    mail: {
      smtp: {
        host: isSmtpReady ? env.SMTP_HOST : '',
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        secure: env.SMTP_SECURE
      },
      resendApiKey: env.RESEND_API_KEY,
      from: env.BLOG_MAIL_FROM,
      replyTo: env.BLOG_MAIL_REPLY_TO
    },
    ai: { baseUrl: normalizeBaseUrl(env.AI_BASE_URL), apiKey: env.AI_API_KEY, model: env.AI_MODEL },
    admin: {
      setupKey: env.BLOG_ADMIN_SETUP_KEY,
      writeToken: env.BLOG_WRITE_TOKEN,
      email: env.BLOG_ADMIN_EMAIL
    },
    flags: { aiEnabled: env.BLOG_AI_ENABLED, aiPublic: env.BLOG_AI_PUBLIC },
    extra: { commentBlocklist: env.COMMENT_BLOCKLIST }
  });
}

/** 启动横幅用的脱敏摘要（只暴露「是否配置」，不打印任何密钥）。 */
export function describeConfig(config: AppConfig): Array<[string, string]> {
  return [
    ['站点地址', config.siteUrl],
    ['监听地址', `http://${config.host}:${config.port}`],
    ['数据库', `${config.dbPath}（SQLite / WAL）`],
    ['存储方式', config.storageMode === 's3' ? `S3 兼容对象存储（${config.s3.endpoint}）` : `本地磁盘 ${config.uploadDir}`],
    ['Redis/Valkey', config.redisUrl ? '已配置（限流/去重走 Redis）' : '未配置（使用 SQLite KV）'],

    ['AI 助手', config.ai.baseUrl ? `已启用（${config.ai.model || '默认模型'}）` : '未配置'],
    ['邮件通知', config.mail.smtp.host ? 'SMTP' : config.mail.resendApiKey ? 'Resend' : '未配置'],
    ['管理员密钥', config.admin.setupKey ? '已设置' : '未设置（首次初始化无保护，建议补上）']
  ];
}
