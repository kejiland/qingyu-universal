/* ============================================================
 * 对象存储配置（后台「设置 → 存储」）
 * ------------------------------------------------------------
 * 落点：独立表 storage_config(k,v)，**不经过公开的 /api/settings**
 *       （那个接口匿名可读且带缓存头，放 Secret Access Key 会泄露）。
 * 优先级：数据库配置 > 环境变量（环境变量用作首次部署的默认值）。
 * 生效方式：写入后立刻更新内存单例 storageRuntime；
 *           worker-env 的 R2_* / LOCAL_STORAGE 都是**动态 getter**，
 *           所以保存后无需重启即生效 —— 上游那套 S3 签名逻辑一行都不用改。
 *
 * 「本地与云并存」怎么实现的：
 *   LOCAL_STORAGE 只决定**新上传往哪写**；本地磁盘的公开读取路由
 *   （/media/* /music/* /og/*）在 src/app.ts 里是**常驻挂载**的，
 *   所以切到云之后，库里那些相对地址的老文件仍然由本机正常发出去，不会 404。
 * ============================================================ */
import type { AppDatabase, LocalStorageLike } from '../types.js';
import { maskApiKey } from './ai-config.js';

export type StorageMode = 'local' | 's3';
export type StorageConfigSource = 'db' | 'env' | 'none';

export interface StorageConfig {
  /** 存储方式：本机磁盘 或 S3 兼容对象存储 */
  mode: StorageMode;
  endpoint: string;
  region: string;
  accessKeyId: string;
  /** Secret Access Key（只在服务端流转，读接口只回传打码值） */
  secretAccessKey: string;
  mediaBucket: string;
  mediaPublicBase: string;
  musicBucket: string;
  musicPublicBase: string;
  backupBucket: string;
}

/** 密钥打码规则与 AI Key 完全一致（≤8 全星号，否则 first4****last4）。
 *  直接复用同一函数，避免两套规则各写一份以后漂移。 */
export const maskSecret = maskApiKey;

export function emptyStorageConfig(): StorageConfig {
  return {
    mode: 'local',
    endpoint: '',
    region: '',
    accessKeyId: '',
    secretAccessKey: '',
    mediaBucket: '',
    mediaPublicBase: '',
    musicBucket: '',
    musicPublicBase: '',
    backupBucket: ''
  };
}

const trimBase = (value: string): string => String(value || '').replace(/\/+$/, '');

/** 环境变量侧的默认配置（S3_* 优先，兼容 Cloudflare 版的 R2_* 变量名） */
export function storageEnvDefaults(raw: StorageConfig): StorageConfig {
  const s3 = raw.mode === 's3';
  return {
    // 环境变量已经判定过：三个凭据齐全才算 s3（见 config.ts 的 storageMode）
    mode: s3 ? 's3' : 'local',
    endpoint: trimBase(raw.endpoint),
    region: raw.region || 'auto',
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    mediaBucket: raw.mediaBucket,
    mediaPublicBase: trimBase(raw.mediaPublicBase),
    // 音乐桶留空时上游会自动回退到媒体桶（见 music.js 的 musicStorage()）
    musicBucket: raw.musicBucket,
    musicPublicBase: trimBase(raw.musicPublicBase),
    backupBucket: raw.backupBucket
  };
}

/** 读取数据库里的存储配置（不含的键不返回，交由调用方与默认值合并） */
export async function loadStorageConfigFromDb(db: AppDatabase): Promise<Partial<StorageConfig>> {
  let rows: Array<{ k: string; v: string }> = [];
  try {
    rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM storage_config');
  } catch {
    // 迁移尚未执行（首次启动竞态）时按「无配置」处理
    return {};
  }
  const out: Partial<StorageConfig> = {};
  for (const row of rows) {
    const v = String(row.v ?? '');
    switch (row.k) {
      case 'mode': out.mode = v === 's3' ? 's3' : 'local'; break;
      case 'endpoint': out.endpoint = trimBase(v); break;
      case 'region': out.region = v; break;
      case 'accessKeyId': out.accessKeyId = v; break;
      case 'secretAccessKey': out.secretAccessKey = v; break;
      case 'mediaBucket': out.mediaBucket = v; break;
      case 'mediaPublicBase': out.mediaPublicBase = trimBase(v); break;
      case 'musicBucket': out.musicBucket = v; break;
      case 'musicPublicBase': out.musicPublicBase = trimBase(v); break;
      case 'backupBucket': out.backupBucket = v; break;
      default: break;
    }
  }
  return out;
}

