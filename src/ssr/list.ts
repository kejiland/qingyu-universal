/* ============================================================
 * 公开站 SSR：首页（列表 + 标签行 + 站点概览 + 分页）
 * ------------------------------------------------------------
 * 与 src/ssr/post.ts 同一套思路：渲染进 #app，app.js 启动后原地替换。
 * 这里逐块复刻 app.js 的 renderHome() / renderHomeTagRow() /
 * renderHomeStats() / homeListHtml() / renderCard() / renderPostThumb()，
 * 任何一处结构或 class 不同，app.js 接管时都会整块换掉 —— 肉眼可见地抖动。
 *
 *   main.container.page-fade
 *     > .list-head > h2.page-title
 *     > .current-tag（?tag= / ?category= 时）
 *     > .home-tags
 *     > section.home-stats
 *     > #homeBody > #listContainer[.list-nopager] > a.post-card…
 *     > .pager
 * ============================================================ */
import { escapeHtml, stripMarkdown, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { svgIcon } from './icons.js';
import { formatDate } from './format.js';
import type { ChromeData } from './chrome.js';

/** 词典里首页用到的文案（与 locales/zh-CN.json 逐字一致）。 */
const ZH = {
  latest: '最新发布',
  categoryLabel: '标签',
  statsTitle: '站点概览',
  statsPosts: '文章',
  statsCategories: '分类',
  statsTags: '标签',
  statsWords: '总字数',
  statsUpdated: '最近更新',
  pin: '置顶',
  noPosts: '这里还没有文章。',
  noPostsFiltered: '这里暂时还没有文章',
  noPostsCloud: '你还未发布文章',
  goWrite: '去写一篇',
  prev: '上一页',
  next: '下一页'
} as const;

export interface HomeQuery {
  tag?: string;
  category?: string;
  page?: number;
}

/** app.js normalizeTags()：JSON 数组或逗号分隔字符串都接受。 */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    /* 非 JSON：按逗号分隔（与 app.js 的兜底分支一致） */
  }
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** app.js sortPosts()：置顶优先 → 日期倒序 → id 倒序。 */
function sortPosts(a: PostRow, b: PostRow): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  const ad = String(a.date ?? '');
  const bd = String(b.date ?? '');
  if (ad === bd) {
    const ai = String(a.id);
    const bi = String(b.id);
    return ai < bi ? 1 : ai > bi ? -1 : 0;
  }
  return ad < bd ? 1 : ad > bd ? -1 : 0;
}

/** 文章正文：受保护文章在 app.js 侧永远是空串（明文不出库）。 */
const bodyOf = (post: PostRow): string =>
  post.protected ? '' : String(post.content ?? '');

/** app.js renderPostThumb()：有封面/正文首图 → 图片；否则主题渐变占位。 */
function renderThumb(post: PostRow, index: number): string {
  const url = String(post.cover ?? '').trim() || firstImageFrom(String(post.content ?? ''));
  const title = String(post.title ?? '');
  if (url) {
    const isFirst = index < 2;
    const pri = isFirst ? 'high' : 'low';
    const lazy = isFirst ? 'eager' : 'lazy';
    return (
      '<span class="post-thumb has-img"><img src="' + escapeHtml(url) +
      '" alt="' + escapeHtml(title) + '" loading="' + lazy + '" decoding="async" fetchpriority="' + pri +
      '" referrerpolicy="no-referrer" onload="this.classList.add(\'thumb-in\')" onerror="this.remove()"></span>'
    );
  }
  return '<span class="post-thumb ph"><span class="post-thumb-ph">' + svgIcon('image', 26) + '</span></span>';
}

/** app.js firstImageFrom()：`![alt](url)` 或 `<img src="url">` 的第一张图。 */
function firstImageFrom(content: string): string {
  const md = /!\[[^\]]*\]\(([^)\s]+)/.exec(content);
  if (md) return md[1] as string;
  const tag = /<img[^>]+src=["']([^"']+)["']/i.exec(content);
  return tag ? (tag[1] as string) : '';
}

