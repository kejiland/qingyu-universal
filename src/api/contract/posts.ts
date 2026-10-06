/* ============================================================
 * 文章 / 评论 / 检索 域契约
 * ------------------------------------------------------------
 * 响应 schema 是**精确**的——它们直接对应 app/functions/_lib/api-core.js
 * 里 postFromRow / searchResultFromRow 的真实输出，
 * 并由 tests/api-contract.test.ts 用真实响应逐条校验。
 *
 * 请求 schema 故意保守：上游 normalizePost() 对几乎所有字段都做
 * String()/Number() 强转，并且显式支持 tags 传「数组或逗号分隔字符串」。
 * 因此这里只拒绝**明显会写入脏数据**的类型错误，其余一律放行，
 * 避免新增校验反而拒绝掉原本可用的请求。
 * ============================================================ */
import { z } from 'zod';

/* ---------- 响应：文章 ---------- */

export const PostStatusSchema = z.enum(['published', 'draft', 'scheduled']);

/** normalizeSeo() 在四项全空时返回 {}，否则返回完整对象 → 用 partial 精确表达。 */
export const SeoSchema = z
  .object({
    title: z.string(),
    desc: z.string(),
    canonical: z.string(),
    noindex: z.boolean()
  })
  .partial().meta({ id: 'Seo' });

const PostBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  excerpt: z.string(),
  cover: z.string(),
  ogImage: z.string(),
  pinned: z.boolean(),
  protected: z.boolean(),
  category: z.string(),
  series: z.string(),
  author: z.string(),
  seriesOrder: z.number(),
  status: PostStatusSchema,
  publishAt: z.number().nullable(),
  seo: SeoSchema,
  tags: z.array(z.string())
});

/** 列表项：postFromRow 去掉 content/enc，非受保护文章额外带 search 片段。 */
export const PostSummarySchema = PostBaseSchema.extend({
  search: z.string().optional()
}).meta({ id: 'PostSummary' });

/** 详情：带正文（受保护文章 content 恒为空）与密文。 */
export const PostDetailSchema = PostBaseSchema.extend({
  content: z.string(),
  enc: z.unknown()
}).meta({ id: 'PostDetail' });

export const PostListResponseSchema = z.object({
  ok: z.literal(true),
  posts: z.array(PostSummarySchema)
}).meta({ id: 'PostListResponse' });

export const PostResponseSchema = z.object({
  ok: z.literal(true),
  post: PostDetailSchema
}).meta({ id: 'PostResponse' });

/* ---------- 请求：文章 ---------- */

const PostWriteFields = {
  title: z.string().min(1),
  date: z.string().optional(),
  excerpt: z.string().optional(),
  content: z.string().optional(),
  cover: z.string().optional(),
  ogImage: z.string().optional(),
  og_image: z.string().optional(),
  pinned: z.union([z.boolean(), z.number()]).optional(),
  protected: z.union([z.boolean(), z.number()]).optional(),
  enc: z.unknown().optional(),
  category: z.string().optional(),
  series: z.string().optional(),
  seriesOrder: z.union([z.number(), z.string()]).optional(),
  series_order: z.union([z.number(), z.string()]).optional(),
  author: z.string().optional(),
  status: PostStatusSchema.optional(),
  publishAt: z.union([z.number(), z.string()]).optional(),
  publish_at: z.union([z.number(), z.string()]).optional(),
  seo: SeoSchema.optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional()
};

export const CreatePostBodySchema = z.object({
  id: z.string().min(1),
  ...PostWriteFields
});

/** PUT 的 id 由路径决定，正文里的 id 会被上游忽略。 */
export const UpdatePostBodySchema = z.object({
  ...PostWriteFields,
  id: z.string().optional()
});

export const PostListQuerySchema = z.object({
  full: z.string().optional(),
  all: z.string().optional(),
  q: z.string().optional(),
  status: z.string().optional(),
  page: z.string().optional(),
  per: z.string().optional()
});

/* ---------- 响应：评论 ---------- */

