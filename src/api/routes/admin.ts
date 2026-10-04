/* ============================================================
 * 后台域路由表：认证 / 媒体 / 评论管理 / 审计 / 错误日志 / 备份
 * ------------------------------------------------------------
 * 全部是 proxyToUpstream：契约层只校验，业务仍由上游处理。
 * 新增接口只需在这里登记 + 在 contract/ 写 schema。
 * ============================================================ */
import { ErrorResponseSchema, OkResponseSchema } from '../contract/common.js';
import {
  AuditLogResponseSchema,
  AuditQuerySchema,
  BackupCreateResponseSchema,
  BackupListResponseSchema,
  BackupRestoreResponseSchema,
  CommentAdminListResponseSchema,
  CommentAdminQuerySchema,
  CommentBulkBodySchema,
  CommentBulkResponseSchema,
  CommentIdParamSchema,
  CommentUpdateBodySchema,
  ErrorLogResponseSchema,
  LoginBodySchema,
  LoginResponseSchema,
  MediaListResponseSchema,
  MediaRegisterBodySchema,
  MediaRegisterResponseSchema,
  MediaUploadBodySchema,
  MediaUploadTicketSchema,
  MessageResponseSchema,
  PasswordBodySchema,
  SetupBodySchema
} from '../contract/admin.js';
import { proxyToUpstream, type ApiRoute } from '../registry.js';

const AUTH_ERRORS = {
  401: { description: '未授权或凭证失效', schema: ErrorResponseSchema }
} as const;

const IMAGE_EXTS = 'png / jpg / jpeg / webp / gif / svg / avif / bmp / ico';