/** app.js renderCard()。 */
function renderCard(post: PostRow, index: number): string {
  const badge = post.pinned ? `<span class="pin">${svgIcon('pin', 13)} 置顶</span>` : '';
  const tags = parseTags(post.tags)
    .map((t) => `<span>${escapeHtml(t)}</span>`)
    .join('');
  const excerpt =
    String(post.excerpt ?? '') ||
    stripMarkdown(bodyOf(post)).slice(0, 100);
  // 云端可 AI 摘要的文章：摘要位打标记，aiFillSlots 之后异步替换
  const aiExcerpt = !post.protected
    ? ` data-ai-excerpt="${escapeHtml(String(post.id))}"`
    : '';

  return (
    `<a class="post-card" href="/posts/${encodeURIComponent(String(post.id))}/">` +
    '<div class="post-card-main">' +
    `<div class="meta"><span class="date">${escapeHtml(formatDate(post.date))}</span>${badge}</div>` +
    `<h2>${escapeHtml(String(post.title ?? ''))}</h2>` +
    `<div class="excerpt"${aiExcerpt}>${escapeHtml(excerpt)}</div>` +
    // 恒渲染：无标签时留空容器，保证卡片等高
    `<div class="mini-tags">${tags}</div>` +
    '</div>' +
    renderThumb(post, index) +
    '</a>'
  );
}

