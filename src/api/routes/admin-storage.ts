/* ============================================================
 * 后台「设置 → 存储」（自托管新增，上游没有这一组接口）
 * ------------------------------------------------------------
 * 与 admin.ts 里那批「代理给上游」的路由不同，这四条是**本地实现**：
 * 直接读写 storage_config 表 + 复用上游的 SigV4 逻辑真机探活 + 迁移本机文件。
 *
 * 鉴权：adminGuard()（src/api/admin-auth.ts），与 AI 配置页共用一份实现。
 *
 * 为什么密钥不复用 /api/settings：那里是**匿名可读且带缓存头**的公开接口，
 * 放 Secret Access Key 等于把桶交出去。独立表 storage_config + 本组鉴权接口是底线。
 * ============================================================ */
import {
  StorageConfigResponseSchema,
  StorageConfigUpdateBodySchema,
  StorageMigrateBodySchema,
  StorageMigrateResponseSchema,
  StorageTestBodySchema,
  StorageTestResponseSchema
} from '../contract/storage.js';
import { ErrorResponseSchema } from '../contract/common.js';
import type { ApiContext, ApiRoute } from '../registry.js';
import { auditFromContext } from '../audit.js';
import { ADMIN_AUTH_ERRORS, adminGuard } from '../admin-auth.js';
import {
  loadStorageConfigFromDb,
  maskSecret,
  mergeStorageConfig,
  s3MediaReady,
  saveStorageConfigToDb,
  storageEnvBindingsFor,
  storageRuntime,
  type StorageConfig
} from '../../bindings/storage-config.js';
import { countLocalObjects, localSelfTest, objectSelfTest } from '../../bindings/object-ops.js';
import { migrateLocalObjects } from '../../bindings/object-migrate.js';
import type { WorkerEnv } from '../../types.js';

const AUTH_ERRORS = ADMIN_AUTH_ERRORS;

const trimBase = (value: unknown): string => String(value ?? '').trim().replace(/\/+$/, '');
const trim = (value: unknown): string => String(value ?? '').trim();

/** 当前生效配置（环境变量默认值 + 数据库覆盖） */
async function effective(ctx: ApiContext): Promise<ReturnType<typeof mergeStorageConfig>> {
  const fromDb = await loadStorageConfigFromDb(ctx.db);
  return mergeStorageConfig(storageRuntime.defaults(), fromDb);
}

/**
 * 从请求体抽出「要改的字段」。
 * PUT 拿它写库；连通性测试拿它做**候选配置**（`{...current, ...patch}`）——
 * 同一份映射保证「测的」和「存的」永远是一套语义，不会出现测通了却存不进去。
 */
function readPatch(body: Record<string, unknown> | null): Partial<StorageConfig> {
  const patch: Partial<StorageConfig> = {};
  if (!body) return patch;
  if (body.mode === 'local' || body.mode === 's3') patch.mode = body.mode;
  if (typeof body.endpoint === 'string') patch.endpoint = trimBase(body.endpoint);
  // 区域留空按 S3 惯例回落 auto（R2 只认 auto）
  if (typeof body.region === 'string') patch.region = trim(body.region) || 'auto';
  if (typeof body.accessKeyId === 'string') patch.accessKeyId = trim(body.accessKeyId);
  if (typeof body.mediaBucket === 'string') patch.mediaBucket = trim(body.mediaBucket);
  if (typeof body.mediaPublicBase === 'string') patch.mediaPublicBase = trimBase(body.mediaPublicBase);
  if (typeof body.musicBucket === 'string') patch.musicBucket = trim(body.musicBucket);
  if (typeof body.musicPublicBase === 'string') patch.musicPublicBase = trimBase(body.musicPublicBase);
  if (typeof body.backupBucket === 'string') patch.backupBucket = trim(body.backupBucket);
  // 留空 = 保持原密钥；显式清除要用 clearSecretAccessKey
  if (typeof body.secretAccessKey === 'string' && trim(body.secretAccessKey)) {
    patch.secretAccessKey = trim(body.secretAccessKey);
  }
  if (body.clearSecretAccessKey === true) patch.secretAccessKey = '';
  return patch;
}