/** 合并：数据库优先，其次环境变量 */
export function mergeStorageConfig(base: StorageConfig, fromDb: Partial<StorageConfig>): { config: StorageConfig; source: StorageConfigSource } {
  const has = Object.keys(fromDb).length > 0;
  const config: StorageConfig = {
    mode: fromDb.mode ?? base.mode,
    endpoint: fromDb.endpoint ?? base.endpoint,
    region: fromDb.region ?? base.region,
    accessKeyId: fromDb.accessKeyId ?? base.accessKeyId,
    secretAccessKey: fromDb.secretAccessKey !== undefined ? fromDb.secretAccessKey : base.secretAccessKey,
    mediaBucket: fromDb.mediaBucket ?? base.mediaBucket,
    mediaPublicBase: fromDb.mediaPublicBase ?? base.mediaPublicBase,
    musicBucket: fromDb.musicBucket ?? base.musicBucket,
    musicPublicBase: fromDb.musicPublicBase ?? base.musicPublicBase,
    backupBucket: fromDb.backupBucket ?? base.backupBucket
  };
  // 只有真正落过库才算 db；否则看环境变量是否给了一套可用的云配置
  const source: StorageConfigSource = has ? 'db' : (base.mode === 's3' ? 'env' : 'none');
  return { config, source };
}

/** 写入数据库（只写传入的字段） */
export async function saveStorageConfigToDb(db: AppDatabase, patch: Partial<StorageConfig>): Promise<void> {
  const stmts: Array<{ sql: string; params: unknown[] }> = [];
  const put = (k: string, v: string): void => {
    stmts.push({
      sql: 'INSERT INTO storage_config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
      params: [k, v]
    });
  };
  if (patch.mode !== undefined) put('mode', patch.mode);
  if (patch.endpoint !== undefined) put('endpoint', patch.endpoint);
  if (patch.region !== undefined) put('region', patch.region);
  if (patch.accessKeyId !== undefined) put('accessKeyId', patch.accessKeyId);
  if (patch.secretAccessKey !== undefined) put('secretAccessKey', patch.secretAccessKey);
  if (patch.mediaBucket !== undefined) put('mediaBucket', patch.mediaBucket);
  if (patch.mediaPublicBase !== undefined) put('mediaPublicBase', patch.mediaPublicBase);
  if (patch.musicBucket !== undefined) put('musicBucket', patch.musicBucket);
  if (patch.musicPublicBase !== undefined) put('musicPublicBase', patch.musicPublicBase);
  if (patch.backupBucket !== undefined) put('backupBucket', patch.backupBucket);
  if (!stmts.length) return;

  const prepared = stmts.map((s) => db.prepare(s.sql).bind(...s.params));
  await db.batch(prepared);
}

/** 媒体侧配置是否完整到「能签发上传」。
 *  与上游 media.js 的 r2Configured() 保持一致：缺公开域名就签得出上传地址却登记不了 URL，
 *  最后在桶里留孤儿对象。 */
export function s3MediaReady(config: StorageConfig): boolean {
  return !!(
    config.endpoint &&
    config.accessKeyId &&
    config.secretAccessKey &&
    config.mediaBucket &&
    config.mediaPublicBase
  );
}

/* ------------------------------------------------------------
 * 运行时配置（内存单例）
 * worker-env 的动态 getter 直接读它，所以后台保存后立即生效。
 * ------------------------------------------------------------ */

export interface StorageRuntimeSnapshot {
  config: StorageConfig;
  source: StorageConfigSource;
  /** 实际生效的存储方式 */
  mode: StorageMode;
  /** 云端是否配置完整（能签发上传） */
  s3Ready: boolean;
  /** 新上传是否走本机磁盘（mode=local，或选了云但配置不完整时的降级） */
  useLocalUpload: boolean;
  /** 选了三方云但配置不完整，正在降级用本地盘 */
  degraded: boolean;
  /** 本机磁盘上传根目录 */
  uploadDir: string;
}

class StorageRuntime {
  #config: StorageConfig = emptyStorageConfig();
  #source: StorageConfigSource = 'none';
  #defaults: StorageConfig = emptyStorageConfig();
  #local: LocalStorageLike | undefined;
  #uploadDir = '';

