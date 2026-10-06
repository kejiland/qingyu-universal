/* ============================================================
 * 文章 / 评论 / 检索 路由表
 * ------------------------------------------------------------
 * 这些路由的处理器全部是 proxyToUpstream —— 契约层只做校验，
 * 实际处理仍然交给上游 worker。因此这里同时是：
 *   · 运行时校验规则
 *   · OpenAPI 文档的来源
 *   · 客户端类型生成的来源
 * 三份东西同一个事实来源，不会漂移。
 * ============================================================ */
import { ErrorResponseSchema, IdParamSchema, OkResponseSchema } from '../contract/common.js';
import {
  CommentCreateBodySchema,
  CommentCreateResponseSchema,
  CommentListQuerySchema,
  CommentListResponseSchema,
  CreatePostBodySchema,
  PostListQuerySchema,
  PostListResponseSchema,
  PostRelationsResponseSchema,
  PostResponseSchema,
  PostStatsBodySchema,
  PostStatsResponseSchema,
  SearchQuerySchema,
  SearchResponseSchema,
  SettingsResponseSchema,
  UpdatePostBodySchema
} from '../contract/posts.js';
import { proxyToUpstream, type ApiRoute } from '../registry.js';

const PUBLIC_CACHE = '上游可能返回 public 缓存头；写操作一律 no-store';