/** 响应体：密钥只出现打码值 */
async function payload(ctx: ApiContext): Promise<Record<string, unknown>> {
  const snap = storageRuntime.snapshot();
  const defaults = storageRuntime.defaults();
  const { config } = snap;
  return {
    ok: true,
    mode: snap.mode,
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    hasSecretAccessKey: !!config.secretAccessKey,
    secretAccessKeyMasked: maskSecret(config.secretAccessKey),
    mediaBucket: config.mediaBucket,
    mediaPublicBase: config.mediaPublicBase,
    musicBucket: config.musicBucket,
    musicPublicBase: config.musicPublicBase,
    backupBucket: config.backupBucket,
    source: snap.source,
    s3Ready: snap.s3Ready,
    degraded: snap.degraded,
    uploadDir: snap.uploadDir,
    localCounts: await countLocalObjects(snap.uploadDir),
    envProvided: {
      endpoint: !!defaults.endpoint,
      accessKeyId: !!defaults.accessKeyId,
      secretAccessKey: !!defaults.secretAccessKey,
      mediaBucket: !!defaults.mediaBucket,
      mediaPublicBase: !!defaults.mediaPublicBase
    }
  };
}

/**
 * 用「候选配置」构造一个临时 env 交给上游的 presignPut。
 *
 * 关键点：**不能**直接把 ctx.env 传进去 —— 它当前生效的是已保存的配置，
 * 而且它的 R2_* 是动态 getter（改不了值），LOCAL_STORAGE 也还在（会走本地分支）。
 * 这里只挑上游签名真正会读的几个键，并故意不设 LOCAL_STORAGE，
 * 于是 music.js 的 presignPut 必然走 SigV4 真签名分支。
 */
function envForCandidate(config: StorageConfig): WorkerEnv {
  const bindings = storageEnvBindingsFor(config, '');
  return {
    R2_ENDPOINT: bindings.R2_ENDPOINT,
    R2_REGION: bindings.R2_REGION,
    R2_ACCESS_KEY_ID: bindings.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: bindings.R2_SECRET_ACCESS_KEY,
    R2_MEDIA_BUCKET: bindings.R2_MEDIA_BUCKET,
    R2_MEDIA_PUBLIC_BASE: bindings.R2_MEDIA_PUBLIC_BASE,
    R2_BUCKET: bindings.R2_BUCKET,
    R2_PUBLIC_BASE: bindings.R2_PUBLIC_BASE,
    R2_BACKUP_BUCKET: bindings.R2_BACKUP_BUCKET
  } as unknown as WorkerEnv;
}

/* ---------- 路由 ---------- */