  /** 由 index.ts 注入本地磁盘实例与目录（并存读取 + 迁移都要用） */
  setLocal(storage: LocalStorageLike, uploadDir: string): void {
    this.#local = storage;
    this.#uploadDir = uploadDir;
  }

  local(): LocalStorageLike | undefined {
    return this.#local;
  }

  setDefaults(defaults: StorageConfig): void {
    this.#defaults = { ...defaults };
  }

  defaults(): StorageConfig {
    return { ...this.#defaults };
  }

  set(config: StorageConfig, source: StorageConfigSource): void {
    this.#config = { ...config };
    this.#source = source;
  }

  snapshot(): StorageRuntimeSnapshot {
    const config = { ...this.#config };
    const s3Ready = s3MediaReady(config);
    const mode: StorageMode = config.mode === 's3' ? 's3' : 'local';
    return {
      config,
      source: this.#source,
      mode,
      s3Ready,
      // 选了云但没配全时不硬撑着报错，先降级回本机磁盘，界面上给明确提示
      useLocalUpload: mode === 'local' || !s3Ready,
      degraded: mode === 's3' && !s3Ready,
      uploadDir: this.#uploadDir
    };
  }

  /** env.LOCAL_STORAGE 的取值：只有「新上传走本地盘」时才返回实例 */
  localUploadTarget(): LocalStorageLike | undefined {
    return this.snapshot().useLocalUpload ? this.#local : undefined;
  }
}

export const storageRuntime = new StorageRuntime();

/* ------------------------------------------------------------
 * 给 worker-env 用的动态绑定映射
 * ------------------------------------------------------------ */

export interface StorageEnvBindings {
  R2_ENDPOINT: string;
  R2_REGION: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_MEDIA_BUCKET: string;
  R2_MEDIA_PUBLIC_BASE: string;
  R2_BUCKET: string;
  R2_PUBLIC_BASE: string;
  R2_BACKUP_BUCKET: string;
}

/**
 * 把**任意一份**配置映射成上游认识的那组名字。
 *
 * 之所以拆出这个纯函数：后台「连通性测试」要在**保存之前**用表单里的候选值
 * 去签一次上传地址，不能被「当前已保存的配置」绑住 —— 否则用户必须先存一个
 * 错的配置才能验证它。
 *
 * 本地模式给的是**哨兵值**：让上游的 *_configured() 判定通过，
 * 真正的读写由 LOCAL_STORAGE 的 presign* / delete 钩子转发到磁盘
 * （见 app/functions/_lib/music.js 与 media.js 里的 [self-host] 分支）。
 */
export function storageEnvBindingsFor(config: StorageConfig, siteUrl: string): StorageEnvBindings {
  const useLocalUpload = config.mode !== 's3' || !s3MediaReady(config);
  if (useLocalUpload) {
    return {
      R2_ENDPOINT: 'http://local-storage.invalid',
      R2_REGION: 'auto',
      R2_ACCESS_KEY_ID: 'local-disk',
      R2_SECRET_ACCESS_KEY: 'local-disk',
      R2_MEDIA_BUCKET: 'media',
      R2_MEDIA_PUBLIC_BASE: siteUrl,
      R2_BUCKET: 'music',
      R2_PUBLIC_BASE: siteUrl,
      R2_BACKUP_BUCKET: 'backups'
    };
  }
  return {
    R2_ENDPOINT: config.endpoint,
    R2_REGION: config.region || 'auto',
    R2_ACCESS_KEY_ID: config.accessKeyId,
    R2_SECRET_ACCESS_KEY: config.secretAccessKey,
    R2_MEDIA_BUCKET: config.mediaBucket,
    R2_MEDIA_PUBLIC_BASE: config.mediaPublicBase,
    R2_BUCKET: config.musicBucket || config.mediaBucket,
    R2_PUBLIC_BASE: config.musicPublicBase || config.mediaPublicBase,
    R2_BACKUP_BUCKET: config.backupBucket || config.mediaBucket
  };
}

/** 当前生效配置的绑定映射（worker-env 的动态 getter 用这个） */
export function storageEnvBindings(siteUrl: string): StorageEnvBindings {
  return storageEnvBindingsFor(storageRuntime.snapshot().config, siteUrl);
}
