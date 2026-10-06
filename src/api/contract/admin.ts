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
 * 客户端传来的 id 会被忽略。url 必须为 http/https 或站内 /media、/music、/og 地址（拒绝 data:/javascript:）。
 */
export const MediaRegisterBodySchema = z.object({
  url: z.string().regex(/^(?:https?:\/\/|\/(?:media|music|og)\/)/i, { message: '仅支持 http/https 或站内 /media、/music、/og 链接' }),
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

export const BackupContentResponseSchema = z
  .record(z.string(), z.unknown())
  .meta({ id: 'BackupContentResponse' });

export const BackupCreateResponseSchema = z
  .object({ ok: z.literal(true), backup: BackupItemSchema })
  .meta({ id: 'BackupCreateResponse' });

export const BackupRestoreResponseSchema = z
  .object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) })
  .meta({ id: 'BackupRestoreResponse' });

/* ---------- 订阅者 ---------- */

export const SubscriberItemSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    status: z.enum(['active', 'pending', 'unsubscribed']),
    locale: z.string().optional(),
    created_at: z.number(),
    confirmed_at: z.number().nullable().optional(),
    unsubscribed_at: z.number().nullable().optional(),
    last_notified_at: z.number().nullable().optional(),
    groups: z.array(z.string())
  })
  .meta({ id: 'SubscriberItem' });

export const SubscriberListResponseSchema = z
  .object({
    ok: z.literal(true),
    /** 是否配置了发信（SMTP 或 Resend）；未配置时只能查看名单 */
    enabled: z.boolean(),
    counts: z.object({
      total: z.number(),
      active: z.number(),
      pending: z.number(),
      unsubscribed: z.number()
    }),
    groups: z.array(z.object({ name: z.string(), count: z.number() })),
    subscribers: z.array(SubscriberItemSchema)
  })
  .meta({ id: 'SubscriberListResponse' });

export const SubscriberGroupListResponseSchema = z
  .object({ ok: z.literal(true), groups: z.array(z.object({ name: z.string(), count: z.number() })) })
  .meta({ id: 'SubscriberGroupListResponse' });

export const SubscriberBroadcastResponseSchema = z
  .object({ ok: z.literal(true), queued: z.number(), groups: z.array(z.string()) })
  .meta({ id: 'SubscriberBroadcastResponse' });
/** 群发邮件请求：subject 与 body（正文）必填，groups 留空表示发给全部已确认订阅者 */
export const SubscriberBroadcastBodySchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1).max(20000),
    groups: z.array(z.string()).optional()
  })
  .meta({ id: 'SubscriberBroadcastBody', description: '群发请求体；body 为纯文本正文' });

/** 编辑单个订阅者的分组（用逗号分隔即可新建 / 改名，无需独立分组表） */
export const SubscriberUpdateBodySchema = z
  .object({ groups: z.array(z.string()).max(50) })
  .meta({ id: 'SubscriberUpdateBody', description: '订阅者分组列表' });

export const SubscriberUpdateResponseSchema = z
  .object({ ok: z.literal(true), groups: z.array(z.string()) })
  .meta({ id: 'SubscriberUpdateResponse', description: '返回更新后的分组' });

/* ---------- Webmention ---------- */

export const WebmentionItemSchema = z
  .object({
    id: z.number(),
    source: z.string(),
    target: z.string(),
    post_id: z.string().nullable().optional(),
    author_name: z.string().optional(),
    author_url: z.string().optional(),
    title: z.string().optional(),
    excerpt: z.string().optional(),
    status: z.string(),
    created_at: z.number(),
    updated_at: z.number()
  })
  .meta({ id: 'WebmentionItem' });

export const WebmentionListResponseSchema = z
  .object({
    ok: z.literal(true),
    total: z.number(),
    mentions: z.array(WebmentionItemSchema)
  })
  .meta({ id: 'WebmentionListResponse', description: '注意：数组字段名是 mentions，不是 webmentions' });

/* ---------- 统计 ---------- */

/* ---------- 分享图（OG）上传签名 ---------- */

export const OgUploadBodySchema = z.object({
  postId: z.string().min(1).max(160)
}).meta({ id: 'OgUploadBody' });

export const OgUploadResponseSchema = z.object({
  ok: z.literal(true),
  uploadUrl: z.string(),
  publicUrl: z.string(),
  key: z.string(),
  expiresIn: z.number()
}).meta({ id: 'OgUploadResponse' });

export const StatsTrendResponseSchema = z
  .object({
    ok: z.literal(true),
    trend: z.array(z.object({ date: z.string(), views: z.number(), likes: z.number() }))
  })
  .meta({ id: 'StatsTrendResponse' });

const SourceRow = z.object({ name: z.string(), views: z.number(), count: z.number().optional() });

export const StatsSourcesResponseSchema = z
  .object({
    ok: z.literal(true),
    days: z.number(),
    since: z.string(),
    referrers: z.array(SourceRow),
    devices: z.array(SourceRow),
    countries: z.array(SourceRow),
    platforms: z.array(SourceRow),
    vendors: z.array(SourceRow),
    refTotal: z.number(),
    devTotal: z.number(),
    countryTotal: z.number(),
    platformTotal: z.number(),
    vendorTotal: z.number()
  })
  .meta({ id: 'StatsSourcesResponse' });
