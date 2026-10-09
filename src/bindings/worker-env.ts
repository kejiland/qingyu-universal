/* ============================================================
 * Worker 环境装配
 * ------------------------------------------------------------
 * 上游应用只认识 Cloudflare 的绑定名（DB / BLOG / ASSETS / AI / R2_*）。
 * 这里把所有平台差异收敛到一处：自托管配置（S3_* / SMTP_* / AI_*）
 * 映射成上游期望的名字，业务代码因此保持零感知。
 * ============================================================ */
import type { AppConfig } from '../config.js';
import type { Bindings, WorkerEnv } from '../types.js';
import { aiRuntime } from './ai-config.js';
import { storageEnvBindings, storageRuntime } from './storage-config.js';

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
    COMMENT_BLOCKLIST: config.extra.commentBlocklist,
    RESEND_API_KEY: config.mail.resendApiKey,
    /* 操作日志保留策略：透传给上游 api-core.js 的 trimAuditLog()。
     * 空串时该函数会回落到内置默认（5000 条 / 90 天）。 */
    AUDIT_MAX_ROWS: config.audit.maxRows,
    AUDIT_RETENTION_DAYS: config.audit.retentionDays
  };

  const define = (name: string, get: () => unknown): void => {
    Object.defineProperty(env, name, { enumerable: true, configurable: true, get });
  };

  /* AI 相关绑定用动态 getter —— 后台「设置 → AI 助手」改完立即生效，无需重启。
   *   env.AI            ：未配置 / 总开关关闭时返回 undefined，
   *                       上游 aiEnabled() 随即为 false（前端自动隐藏 AI 元素）。
   *   BLOG_AI_ENABLED   ：同上，与 AI 保持一致，避免「DB 开了但 env 关着」的冲突。
   *   BLOG_AI_PUBLIC    ：匿名访客是否可触发生成，由后台开关实时决定。 */
  define('AI', () => aiRuntime.get());
  define('BLOG_AI_ENABLED', () => (aiRuntime.snapshot().config.enabled ? '1' : '0'));
  define('BLOG_AI_PUBLIC', () => (aiRuntime.snapshot().config.publicGenerate ? '1' : '0'));

  if (bindings.mailSender) env.MAIL_SEND = bindings.mailSender;

  /* 本地磁盘实例必须在这里登记进运行时。
   *
   * LOCAL_STORAGE 的值是**动态**的（见 storageRuntime.localUploadTarget()），
   * 所以「实例在哪」这件事也得有人告诉运行时 —— 而且必须是**装配 env 的地方**：
   * 若只让 index.ts 登记，那么测试 / 嵌入式用法（自行调用 buildWorkerEnv）
   * 就拿不到实例，LOCAL_STORAGE 变成 undefined，上游 presignPut 会误判成
   * 「已配置对象存储」而去签名打 local-storage.invalid 这个哨兵地址 → 500。 */
  if (bindings.storage) storageRuntime.setLocal(bindings.storage, config.uploadDir);

  /* 对象存储绑定同样用动态 getter —— 后台「设置 → 存储」改完立即生效，无需重启。
   *
   * 上游那套 S3 签名 / 直传逻辑（app/functions/_lib/music.js、media.js）全靠读 env.R2_*
   * 与 env.LOCAL_STORAGE 判断走向，所以这里只要把它们做成 getter，上游一行都不用改：
   *   R2_*          ：s3 模式给真实凭据；本地模式给哨兵值，让上游的 *_configured() 判定通过。
   *   LOCAL_STORAGE ：只在「新上传走本机磁盘」时返回实例（本地模式，或选了云但配置不完整的降级态）。
   *                   它**不**决定本地读取路由是否挂载 —— /media/* 那套在 app.ts 里常驻，
   *                   所以切到云之后，库里相对地址的老文件仍由本机发出去，不会 404。 */
  const storageKeys = [
    'R2_ENDPOINT', 'R2_REGION', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'R2_MEDIA_BUCKET', 'R2_MEDIA_PUBLIC_BASE', 'R2_BUCKET', 'R2_PUBLIC_BASE', 'R2_BACKUP_BUCKET'
  ] as const;
  for (const key of storageKeys) {
    define(key, () => storageEnvBindings(config.siteUrl)[key]);
  }
  define('LOCAL_STORAGE', () => storageRuntime.localUploadTarget());

  return env;
}