/** app.js renderHomeTagRow()：位于「最新发布」标题下方、概览卡上方。 */
function renderHomeTagRow(posts: PostRow[], activeTag: string, allow: string[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const post of posts) {
    for (const tag of parseTags(post.tags)) {
      if (!counts.has(tag)) {
        counts.set(tag, 0);
        order.push(tag);
      }
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  // 后台「首页显示的标签」白名单；为空 = 全部显示（activeTag 始终保留）
  let list = order;
  if (allow.length) {
    const set = new Set(allow);
    list = order.filter((x) => set.has(x) || x === activeTag);
  }
  if (!list.length) return '';

  const chips = list
    .map((tag) => {
      const on = tag === activeTag ? ' active' : '';
      return (
        `<a class="home-tag${on}" href="/?tag=${encodeURIComponent(tag)}" data-home-tag>` +
        `<span class="home-tag-text">${escapeHtml(tag)}</span>` +
        `<span class="home-tag-count">${counts.get(tag)}</span></a>`
      );
    })
    .join('');

  return (
    '<div class="home-tags">' +
    `<span class="home-tags-label">${escapeHtml(ZH.categoryLabel)}</span>` +
    `<div class="home-tags-track">${chips}</div>` +
    '</div>'
  );
}

/** app.js renderHomeStats()：文章数 / 分类 / 标签 / 总字数 / 最近更新。 */
function renderHomeStats(posts: PostRow[]): string {
  if (!posts.length) return '';
  const cats = new Set<string>();
  const tags = new Set<string>();
  let words = 0;
  let latest = '';
  let latestId = '';

  for (const post of posts) {
    const cat = String(post.category ?? '').trim();
    if (cat) cats.add(cat);
    for (const tag of parseTags(post.tags)) tags.add(tag);
    const text = stripMarkdown(bodyOf(post));
    // 中文按字计、英文按词计
    const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
    const other = text
      .replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9'\u00c0-\u024f]+/g);
    words += cjk + (other ? other.length : 0);
    const d = formatDate(post.date ?? post.updated_at ?? '');
    if (d && d > latest) {
      latest = d;
      latestId = String(post.id ?? '');
    }
  }

  const wordText =
    words >= 10000
      ? (words / 10000).toFixed(1) + 'w'
      : words >= 1000
        ? (words / 1000).toFixed(1) + 'k'
        : String(words);

  const cells: string[] = [
    `<div class="home-stat"><span class="home-stat-v">${posts.length}</span><span class="home-stat-k">${escapeHtml(ZH.statsPosts)}</span></div>`,
    `<div class="home-stat"><span class="home-stat-v">${cats.size}</span><span class="home-stat-k">${escapeHtml(ZH.statsCategories)}</span></div>`,
    `<div class="home-stat"><span class="home-stat-v">${tags.size}</span><span class="home-stat-k">${escapeHtml(ZH.statsTags)}</span></div>`,
    `<div class="home-stat"><span class="home-stat-v">${escapeHtml(wordText)}</span><span class="home-stat-k">${escapeHtml(ZH.statsWords)}</span></div>`
  ];
  if (latest) {
    const href = latestId ? `/posts/${encodeURIComponent(latestId)}/` : '';
    cells.push(
      `<a class="home-stat home-stat-link" href="${escapeHtml(href)}">` +
        `<span class="home-stat-v">${escapeHtml(latest)}</span>` +
        `<span class="home-stat-k">${escapeHtml(ZH.statsUpdated)}</span></a>`
    );
  }

  return (
    `<section class="home-stats" aria-label="${escapeHtml(ZH.statsTitle)}">` +
    `<div class="home-stats-title">${svgIcon('star', 14)}<span>${escapeHtml(ZH.statsTitle)}</span></div>` +
    `<div class="home-stats-grid">${cells.join('')}</div>` +
    '</section>'
  );
}

/** app.js pagerHtml()：单页不渲染翻页器。 */
function pagerHtml(page: number, totalPages: number, query: HomeQuery): string {
  if (totalPages <= 1) return '';
  const pg = (p: number): string => {
    const parts: string[] = [];
    if (query.tag) parts.push(`tag=${encodeURIComponent(query.tag)}`);
    if (query.category) parts.push(`category=${encodeURIComponent(query.category)}`);
    parts.push(`page=${p}`);
    return '/?' + parts.join('&');
  };
  const out: string[] = [];
  if (page > 1) out.push(`<a class="pager-btn" href="${escapeHtml(pg(page - 1))}">${escapeHtml(ZH.prev)}</a>`);
  out.push(
    `<span class="pager-info">第 ${page} / ${totalPages} 页</span>`
  );
  if (page < totalPages) {
    out.push(`<a class="pager-btn" href="${escapeHtml(pg(page + 1))}">${escapeHtml(ZH.next)}</a>`);
  }
  return '<div class="pager">' + out.join('') + '</div>';
}

/**
 * 渲染首页主体（与 app.js 的 renderHome 结构同构）。
 * `posts` 应是**全部已发布文章**（概览卡与标签行统计的是全量，不是当前页）。
 */
export function renderHomeContent(
  posts: PostRow[],
  _site: SiteIdentity,
  chrome: ChromeData,
  query: HomeQuery = {}
): string {
  const all = posts
    .filter((p) => (p.status ?? 'published') === 'published')
    .slice()
    .sort(sortPosts);

  const tag = String(query.tag ?? '');
  const cat = String(query.category ?? '');

  let html =
    '<main class="container page-fade">' +
    `<div class="list-head"><h2 class="page-title">${escapeHtml(ZH.latest)}</h2></div>`;

  if (tag) {
    html +=
      `<div class="current-tag"><span class="tag-chip">${escapeHtml(tag)} ` +
      `<a class="tag-clear" href="/">✕</a></span></div>`;
  }
  if (cat) {
    html +=
      `<div class="current-tag"><span class="tag-chip">${svgIcon('tag', 13)} ${escapeHtml(cat)} ` +
      `<a class="tag-clear" href="/">✕</a></span></div>`;
  }

  html += renderHomeTagRow(all, tag, chrome.homeTags);
  html += renderHomeStats(all);

  let filtered = all;
  if (tag) filtered = filtered.filter((p) => parseTags(p.tags).includes(tag));
  if (cat) filtered = filtered.filter((p) => String(p.category ?? '') === cat);

  const pageSize = chrome.pageSize;
  const total = filtered.length;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  let page = Number(query.page) || 1;
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const pageItems = pageSize > 0 ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;

  let list = pageItems.map((post, index) => renderCard(post, index)).join('');
  if (!pageItems.length) {
    // 带筛选的空列表属于「该筛选下暂无内容」；不带筛选时用云端空态文案
    const msg = tag || cat ? ZH.noPostsFiltered : ZH.noPostsCloud;
    list =
      '<div class="empty"><div class="big">' + svgIcon('doc', 36) + '</div>' +
      `<p>${escapeHtml(msg)}</p></div>`;
  }

  const pager = pagerHtml(page, totalPages, { tag, category: cat });
  html +=
    `<div id="homeBody"><div id="listContainer"${pager ? '' : ' class="list-nopager"'}>` +
    list +
    '</div>' + pager + '</div>';
  html += '</main>';
  return html;
}

/** 首页需要展示的文章：全部已发布（概览卡/标签行要统计全量）。 */
export const HOME_POSTS_SQL =
  "SELECT * FROM posts WHERE COALESCE(status, 'published') = 'published' " +
  'ORDER BY COALESCE(pinned, 0) DESC, date DESC, id DESC';
