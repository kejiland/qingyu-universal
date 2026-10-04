/* ============================================================
 * 后台域契约：认证 / 媒体 / 评论管理 / 审计 / 错误日志 / 备份
 * ------------------------------------------------------------
 * 这一批是「做后台时发现缺的接口」——按计划顺手补进契约，
 * 于是后台的类型与运行时校验都来自同一份事实来源。
 *
 * 列表类接口是 SELECT * 的数据库行，这里只声明**界面真正用到**的字段：
 * zod 默认忽略多余键，因此上游加列不会误报；而声明的字段一旦消失
 * 或改类型，契约测试会立刻失败。
 * ============================================================ */
import { z } from 'zod';

/* ---------- 认证 ---------- */

export const LoginBodySchema = z.object({
  password: z.string().min(1)
});

export const LoginResponseSchema = z
  .object({
    ok: z.literal(true),
    token: z.string(),
    expiresIn: z.number(),
    mustChange: z.boolean(),
    /** 数据库里还没有管理员时，上游会生成随机初始密码并在此返回 */
    defaultPassword: z.string().optional()
  })
  .meta({ id: 'LoginResponse', description: '登录成功返回会话 token' });

export const SetupBodySchema = z.object({
  password: z.string().min(8)
});

export const MessageResponseSchema = z
  .object({ ok: z.literal(true), message: z.string() })
  .meta({ id: 'MessageResponse' });

export const PasswordBodySchema = z.object({
  current: z.string().min(1),
  password: z.string().min(8)
});

/* ---------- 媒体 ---------- */

export const MediaItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    thumb_url: z.string().optional(),
    type: z.string(),
    size: z.number(),
    created_at: z.string()
  })
  .meta({ id: 'MediaItem' });

export const MediaListResponseSchema = z
  .object({ ok: z.literal(true), media: z.array(MediaItemSchema) })
  .meta({ id: 'MediaListResponse' });

export const MediaUploadTicketSchema = z
  .object({
    ok: z.literal(true),
    uploadUrl: z.string(),
    publicUrl: z.string(),
    thumbUploadUrl: z.string(),
    thumbPublicUrl: z.string(),
    key: z.string(),
    thumbKey: z.string(),
    contentType: z.string(),
    expiresIn: z.number()
  })
  .meta({ id: 'MediaUploadTicket', description: '直传地址（S3 预签名或本地签名端点）' });

export const MediaUploadBodySchema = z.object({
  filename: z.string().min(1),
  size: z.number().positive(),
  makeThumb: z.boolean().optional()
});

/**
 * 登记媒体的请求体。
 * 注意 id **不在其中**——上游会用 'm-' + randomToken(12) 自行生成，
 * 客户端传来的 id 会被忽略。url 必须是 http/https（拒绝 data:/javascript:）。
 */
export const MediaRegisterBodySchema = z.object({
  url: z.string().regex(/^https?:\/\//i, { message: '仅支持 http/https 链接' }),
  name: z.string().optional(),
  type: z.string().optional(),
  size: z.number().optional(),
  thumbUrl: z.string().optional()
});

/**
 * 登记后的返回形状与列表**不一致**（上游历史遗留）：
 * 列表用数据库列名 thumb_url，登记返回却用驼峰 thumbUrl。
 * 这个差异是靠契约测试发现的，两个 schema 分别表达。
 */
export const MediaCreatedSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    thumbUrl: z.string().optional(),
    type: z.string(),
    size: z.number(),
    created_at: z.string()
  })
  .meta({ id: 'MediaCreated' });

export const MediaRegisterResponseSchema = z
  .object({ ok: z.literal(true), media: MediaCreatedSchema })
  .meta({ id: 'MediaRegisterResponse' });

/* ---------- 评论管理 ---------- */

/** 管理列表比公开列表多一个 post_title（LEFT JOIN posts 带出）。 */
export const CommentAdminItemSchema = z
  .object({
    id: z.string(),
    post_id: z.string(),
    author: z.string(),
    content: z.string(),
    date: z.string(),
    status: z.string(),
    parent_id: z.string().nullable().optional(),
    likes: z.number().optional(),
    pinned: z.number().optional(),
    featured: z.number().optional(),
    post_title: z.string().nullable().optional()
  })
  .meta({ id: 'CommentAdminItem' });

export const CommentAdminListResponseSchema = z
  .object({ ok: z.literal(true), comments: z.array(CommentAdminItemSchema) })
  .meta({ id: 'CommentAdminListResponse' });

export const CommentAdminQuerySchema = z.object({
  status: z.enum(['all', 'pending', 'approved']).optional()
});

/** 单条审核：status 只允许 approved / pending。 */
export const CommentUpdateBodySchema = z
  .object({
    status: z.enum(['approved', 'pending']).optional(),
    pinned: z.union([z.boolean(), z.number()]).optional(),
    featured: z.union([z.boolean(), z.number()]).optional(),
    content: z.string().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要一个要更新的字段' });

export const CommentBulkBodySchema = z.object({
  op: z.enum(['approve', 'pending', 'delete']),
  ids: z.array(z.string().min(1)).min(1).max(200)
});

export const CommentBulkResponseSchema = z
  .object({ ok: z.literal(true), updated: z.number(), op: z.string() })
  .meta({ id: 'CommentBulkResponse' });

export const CommentIdParamSchema = z.object({ id: z.string().min(1) });

/* ---------- 审计日志 ---------- */

export const AuditLogItemSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    target: z.string().optional(),
    detail: z.string().optional(),
    ip: z.string().optional(),
    created_at: z.number()
  })
  .meta({ id: 'AuditLogItem' });

export const AuditLogResponseSchema = z
  .object({
    ok: z.literal(true),
    logs: z.array(AuditLogItemSchema),
    counts: z.record(z.string(), z.number())
  })
  .meta({ id: 'AuditLogResponse' });

export const AuditQuerySchema = z.object({
  limit: z.string().optional(),
  action: z.string().optional()
});

/* ---------- 错误日志 ---------- */

export const ErrorLogItemSchema = z
  .object({
    id: z.number(),
    kind: z.string(),
    message: z.string(),
    source: z.string().optional(),
    stack: z.string().optional(),
    url: z.string().optional(),
    ua: z.string().optional(),
    hits: z.number(),
    created_at: z.number(),
    last_at: z.number().optional()
  })
  .meta({ id: 'ErrorLogItem' });

export const ErrorLogResponseSchema = z
  .object({
    ok: z.literal(true),
    total: z.number(),
    sumHits: z.number(),
    errors: z.array(ErrorLogItemSchema)
  })
  .meta({ id: 'ErrorLogResponse' });

/* ---------- 备份 ---------- */

export const BackupItemSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    size: z.number(),
    reason: z.string(),
    createdAt: z.number(),
    counts: z.record(z.string(), z.number())
  })
  .meta({ id: 'BackupItem' });

export const BackupListResponseSchema = z
  .object({
    ok: z.literal(true),
    /** 未配置备份桶（S3/R2）时为 false，此时只能查看历史记录 */
    configured: z.boolean(),
    backups: z.array(BackupItemSchema)
  })
  .meta({ id: 'BackupListResponse' });

export const BackupCreateResponseSchema = z
  .object({ ok: z.literal(true), backup: BackupItemSchema })
  .meta({ id: 'BackupCreateResponse' });

export const BackupRestoreResponseSchema = z
  .object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) })
  .meta({ id: 'BackupRestoreResponse' });