export const CommentSchema = z.object({
  id: z.string(),
  post_id: z.string(),
  author: z.string(),
  content: z.string(),
  date: z.string(),
  status: z.string(),
  parent_id: z.string().nullable().optional(),
  likes: z.number().optional(),
  featured: z.number().optional(),
  pinned: z.number().optional(),
  /** GET 列表用 SELECT *, rowid AS rid 带出 */
  rid: z.number().optional()
}).meta({ id: 'Comment' });

export const CommentListResponseSchema = z.object({
  ok: z.literal(true),
  postId: z.string(),
  comments: z.array(CommentSchema),
  total: z.number().optional(),
  rootTotal: z.number().optional(),
  page: z.number().optional(),
  per: z.number().optional(),
  pages: z.number().optional(),
  sort: z.string().optional()
}).meta({ id: 'CommentListResponse' });

/**
 * 创建评论的返回**不含 post_id**——上游写入时把 postId 单独传参，
 * 而响应里的 comment 对象只有下列字段（与列表项的 SELECT * 不同）。
 * 这个差异是靠 strict 模式的响应校验发现的，不是靠读代码猜出来的。
 */
export const CommentCreatedSchema = z.object({
  id: z.string(),
  author: z.string(),
  content: z.string(),
  date: z.string(),
  status: z.string(),
  parent_id: z.string().nullable()
}).meta({ id: 'CommentCreated' });

/** 蜜罐命中时上游返回 comment: null + filtered: true（静默丢弃机器人）。 */
export const CommentCreateResponseSchema = z.object({
  ok: z.literal(true),
  comment: CommentCreatedSchema.nullable(),
  filtered: z.boolean().optional()
}).meta({ id: 'CommentCreateResponse' });

export const CommentCreateBodySchema = z.object({
  author: z.string().min(1),
  content: z.string().min(1),
  parent_id: z.string().optional(),
  hp: z.string().optional(),
  website: z.string().optional(),
  ts: z.union([z.number(), z.string()]).optional()
});

export const CommentListQuerySchema = z.object({
  sort: z.enum(['new', 'hot']).optional(),
  page: z.string().optional(),
  per: z.string().optional()
});

/* ---------- 响应：检索 ---------- */

export const SearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  excerpt: z.string(),
  cover: z.string(),
  ogImage: z.string(),
  pinned: z.boolean(),
  protected: z.boolean(),
  category: z.string(),
  series: z.string(),
  seriesOrder: z.number(),
  status: PostStatusSchema,
  publishAt: z.null(),
  tags: z.array(z.string()),
  snippet: z.string()
}).meta({ id: 'SearchResult' });

export const SearchResponseSchema = z.object({
  ok: z.literal(true),
  query: z.string(),
  engine: z.string(),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasMore: z.boolean(),
  results: z.array(SearchResultSchema)
}).meta({ id: 'SearchResponse' });

export const SearchQuerySchema = z.object({
  q: z.string().min(1),
  page: z.string().optional(),
  pageSize: z.string().optional()
});

/* ---------- 响应：站点设置 ---------- */

export const SettingsResponseSchema = z.object({
  ok: z.literal(true),
  settings: z.record(z.string(), z.string())
}).meta({ id: 'SettingsResponse' });
/* ---------- 关联阅读 / 单篇统计 ---------- */

export const PostRelationItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  excerpt: z.string(),
  cover: z.string(),
  ogImage: z.string(),
  pinned: z.boolean(),
  tags: z.array(z.string()),
  series: z.string(),
  seriesOrder: z.number()
}).meta({ id: 'PostRelationItem' });

export const PostRelationsResponseSchema = z.object({
  ok: z.literal(true),
  postId: z.string(),
  related: z.array(PostRelationItemSchema),
  backlinks: z.array(PostRelationItemSchema)
}).meta({ id: 'PostRelationsResponse' });

export const PostStatsBodySchema = z.object({
  action: z.enum(['views', 'like']),
  ref: z.string().optional()
}).meta({ id: 'PostStatsBody' });

export const PostStatsResponseSchema = z.object({
  ok: z.literal(true),
  postId: z.string(),
  stats: z.object({ likes: z.number(), views: z.number() }),
  duplicated: z.boolean().optional()
}).meta({ id: 'PostStatsResponse' });
