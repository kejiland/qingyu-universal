/* ============================================================
 * 文章「数据库行 → 前端形态」的映射
 * ------------------------------------------------------------
 * app.js 读到的是 /api/posts 返回的 JSON（或静态 posts.js）。
 * 两处映射必须同形，否则前端会在「接口数据」与「静态数据」之间来回跳：
 *   · `app/public/app.js` → getConfig()/getPublishedPosts() 读的是
 *     `window.BLOG_POSTS`（由 posts.min.js 注入）与 `api/posts` 的合并结果；
 *   · 上游 `app/functions/_lib/api-core.js` → postFromRow()。
 *
 * 这里复刻上游 postFromRow()，字段名/类型逐一对齐（id/title/date/excerpt/
 * cover/ogImage/content/pinned/protected/enc/category/series/author/
 * seriesOrder/status/publishAt/seo/tags）。
 *
 * 另提供 `toPublicSummary()`：对齐上游 GET /api/posts 的**公开摘要**形态 ——
 * 受保护文章不下发正文，其余文章把正文前 800 字塞进 `search`，并删除
 * `content` / `enc`。posts.min.js 用这个形态，避免把全文塞进每个 HTML 的引用中。
 * ============================================================ */
import type { PostRow } from '../seo/meta.js';

export interface ClientPostRow extends PostRow {
  enc?: string | null;
  author?: string | null;
  series_order?: number | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as T;
    } catch {
      /* 坏 JSON 按兜底值处理 */
    }
  }
  return fallback;
}

/** 上游 normalizePostStatus()：缺省 published；有 publish_at 且在未来 → scheduled。 */
function normalizeStatus(row: ClientPostRow): string {
  const status = str(row.status) || 'published';
  if (status !== 'published') return status;
  const at = str(row.publish_at ?? '');
  if (at && Date.parse(at) > Date.now()) return 'scheduled';
  return 'published';
}

/** 数据库行 → app.js 期望的文章对象（对齐上游 postFromRow）。 */
export function toClientPost(row: ClientPostRow): Record<string, unknown> {
  const isProtected = Boolean(row.protected);
  const enc = isProtected ? safeJson<unknown>(row.enc, null) : null;
  const seo = safeJson<Record<string, unknown>>(row.seo, {});
  const at = str(row.publish_at ?? '');

  return {
    id: str(row.id),
    title: str(row.title),
    date: str(row.date),
    excerpt: str(row.excerpt),
    cover: str(row.cover),
    ogImage: str(row.og_image),
    content: isProtected ? '' : str(row.content),
    pinned: Boolean(row.pinned),
    protected: isProtected,
    enc,
    category: str(row.category),
    series: str(row.series),
    author: str(row.author),
    seriesOrder: Number(row.series_order) || 0,
    status: normalizeStatus(row),
    publishAt: at || null,
    seo,
    tags: safeJson<unknown[]>(row.tags, []).map((t) => str(t)).filter(Boolean)
  };
}

/**
 * 公开摘要形态（对齐上游 GET /api/posts）：
 * 非加密文章把正文前 800 字放进 `search`（前端摘要/统计字数的兜底数据源），
 * 随后删除 `content` 与 `enc`。
 */
export function toPublicSummary(row: ClientPostRow): Record<string, unknown> {
  const post = toClientPost(row);
  if (!post.protected) {
    const content = String(post.content ?? '');
    if (content) post.search = content.slice(0, 800);
  }
  delete post.content;
  delete post.enc;
  return post;
}
