/* ============================================================
 * 后台「设置 → 存储」契约（自托管新增，上游没有这一组接口）
 * ------------------------------------------------------------
 * 与 /api/settings 的区别：那里是公开 GET 且带缓存头，这里必须管理员会话。
 * 密钥永不明文回传：读接口只给 secretAccessKeyMasked + hasSecretAccessKey。
 * ============================================================ */
import { z } from 'zod';

export const StorageModeSchema = z.enum(['local', 's3']);

/** 配置来源：db=后台保存过，env=环境变量兜底，none=两者都没有 */
export const StorageConfigSourceSchema = z.enum(['db', 'env', 'none']);

export const StorageCountsSchema = z
  .object({
    media: z.number(),
    music: z.number(),
    og: z.number(),
    total: z.number()
  })
  .meta({ id: 'StorageCounts', description: '本机磁盘上各类对象的数量' });

export const StorageConfigResponseSchema = z
  .object({
    ok: z.literal(true),
    /** 用户选择的目标存储方式（界面上的单选值） */
    mode: StorageModeSchema,
    endpoint: z.string(),
    region: z.string(),
    accessKeyId: z.string(),
    /** 是否已配置 Secret（不回传明文） */
    hasSecretAccessKey: z.boolean(),
    /** 打码后的 Secret，仅用于界面提示当前生效的是哪一把 */
    secretAccessKeyMasked: z.string(),
    mediaBucket: z.string(),
    mediaPublicBase: z.string(),
    musicBucket: z.string(),
    musicPublicBase: z.string(),
    backupBucket: z.string(),
    source: StorageConfigSourceSchema,
    /** 云端配置是否完整到「能签发上传」 */
    s3Ready: z.boolean(),
    /** 选了对象存储但配置不完整，当前正降级用本机磁盘 */
    degraded: z.boolean(),
    /** 本机磁盘上传根目录（服务端路径，仅供展示排查） */
    uploadDir: z.string(),
    localCounts: StorageCountsSchema,
    /** 环境变量里提供了哪些字段（供界面提示「部署时已预填」） */
    envProvided: z.object({
      endpoint: z.boolean(),
      accessKeyId: z.boolean(),
      secretAccessKey: z.boolean(),
      mediaBucket: z.boolean(),
      mediaPublicBase: z.boolean()
    })
  })
  .meta({ id: 'StorageConfigResponse', description: '存储配置（密钥打码）' });

export const StorageConfigUpdateBodySchema = z
  .object({
    mode: StorageModeSchema.optional(),
    endpoint: z.string().optional(),
    region: z.string().optional(),
    accessKeyId: z.string().optional(),
    /**
     * 留空或不传 = 保持原密钥不变（避免用户只改桶名时把密钥清掉）。
     * 契约层遵循「拒绝保守」：这里不强制 min(1)，空串按「不修改」处理。
     */
    secretAccessKey: z.string().optional(),
    /** 显式清除密钥（与 secretAccessKey 留空区分开） */
    clearSecretAccessKey: z.boolean().optional(),
    mediaBucket: z.string().optional(),
    mediaPublicBase: z.string().optional(),
    musicBucket: z.string().optional(),
    musicPublicBase: z.string().optional(),
    backupBucket: z.string().optional()
  })
  .meta({ id: 'StorageConfigUpdateBody' });

/** 连通性测试：允许用「表单里还没保存」的候选值直接测 */
export const StorageTestBodySchema = StorageConfigUpdateBodySchema.meta({ id: 'StorageTestBody' });

export const StorageTestResponseSchema = z
  .object({
    /** 测试失败也返回 200 + ok:false：这是「连通性结论」而不是接口错误 */
    ok: z.boolean(),
    /** 实际测的是哪一圈：本机磁盘 或 对象存储 */
    target: z.enum(['local', 's3']),
    bucket: z.string(),
    key: z.string(),
    ms: z.number(),
    error: z.string().optional()
  })
  .meta({ id: 'StorageTestResponse', description: '存储连通性测试结果' });

export const StorageMigrateBodySchema = z
  .object({
    /** 迁移完成后删除本地文件（默认 false：保留副本，桶不可达还能兜底） */
    deleteLocal: z.boolean().optional(),
    /** 单次最多处理多少个对象（默认 500，防止大站把请求拖到超时） */
    limit: z.number().int().positive().max(20000).optional()
  })
  .meta({ id: 'StorageMigrateBody' });

export const StorageMigrateDetailSchema = z
  .object({
    key: z.string(),
    status: z.enum(['migrated', 'skipped', 'failed']),
    bytes: z.number().optional(),
    error: z.string().optional()
  })
  .meta({ id: 'StorageMigrateDetail' });

export const StorageMigrateResponseSchema = z
  .object({
    /** 全部成功才算 ok；部分失败时为 false，但已成功的对象不会回滚 */
    ok: z.boolean(),
    /** 本地磁盘上待迁移的对象总数（含本次未处理的） */
    total: z.number(),
    migrated: z.number(),
    skipped: z.number(),
    failed: z.number(),
    /** 被改写成云端外链的数据库行数 */
    rewroteRows: z.number(),
    deletedLocal: z.number(),
    details: z.array(StorageMigrateDetailSchema),
    error: z.string().optional()
  })
  .meta({ id: 'StorageMigrateResponse', description: '本地文件迁移到对象存储的结果' });