export const adminStorageRoutes: ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/admin/storage',
    tags: ['存储'],
    auth: 'admin',
    summary: '读取存储配置',
    description:
      '返回当前生效的存储配置。Secret Access Key 只回传打码值（secretAccessKeyMasked）与是否已配置' +
      '（hasSecretAccessKey），明文永不出服务端。' +
      'degraded=true 表示已选择对象存储但配置不完整，当前正降级使用本机磁盘。',
    responses: {
      200: { description: '当前配置', schema: StorageConfigResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      return ctx.c.json(await payload(ctx), 200);
    }
  },
  {
    method: 'PUT',
    path: '/api/admin/storage',
    tags: ['存储'],
    auth: 'admin',
    summary: '保存存储配置',
    description:
      '部分更新：只写传入的字段。secretAccessKey 留空表示保持原密钥不变（避免只改桶名时把密钥清掉），' +
      '需要清空请显式传 clearSecretAccessKey=true。' +
      '保存后立即刷新运行时绑定，无需重启服务；MODE=local 表示新上传写入本机磁盘。',
    request: { body: StorageConfigUpdateBodySchema },
    responses: {
      200: { description: '保存后的生效配置', schema: StorageConfigResponseSchema },
      400: { description: '参数非法', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;

      const body = (await ctx.c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (body === null || typeof body !== 'object') {
        return ctx.c.json({ error: '缺少配置对象' }, 400);
      }
      const patch = readPatch(body);

      /* 审计用：只记「改了哪些字段」，绝不记密钥本身 */
      const changed = Object.keys(patch);
      const keyState = patch.secretAccessKey === undefined ? 'kept' : (patch.secretAccessKey ? 'set' : 'cleared');
      if (changed.length) {
        try {
          await saveStorageConfigToDb(ctx.db, patch);
        } catch (e) {
          return ctx.c.json({ error: `保存失败：${(e as Error)?.message || e}` }, 500);
        }
      }

      // 保存后立刻用数据库真实值重建运行时 → env.R2_* / LOCAL_STORAGE 的动态 getter 立即反映
      const merged = await effective(ctx);
      storageRuntime.set(merged.config, merged.source);

      const snap = storageRuntime.snapshot();
      await auditFromContext(
        ctx,
        'storage.update',
        changed.join(',') || '(无变化)',
        `mode=${snap.config.mode} endpoint=${snap.config.endpoint || '-'} key=${keyState}`
          + `${snap.degraded ? ' degraded=1' : ''}`
      );
      return ctx.c.json(await payload(ctx), 200);
    }
  },
  {
    method: 'POST',
    path: '/api/admin/storage/test',
    tags: ['存储'],
    auth: 'admin',
    summary: '测试存储连通性',
    description:
      '按 mode 决定测哪一圈：local 往上传目录写一个探针文件再删（能发现挂载点只读 / 磁盘满）；' +
      's3 用表单里的**候选值**（不传则用已保存值）真签一次 SigV4 并写删一个探针对象。' +
      '测试失败也返回 200（ok=false + error），因为它表达的是「连通性结论」而不是接口错误。',
    request: { body: StorageTestBodySchema },
    responses: {
      200: { description: '测试结果', schema: StorageTestResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;

      const body = (await ctx.c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const candidate: StorageConfig = { ...(await effective(ctx)).config, ...readPatch(body) };

      if (candidate.mode !== 's3') {
        const result = await localSelfTest(storageRuntime.snapshot().uploadDir);
        return ctx.c.json(
          {
            ok: result.ok,
            target: 'local' as const,
            bucket: result.bucket,
            key: result.key,
            ms: result.ms,
            ...(result.error ? { error: result.error } : {})
          },
          200
        );
      }

      if (!s3MediaReady(candidate)) {
        const missing: string[] = [];
        if (!candidate.endpoint) missing.push('端点');
        if (!candidate.accessKeyId) missing.push('Access Key ID');
        if (!candidate.secretAccessKey) missing.push('Secret Access Key');
        if (!candidate.mediaBucket) missing.push('媒体桶');
        if (!candidate.mediaPublicBase) missing.push('媒体公开域名');
        return ctx.c.json(
          {
            ok: false,
            target: 's3' as const,
            bucket: candidate.mediaBucket,
            key: '',
            ms: 0,
            error: `配置不完整，还缺：${missing.join('、')}`
          },
          200
        );
      }

      const result = await objectSelfTest(ctx.appDir, envForCandidate(candidate), candidate.mediaBucket);
      return ctx.c.json(
        {
          ok: result.ok,
          target: 's3' as const,
          bucket: result.bucket,
          key: result.key,
          ms: result.ms,
          ...(result.error ? { error: result.error } : {})
        },
        200
      );
    }
  },
  {
    method: 'POST',
    path: '/api/admin/storage/migrate',
    tags: ['存储'],
    auth: 'admin',
    summary: '把本机磁盘上的文件迁移到对象存储',
    description:
      '逐对象上传，并且**只有确认某个对象已进桶**才会把引用它的数据库行改写成云端外链，' +
      '因此不会出现「库里指向云、云上没这个文件」的坏引用。' +
      '默认保留本地副本（deleteLocal=false）——迁移中途失败或桶不可达时本地仍是兜底。' +
      '本地读取路由 /media/* 常驻挂载，未迁移的老文件照常可访问，不存在中间态 404。',
    request: { body: StorageMigrateBodySchema },
    responses: {
      200: { description: '迁移结果', schema: StorageMigrateResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;

      const body = (await ctx.c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const deleteLocal = body?.deleteLocal === true;
      const limit = typeof body?.limit === 'number' && Number.isFinite(body.limit) ? body.limit : undefined;

      const report = await migrateLocalObjects(ctx.db, ctx.env, ctx.appDir, { deleteLocal, limit });
      await auditFromContext(
        ctx,
        'storage.migrate',
        `local→${report.ok ? 'cloud' : 'partial'}`,
        `total=${report.total} migrated=${report.migrated} failed=${report.failed} rows=${report.rewroteRows}`
      );
      return ctx.c.json(report, 200);
    }
  }
];
