/* ============================================================
 * 共享类型：上游（Cloudflare 形态）依赖的平台接口
 * ------------------------------------------------------------
 * app/ 下的业务代码是纯 JavaScript，它只要求 env 提供 Cloudflare
 * 文档中定义的那几个绑定。这里把这些接口显式声明出来，让自托管实现
 * 有编译期约束——不是「模拟 Cloudflare」，而是「实现它依赖的契约」。
 * ============================================================ */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: {
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    changed_db?: boolean;
  };
}

export interface D1PreparedStatement {
  readonly sql: string;
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = unknown>(column?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface KVGetOptions {
  type?: 'text' | 'json' | 'arrayBuffer' | 'stream';
  cacheTtl?: number;
}

export interface KVPutOptions {
  expiration?: number;
  expirationTtl?: number;
}

export interface KVNamespaceLike {
  get(key: string, options?: KVGetOptions | KVGetOptions['type']): Promise<unknown>;
  put(key: string, value: unknown, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AssetsBindingLike {
  fetch(request: Request): Promise<Response>;
}

export interface AIBindingLike {
  run(model: string, inputs: Record<string, unknown>): Promise<{ response: string; usage?: unknown }>;
}

export type MailSender = (to: string, subject: string, html: string) => Promise<boolean>;

/** 本地磁盘存储适配器（在对象存储未配置时接管上传/下载/删除）。 */
export interface LocalStorageLike {
  presignPut(env: WorkerEnv, key: string, expiresSec?: number, bucket?: string, contentType?: string): Promise<string>;
  presignGet(env: WorkerEnv, key: string, expiresSec?: number, bucket?: string): Promise<string>;
  deleteObject(env: WorkerEnv, key: string, bucket?: string): Promise<boolean>;
}

/**
 * 传给上游 worker.js 的运行环境。
 * 带确定性的字段用具体类型；其余平台变量（R2_*、BLOG_* 等）保持宽松，
 * 因为上游会以字符串形式读取它们。
 */
export interface WorkerEnv {
  DB: D1DatabaseLike;
  BLOG: KVNamespaceLike;
  ASSETS: AssetsBindingLike;
  SITE_URL: string;

  AI?: AIBindingLike;
  MAIL_SEND?: MailSender;
  LOCAL_STORAGE?: LocalStorageLike;

  [key: string]: unknown;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

/** 上游 worker.js 的模块形状。 */
export interface WorkerModule {
  fetch(request: Request, env: WorkerEnv, ctx?: unknown): Promise<Response>;
  scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx?: unknown): Promise<void>;
}

/** 绑定集合：由 bootstrap 装配后交给 buildWorkerEnv()。 */
export interface Bindings {
  db: D1DatabaseLike;
  kv: KVNamespaceLike;
  assets: AssetsBindingLike;
  ai?: AIBindingLike;
  storage?: LocalStorageLike;
  mailSender?: MailSender;
}