/* ============================================================
 * Worker 环境装配
 * ------------------------------------------------------------
 * 上游应用只认识 Cloudflare 的绑定名（DB / BLOG / ASSETS / AI / R2_*）。
 * 这里把所有平台差异收敛到一处：自托管配置（S3_* / SMTP_* / AI_*）
 * 映射成上游期望的名字，业务代码因此保持零感知。
 * ============================================================ */
import type { AppConfig } from '../config.js';
import type { Bindings, WorkerEnv } from '../types.js';

export function buildWorkerEnv(config: AppConfig, bindings: Bindings): WorkerEnv {
  const env: WorkerEnv = {
    DB: bindings.db,
    BLOG: bindings.kv,
    ASSETS: bindings.assets,

    SITE_URL: config.siteUrl,
    DB_DIALECT: config.databaseDialect,
    BLOG_ADMIN_SETUP_KEY: config.admin.setupKey,
    BLOG_WRITE_TOKEN: config.admin.writeToken,
    BLOG_PREVIEW_SECRET: config.secret,
    BLOG_ADMIN_EMAIL: config.admin.email,
    BLOG_MAIL_FROM: config.mail.from,
    BLOG_MAIL_REPLY_TO: config.mail.replyTo,
    BLOG_AI_ENABLED: config.flags.aiEnabled,
    BLOG_AI_PUBLIC: config.flags.aiPublic,
    COMMENT_BLOCKLIST: config.extra.commentBlocklist,
    RESEND_API_KEY: config.mail.resendApiKey
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
    // 真正的读写由上面对应的 presign* / delete 钩子转发给 LOCAL_STORAGE。
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