export const adminRoutes: ApiRoute[] = [
  /* ---------- 认证 ---------- */
  {
    method: 'POST',
    path: '/api/admin/login',
    tags: ['认证'],
    auth: 'public',
    summary: '管理员登录',
    description:
      '密码登录，成功返回 7 天会话 token。若数据库中还没有管理员，上游会生成随机初始密码' +
      '并在 defaultPassword 中返回（此时 mustChange=true）。若配置了 BLOG_ADMIN_SETUP_KEY，' +
      '请求头带 X-Setup-Key 可跳过登录失败限流（应急通道）。',
    request: { body: LoginBodySchema },
    responses: {
      200: { description: '登录成功', schema: LoginResponseSchema },
      401: { description: '密码错误或账户被锁定', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/admin/setup',
    tags: ['认证'],
    auth: 'public',
    summary: '初始化 / 重设管理员密码',
    description:
      '首次初始化与重置共用此接口。配置了 BLOG_ADMIN_SETUP_KEY 时必须携带匹配的 X-Setup-Key 头。' +
      '已有密码时（重置场景）响应为 409 并提示先删除 admin_auth 行。',
    request: { body: SetupBodySchema },
    responses: {
      201: { description: '密码已设置', schema: MessageResponseSchema },
      400: { description: '密码少于 8 位', schema: ErrorResponseSchema },
      403: { description: '安装密钥无效', schema: ErrorResponseSchema },
      409: { description: '密码已存在，需先清除才能重置', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/admin/logout',
    tags: ['认证'],
    auth: 'admin',
    summary: '退出登录',
    description: '撤销当前会话 token。',
    responses: {
      200: { description: '已退出', schema: OkResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/admin/password',
    tags: ['认证'],
    auth: 'admin',
    summary: '修改密码',
    description: '需要提供当前密码。成功后原有会话失效，需重新登录。',
    request: { body: PasswordBodySchema },
    responses: {
      200: { description: '密码已更新', schema: MessageResponseSchema },
      400: { description: '新密码少于 8 位', schema: ErrorResponseSchema },
      401: { description: '当前密码不正确', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },

  /* ---------- 媒体 ---------- */
  {
    method: 'GET',
    path: '/api/media',
    tags: ['媒体'],
    auth: 'admin',
    summary: '媒体列表',
    description: '返回媒体库元数据（倒序）。文件本体在对象存储或本地磁盘。',
    responses: {
      200: { description: '媒体列表', schema: MediaListResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/media/upload-url',
    tags: ['媒体'],
    auth: 'admin',
    summary: '签发直传地址',
    description:
      `返回可 PUT 的地址与对应的公开 URL（S3 预签名或本地签名端点）。` +
      `支持格式：${IMAGE_EXTS}；单张 ≤ 10MB。makeThumb=true 时额外返回缩略图地址。` +
      '未配置对象存储时由本地磁盘适配器接管，行为一致。',
    request: { body: MediaUploadBodySchema },
    responses: {
      200: { description: '直传地址', schema: MediaUploadTicketSchema },
      400: { description: '格式不支持或大小超限', schema: ErrorResponseSchema },
      503: { description: '存储未配置', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/media',
    tags: ['媒体'],
    auth: 'admin',
    summary: '登记媒体元数据',
    description: '直传完成后调用，把对象信息写入 media 表。id 由服务端生成，请求体里的 id 会被忽略。',
    request: { body: MediaRegisterBodySchema },
    responses: {
      201: { description: '登记成功', schema: MediaRegisterResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'DELETE',
    path: '/api/media/:id',
    tags: ['媒体'],
    auth: 'admin',
    summary: '删除媒体',
    description: '同时删除原图与缩略图对象，再移除数据库记录。',
    request: { params: CommentIdParamSchema },
    responses: {
      200: { description: '已删除', schema: OkResponseSchema },
      404: { description: '媒体不存在', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },

  /* ---------- 评论管理 ---------- */
  {
    method: 'GET',
    path: '/api/comments',
    tags: ['评论'],
    auth: 'admin',
    summary: '评论管理列表',
    description: '跨文章返回全部评论（含待审核），并带出所属文章标题。按时间倒序，不分页。',
    request: { query: CommentAdminQuerySchema },
    responses: {
      200: { description: '评论列表', schema: CommentAdminListResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'PUT',
    path: '/api/comments/:id',
    tags: ['评论'],
    auth: 'admin',
    summary: '审核 / 编辑评论',
    description: '仅允许修改 status（approved / pending）、pinned、featured、content 中至少一项。',
    request: { params: CommentIdParamSchema, body: CommentUpdateBodySchema },
    responses: {
      200: { description: '已更新', schema: OkResponseSchema },
      400: { description: '字段非法或为空', schema: ErrorResponseSchema },
      404: { description: '评论不存在', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'DELETE',
    path: '/api/comments/:id',
    tags: ['评论'],
    auth: 'admin',
    summary: '删除评论',
    responses: {
      200: { description: '已删除', schema: OkResponseSchema },
      404: { description: '评论不存在', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/admin/comments/bulk',
    tags: ['评论'],
    auth: 'admin',
    summary: '批量审核 / 删除评论',
    description: '单次最多 200 条，在一个事务里执行。',
    request: { body: CommentBulkBodySchema },
    responses: {
      200: { description: '批量完成', schema: CommentBulkResponseSchema },
      400: { description: '参数不完整', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },

  /* ---------- 审计与错误日志 ---------- */
  {
    method: 'GET',
    path: '/api/admin/audit',
    tags: ['日志'],
    auth: 'admin',
    summary: '操作审计日志',
    description: '最近的操作记录（默认 200 条，最多 500）。可按 action 过滤，并返回各动作计数。',
    request: { query: AuditQuerySchema },
    responses: {
      200: { description: '审计日志', schema: AuditLogResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/admin/errors',
    tags: ['日志'],
    auth: 'admin',
    summary: '错误日志',
    description: '按指纹聚合的前端错误（最近 200 条），含总条数与总命中次数。',
    responses: {
      200: { description: '错误日志', schema: ErrorLogResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },

  /* ---------- 备份 ---------- */
  {
    method: 'GET',
    path: '/api/admin/backups',
    tags: ['备份'],
    auth: 'admin',
    summary: '备份列表',
    description: '返回备份记录与保留策略内的条目（最多 30 份）。configured=false 表示未配置备份桶，只能查看历史。',
    responses: {
      200: { description: '备份列表', schema: BackupListResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/admin/backups',
    tags: ['备份'],
    auth: 'admin',
    summary: '创建备份',
    description: '把全部业务表导出为 JSON 并上传到备份桶；未配置备份桶时返回 503。',
    responses: {
      201: { description: '备份已创建', schema: BackupCreateResponseSchema },
      503: { description: '未配置备份桶', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'DELETE',
    path: '/api/admin/backups/:id',
    tags: ['备份'],
    auth: 'admin',
    summary: '删除备份',
    responses: {
      200: { description: '已删除', schema: OkResponseSchema },
      404: { description: '备份不存在', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/admin/backups/:id/restore',
    tags: ['备份'],
    auth: 'admin',
    summary: '从备份恢复',
    description: '危险操作：会按备份内容覆盖现有数据表。',
    responses: {
      200: { description: '恢复完成', schema: BackupRestoreResponseSchema },
      503: { description: '未配置备份桶', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: proxyToUpstream
  }
];