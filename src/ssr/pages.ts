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
import type { AppDatabase } from '../types.js';
import { escapeHtml, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { imageProxyUrl } from '../lib/image-url.js';
import { renderMarkdown } from './post.js';

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

/* ---------- 关于 / 友链 / 热门 ---------- */

/** 读取 site_settings 里的 JSON 配置（关于页取 site，友链取 footer）。 */
export async function readSettingJson<T>(db: AppDatabase, key: string, fallback: T): Promise<T> {
  try {
    const row = await db.first<{ v?: string }>('SELECT v FROM site_settings WHERE k = ?', key);
    if (!row || !row.v) return fallback;
    const value = JSON.parse(String(row.v));
    return value && typeof value === 'object' ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 关于页：正文来自后台「站点信息 → 关于页面内容」（Markdown）。 */
export function renderAboutContent(markdown: string, site: SiteIdentity): string {
  const text = String(markdown || '').trim();
  const body = text ? renderMarkdown(text) : '<p class="ab-muted">还没有填写关于页面内容。</p>';
  return (
    '<main class="container page-fade">' +
    '<h2 class="page-title">关于</h2>' +
    '<div class="about-card card"><div class="article about-intro">' + body + '</div>' +
    '<h3>' + escapeHtml(site.name) + '</h3><p>' + escapeHtml(site.description) + '</p>' +
    '</div></main>'
  );
}

export interface FriendLink {
  text?: string;
  url?: string;
}

/** 友链页：数据来自 footer.links，与 app.js 的读取路径一致。 */
export function renderLinksContent(links: FriendLink[]): string {
  const valid = (Array.isArray(links) ? links : []).filter((l) => l && l.url);
  const cards = valid
    .map(function (l) {
      return (
        '<a class="friend-card" href="' + escapeHtml(String(l.url)) + '" target="_blank" rel="noopener nofollow">' +
        '<span class="friend-name">' + escapeHtml(String(l.text || l.url)) + '</span></a>'
      );
    })
    .join('');
  const body = valid.length
    ? '<div class="friend-grid">' + cards + '</div>'
    : '<p class="ab-muted">还没有添加友链。</p>';
  return '<main class="container page-fade"><h2 class="page-title">友链</h2>' + body + '</main>';
}

/** 热门页：按浏览量倒序，数据来自 posts LEFT JOIN stats。 */
export function renderPopularContent(posts: PostRow[]): string {
  const cards = posts
    .map(function (post, index) {
      const views = Number((post as unknown as { views?: number }).views) || 0;
      const meta = parseTags(post.tags).slice(0, 3).join(' / ') || String(post.date || '');
      return (
        '<a class="popular-card" href="/posts/' + encodeURIComponent(post.id) + '/">' +
        '<span class="popular-rank">' + (index + 1) + '</span>' +
        '<div class="popular-main">' +
        '<div class="popular-card-title">' + escapeHtml(post.title || '') + '</div>' +
        '<div class="popular-card-meta">' + escapeHtml(meta) + '</div></div>' +
        '<div class="popular-metrics"><span>浏览 ' + views + '</span></div>' +
        '</a>'
      );
    })
    .join('');
  return (
    '<main class="container page-fade">' +
    '<div class="list-head popular-head"><div><h2 class="page-title">热门</h2></div>' +
    '<div class="popular-ranges">' +
    '<button class="popular-range active" data-popular-range="all">全部</button>' +
    '<button class="popular-range" data-popular-range="30">近 30 天</button>' +
    '<button class="popular-range" data-popular-range="7">近 7 天</button>' +
    '</div></div>' +
    (cards || '<p class="ab-muted">还没有足够的数据。</p>') +
    '</main>'
  );
}

/** 热门页的查询：join stats 取浏览量。 */
export const POPULAR_POSTS_SQL =
  'SELECT p.*, COALESCE(s.views, 0) AS views FROM posts p ' +
  'LEFT JOIN stats s ON s.post_id = p.id ' +
  "WHERE COALESCE(p.status, 'published') = 'published' " +
  'ORDER BY views DESC, p.date DESC LIMIT 20';

/* ---------- 系列页 ----------
 * 此前 /series 与 /guestbook 没有 SSR：服务端只返回空外壳（启动动画），
 * 要等 app.js 延迟加载完毕（实测 3~5s）才有内容，首屏是长时间空白 ——
 * 与其余公开页（首页/归档/标签/分类/关于/友链/热门）不一致。
 * 这里补上，结构与 app.js 的 renderSeriesList() 对齐，接管后原地替换无跳动。 */
export const SERIES_POSTS_SQL =
  'SELECT id, title, date, cover, series FROM posts ' +
  "WHERE COALESCE(status, 'published') = 'published' AND COALESCE(series, '') <> '' " +
  'ORDER BY date DESC';

export function renderSeriesContent(posts: PostRow[]): string {
  const rows = Array.isArray(posts) ? posts : [];
  const groups = new Map<string, PostRow[]>();
  for (const post of rows) {
    const name = String(post.series ?? '').trim();
    if (!name) continue;
    const bucket = groups.get(name);
    if (bucket) bucket.push(post);
    else groups.set(name, [post]);
  }

  if (!groups.size) {
    return (
      '<main class="container page-fade"><h2 class="page-title">系列</h2>' +
      '<div class="empty"><p>还没有创建任何系列。</p></div></main>'
    );
  }

  const cards = [...groups.entries()]
    .map(function (entry, index) {
      const name = entry[0];
      const items = entry[1];
      const preview = items
        .slice(0, 4)
        .map((p) => String(p.title ?? ''))
        .join(' · ');
      const first = items[0];
      const thumb = first ? renderSeriesThumb(first, index) : '';
      return (
        '<a class="post-card" href="/series/' + encodeURIComponent(name) + '"><div class="post-card-main">' +
        '<div class="meta"><span class="date">' + items.length + ' 篇</span>' +
        '<span class="pin">系列</span></div>' +
        '<h2>' + escapeHtml(name) + '</h2>' +
        '<div class="excerpt">' + escapeHtml(preview) + '</div>' +
        '<div class="mini-tags"><span>组成部分</span></div>' +
        '</div>' + thumb + '</a>'
      );
    })
    .join('');

  return (
    '<main class="container page-fade"><h2 class="page-title">系列</h2>' +
    '<p class="admin-head-sub" style="margin:-8px 0 20px">按主题把长文串成系列，方便连续阅读。</p>' +
    '<div class="list-container">' + cards + '</div></main>'
  );
}

function renderSeriesThumb(post: PostRow, index: number): string {
  // 同 src/ssr/list.ts：外链封面走本站反代，避免浏览器直连境外图床。
  const cover = imageProxyUrl(String(post.cover ?? '').trim());
  if (!cover) return '';
  // 与 src/ssr/list.ts 的 renderThumb 同款保护：外链图床挂死时不能把破图留在首屏
  const priority = index < 2 ? ' fetchpriority="high"' : ' fetchpriority="low" loading="lazy"';
  return (
    '<div class="post-thumb"><img src="' + escapeHtml(cover) + '" alt="" decoding="async"' +
    priority + ' referrerpolicy="no-referrer" onerror="this.remove()"></div>'
  );
}

/* ---------- 留言板 ----------
 * 留言是实时数据（且要登录态/评论接口），SSR 只出**页面框架**：
 * 标题 + 说明 + 分区切换 + 空列表容器。真实留言由 app.js 接管后拉取填充。
 * 这样首屏不再是空白，也不必为实时数据做缓存策略。 */
export function renderGuestbookContent(): string {
  return (
    '<main class="container page-fade">' +
    '<div class="guestbook">' +
    '<header class="guestbook-head">' +
    '<div class="guestbook-head-icon"></div>' +
    '<div><h2 class="page-title">留言板</h2>' +
    '<p class="guestbook-sub">想说的话、发现的问题、对项目的建议，都可以留在这里。</p></div>' +
    '</header>' +
    '<div class="guestbook-tabs" id="gbTabs">' +
    '<button class="gb-tab active" data-kind="note" type="button">留言</button>' +
    '<button class="gb-tab" data-kind="idea" type="button">项目优化方案</button>' +
    '</div>' +
    '<div class="guestbook-list" id="gbList"></div>' +
    '</div></main>'
  );
}