export const postRoutes: ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/posts',
    tags: ['文章'],
    auth: 'public',
    summary: '文章列表',
    description:
      '默认只返回已发布文章摘要（不含正文，非受保护文章附带 search 片段）。' +
      '带 full=1 或 all=1 时视为后台接口，需要管理员凭证，且会返回草稿。' +
      '带 page + per 时返回服务端分页结果。',
    request: { query: PostListQuerySchema },
    responses: {
      200: { description: `文章摘要列表。${PUBLIC_CACHE}`, schema: PostListResponseSchema },
      401: { description: '请求了后台模式但缺少有效凭证', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/posts',
    tags: ['文章'],
    auth: 'admin',
    summary: '新建文章',
    description: 'id 与 title 必填。id 已存在返回 409，请改用 PUT。status=scheduled 时必须提供 publishAt。',
    request: { body: CreatePostBodySchema },
    responses: {
      201: { description: '创建成功', schema: PostResponseSchema },
      400: { description: '缺少 id / title，或定时发布缺少发布时间', schema: ErrorResponseSchema },
      401: { description: '未授权', schema: ErrorResponseSchema },
      409: { description: 'id 已存在', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/posts/:id',
    tags: ['文章'],
    auth: 'public',
    summary: '文章详情',
    description:
      '返回完整文章（含正文）。草稿与定时发布的文章只对管理员可见，' +
      '匿名访问返回 404（避免草稿全文泄漏）。受保护文章的 content 恒为空字符串，密文在 enc 中。',
    request: { params: IdParamSchema },
    responses: {
      200: { description: '文章详情', schema: PostResponseSchema },
      404: { description: '文章不存在，或对匿名访问者不可见', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/posts/:id/relations',
    tags: ['文章'],
    auth: 'public',
    summary: '相关阅读与反向链接',
    description:
      'related 为同系列 / 同标签的推荐文章（最多 4 篇），backlinks 为引用本文的文章（最多 8 篇）。' +
      '两组都按发布时间倒序，文章不存在或未发布时返回 404。',
    request: { params: IdParamSchema },
    responses: {
      200: { description: '关联文章列表', schema: PostRelationsResponseSchema },
      404: { description: '文章不存在，或对匿名访问者不可见', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/posts/:id/stats',
    tags: ['统计'],
    auth: 'public',
    summary: '单篇文章统计',
    description: '返回该文章的阅读数与点赞数。统计行不存在时返回 0，响应带 public 缓存与 stats 标签。',
    request: { params: IdParamSchema },
    responses: {
      200: { description: '阅读 / 点赞计数', schema: PostStatsResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/posts/:id/stats',
    tags: ['统计'],
    auth: 'public',
    summary: '上报阅读或点赞',
    description:
      'action 只能是 views 或 like。服务端按 IP + 文章去重，重复上报返回 200 且 duplicated=true；' +
      '短时间大量点赞会返回 429。',
    request: { params: IdParamSchema, body: PostStatsBodySchema },
    responses: {
      200: { description: '上报结果（可能为去重后的幂等返回）', schema: PostStatsResponseSchema },
      400: { description: 'action 非法', schema: ErrorResponseSchema },
      429: { description: '上报过于频繁', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'PUT',
    path: '/api/posts/:id',
    tags: ['文章'],
    auth: 'admin',
    summary: '更新文章',
    description: '按 id 覆盖写入（UPSERT）。id 由路径决定，正文里的 id 会被忽略。未提供 date 时沿用原日期。',
    request: { params: IdParamSchema, body: UpdatePostBodySchema },
    responses: {
      200: { description: '更新成功', schema: PostResponseSchema },
      400: { description: '缺少 title，或定时发布缺少发布时间', schema: ErrorResponseSchema },
      401: { description: '未授权', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'DELETE',
    path: '/api/posts/:id',
    tags: ['文章'],
    auth: 'admin',
    summary: '删除文章',
    description: '同时原子删除该文章的评论与计数；stats_daily 历史聚合单独尽力清理。',
    request: { params: IdParamSchema },
    responses: {
      200: { description: '删除成功', schema: OkResponseSchema },
      401: { description: '未授权', schema: ErrorResponseSchema },
      404: { description: '文章不存在', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/posts/:id/comments',
    tags: ['评论'],
    auth: 'public',
    summary: '评论列表',
    description:
      '默认按「置顶 → 精选 → 点赞 → 时间」排序；sort=new 改为按时间倒序。' +
      '带 page + per 时按根评论分页，子回复跟随父评论返回。响应不缓存（no-store）。',
    request: { params: IdParamSchema, query: CommentListQuerySchema },
    responses: {
      200: { description: '评论列表', schema: CommentListResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'POST',
    path: '/api/posts/:id/comments',
    tags: ['评论'],
    auth: 'public',
    summary: '发表评论',
    description:
      '公开接口。author 与 content 必填；支持最多 3 层嵌套回复（parent_id）。' +
      '命中敏感词返回 400，内容重复返回 409。蜜罐字段（hp / website）被填写时' +
      '返回 200 且 filtered=true，但不会入库（反机器人）。',
    request: { params: IdParamSchema, body: CommentCreateBodySchema },
    responses: {
      201: { description: '发表成功（可能为待审核状态）', schema: CommentCreateResponseSchema },
      200: { description: '被反机器人机制静默丢弃', schema: CommentCreateResponseSchema },
      400: { description: '昵称/内容为空、命中敏感词、父评论无效或评论数达上限', schema: ErrorResponseSchema },
      409: { description: '重复内容', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/search',
    tags: ['检索'],
    auth: 'public',
    summary: '全文检索',
    description:
      'q 为关键词（必填）。优先使用 FTS5 trigram（支持中文子串，>=3 字符），' +
      '短词自动回退 LIKE。只返回已发布且未加密的文章。',
    request: { query: SearchQuerySchema },
    responses: {
      200: { description: '检索结果', schema: SearchResponseSchema },
      400: { description: '缺少搜索关键词', schema: ErrorResponseSchema }
    },
    handler: proxyToUpstream
  },
  {
    method: 'GET',
    path: '/api/settings',
    tags: ['设置'],
    auth: 'public',
    summary: '站点设置',
    description: '返回 site_settings 表的所有键值（值统一为字符串，JSON 需自行解析）。',
    responses: {
      200: { description: '设置键值对', schema: SettingsResponseSchema }
    },
    handler: proxyToUpstream
  }
];
