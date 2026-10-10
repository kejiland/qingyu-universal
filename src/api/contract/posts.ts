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
/** stats=1 时随列表下发的阅读 / 点赞 / 评论计数（见 attachStatsBatch） */
export const PostStatsBriefSchema = z
  .object({
    views: z.number(),
    likes: z.number(),
    comments: z.number()
  })
  .meta({ id: 'PostStatsBrief' });

export const PostSummarySchema = PostBaseSchema.extend({
  search: z.string().optional(),
  stats: PostStatsBriefSchema.optional()
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

/* ---------- 请求：文章 ----------
 *
 * 【重要】契约层是**只读校验**，不能比上游更严。
 * 上游 normalizePost()（app/functions/_lib/api-core.js）对每个字段都做强制转换：
 *   · 文本类   String(x || '').trim()
 *   · 布尔类   !!x
 *   · 数字类   Math.max(0, Math.floor(Number(x) || 0))
 *   · status   normalizePostStatus：不是 'draft' / 'scheduled' 的一律当 'published'
 *   · publishAt normalizePublishAt：不是有限正数的一律 null
 *   · tags     数组逐项 String()，非数组按 [,，] 切字符串
 * 也就是说**任何 JSON 值（含 null）上游都吃得下去**，真正的合法性由它自己判定
 * （只拦三项：缺 id、缺 title、定时发布却没给时间）。
 *
 * 所以下面每个字段都声明成「上游确实能转换的形态」，把 null 也包含进来。
 * ⚠️ 别把这些 union 收窄回 z.string() —— 2026-10-09 就栽过一次：
 *    后台编辑器恒定带 publishAt，非定时文章传的是 null（admin.js 的 savePost），
 *    契约只写了 number|string，于是**发布文章直接 400**：
 *    「保存失败参数校验失败：body.publishAt: Invalid input」。
 */
/** 上游按 String() 转换的字段 */
const LooseText = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** 上游按 !! 转换的字段（0/''/null 都算假） */
const LooseFlag = z.union([z.boolean(), z.number(), z.string(), z.null()]);
/** 上游按 Number() 转换的字段 */
const LooseNumber = z.union([z.number(), z.string(), z.null()]);
/** 上游 normalizeSeo 接受对象或 JSON 字符串；null / 空串等价于「无覆盖」 */
const LooseSeo = z.union([SeoSchema, z.string(), z.null()]);
/** 上游：数组逐项 String()，非数组（含 null）按 [,，] 切字符串 */
const LooseTags = z.union([z.array(z.unknown()), z.string(), z.null()]);

const PostWriteFields = {
  title: LooseText.optional(),
  date: LooseText.optional(),
  excerpt: LooseText.optional(),
  content: LooseText.optional(),
  cover: LooseText.optional(),
  ogImage: LooseText.optional(),
  og_image: LooseText.optional(),
  pinned: LooseFlag.optional(),
  protected: LooseFlag.optional(),
  // 加密文章的密文对象；未加密时编辑器传 null。形态由上游判断，不做约束。
  enc: z.unknown().optional(),
  category: LooseText.optional(),
  series: LooseText.optional(),
  seriesOrder: LooseNumber.optional(),
  series_order: LooseNumber.optional(),
  author: LooseText.optional(),
  // 上游把非 draft/scheduled 的**任何**值（含 null）都当 published
  status: z.union([PostStatusSchema, z.null()]).optional(),
  publishAt: LooseNumber.optional(),
  publish_at: LooseNumber.optional(),
  seo: LooseSeo.optional(),
  tags: LooseTags.optional()
};

/* id 同样是 String() 转换的：数字也能用。真正的「缺 id / 缺 title」
 * 由上游以 400「缺少 id 或 title」拦下 —— 错误信息比契约层更贴近业务，
 * 所以这里不重复设 min(1)。 */
const LooseId = z.union([z.string(), z.number()]);

export const CreatePostBodySchema = z.object({
  id: LooseId,
  ...PostWriteFields
}).meta({ id: 'CreatePostBody' });

/** PUT 的 id 由路径决定，正文里的 id 会被上游忽略。 */
export const UpdatePostBodySchema = z.object({
  ...PostWriteFields,
  id: LooseId.optional()
}).meta({ id: 'UpdatePostBody' });

export const PostListQuerySchema = z.object({
  full: z.string().optional(),
  all: z.string().optional(),
  q: z.string().optional(),
  status: z.string().optional(),
  page: z.string().optional(),
  per: z.string().optional(),
  stats: z.string().optional()
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
  // parent_id 必须是 nullable：公开站前端发表顶层评论时显式传 null
  // （app/public/app.js 的 saveComment：`parentId = parentId || null`），
  // 上游也用真值判断把 null 当作「无父评论」。写成 .optional() 会让
  // 顶层评论在契约层被 400 拒掉。
  parent_id: z.string().nullable().optional(),
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
