/* ============================================================
 * 公开站 SSR：归档页 / 标签页 / 分类页
 * ------------------------------------------------------------
 * 与首页、文章页同一套渐进增强：渲染进 #app，app.js 原地替换。
 * 标记对齐 app.js 的 renderArchive() / renderTags() / renderCategories()：
 *   main.container.page-fade > h2.page-title + 内容容器
 *
 * 注意：标签与分类的链接指向 /?tag=xxx 与 /?category=xxx（首页带查询），
 * 不是独立路径——筛选后的列表由首页 SSR 负责。
 * ============================================================ */
import { escapeHtml, type PostRow, type SiteIdentity } from '../seo/meta.js';

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 从 ISO 日期串取出年月；解析失败返回 null（该文章不进归档分组）。 */
function yearMonth(date: string): { year: string; month: number } | null {
  const match = /^(\d{4})-(\d{2})/.exec(String(date ?? '').trim());
  if (!match) return null;
  return { year: match[1]!, month: Number(match[2]!) };
}

/* ---------- 归档页 ---------- */

export function renderArchiveContent(posts: PostRow[], _site: SiteIdentity): string {
  // 按 年 → 月 分组，年与月都倒序（最新在前）
  const years = new Map<string, Map<number, PostRow[]>>();
  for (const post of posts) {
    const ym = yearMonth(String(post.date ?? ''));
    if (!ym) continue;
    if (!years.has(ym.year)) years.set(ym.year, new Map());
    const months = years.get(ym.year)!;
    if (!months.has(ym.month)) months.set(ym.month, []);
    months.get(ym.month)!.push(post);
  }

  const orderedYears = [...years.keys()].sort((a, b) => b.localeCompare(a));
  const blocks = orderedYears.map((year) => {
    const months = years.get(year)!;
    const monthBlocks = [...months.keys()]
      .sort((a, b) => b - a)
      .map((month) => {
        const list = months.get(month)!;
        const items = list
          .map(
            (post) =>
              `<li><a href="/posts/${encodeURIComponent(post.id)}/">${escapeHtml(post.title ?? '')}</a></li>`
          )
          .join('');
        return (
          `<div class="archive-month"><h3>${month} 月 <span class="count">${list.length} 篇</span></h3>` +
          `<ul>${items}</ul></div>`
        );
      })
      .join('');
    return `<div class="archive-year"><h2>${escapeHtml(year)} 年</h2>${monthBlocks}</div>`;
  });

  const body = blocks.length
    ? blocks.join('')
    : '<p class="ab-muted">还没有文章。</p>';

  return (
    '<main class="container page-fade">' +
    '<h2 class="page-title">归档</h2>' +
    body +
    '</main>'
  );
}

/* ---------- 标签 / 分类云 ---------- */

function cloudContent(
  posts: PostRow[],
  title: string,
  emptyText: string,
  param: 'tag' | 'category',
  pick: (post: PostRow) => string[]
): string {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const name of pick(post)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const chips = names
    .map(
      (name) =>
        `<a class="cloud-chip" href="/?${param}=${encodeURIComponent(name)}">${escapeHtml(name)}` +
        `<span class="cloud-count">${counts.get(name)}</span></a>`
    )
    .join('');

  const body = names.length ? `<div class="tag-cloud">${chips}</div>` : `<p class="ab-muted">${emptyText}</p>`;

  return `<main class="container page-fade"><h2 class="page-title">${title}</h2>${body}</main>`;
}

export function renderTagsContent(posts: PostRow[], _site: SiteIdentity): string {
  return cloudContent(posts, '标签', '还没有标签。', 'tag', (post) => parseTags(post.tags));
}

export function renderCategoriesContent(posts: PostRow[], _site: SiteIdentity): string {
  return cloudContent(posts, '分类', '还没有分类。', 'category', (post) => {
    const value = String(post.category ?? '').trim();
    return value ? [value] : [];
  });
}

/** 归档需要全部已发布文章（不分页、置顶不影响年月分组，按日期倒序） */
export const ARCHIVE_POSTS_SQL =
  "SELECT id, title, date, category, tags FROM posts WHERE COALESCE(status, 'published') = 'published' ORDER BY date DESC";
/** 首页的标签/分类筛选：标签存的是 JSON 数组字符串，需要解析后比对。 */
export function filterPosts(
  posts: PostRow[],
  query: { tag?: string | null; category?: string | null }
): PostRow[] {
  const { tag, category } = query;
  if (!tag && !category) return posts;
  return posts.filter((post) => {
    if (tag) return parseTags(post.tags).includes(tag);
    return String(post.category ?? '').trim() === category;
  });
}
