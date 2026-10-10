/* ============================================================
 * 公开站 SSR：首页文章列表
 * ------------------------------------------------------------
 * 与 src/ssr/post.ts 同一套思路：渲染进 #app，app.js 启动后原地替换。
 * 结构与上游 app.js 的 renderHome() / renderCard() / renderPostThumb() /
 * renderHomeTagRow() / pagerHtml() 严格同构：
 *   main.container.page-fade
 *     > .list-head > h2.page-title
 *     > .current-tag（?tag= / ?category= 筛选条）
 *     > .home-tags（标签行 + 计数）
 *     > .ad-slot（后台配置的首页广告）
 *     > #homeBody > #listContainer(.list-nopager) > a.post-card + .pager
 *
 * 不同构的代价：app.js 接管后会整块重绘，SSR 的优化全部作废，
 * 用户还会看到一次肉眼可见的「布局跳变」。
 * ============================================================ */
import { escapeHtml, stripMarkdown, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { imageProxyUrl } from '../lib/image-url.js';
import { formatDate } from './format.js';

/* 首页固定文案：与 app/public/locales/zh-CN.json 保持一致，
 * SSR 阶段没有运行时 i18n，这里只取首页会用到的那几句。 */
const T = {
  latest: '最新发布',
  noPosts: '这里还没有文章。',
  noPostsFiltered: '这里暂时还没有文章',
  categoryLabel: '标签',
  adLabel: '广告',
  pin: '置顶',
  thumbnailAlt: '文章缩略图',
  prev: '上一页',
  next: '下一页'
} as const;

/** 与 app.js svgIcon() 同款的描边图标（只需首页用到的那几个）。 */
const SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

const ICON_PATHS: Record<string, string> = {
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  image:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l4.5-4.5 3 3L16 13l4 4"/>',
  tag: '<path d="M3 3h7l11 11-7 7L3 10V3z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M9.5 12h5M9.5 15h5"/>'
};

function svgIcon(name: keyof typeof ICON_PATHS | string, size: number): string {
  return (
    `<svg width="${size}" height="${size}" ${SVG_ATTRS} aria-hidden="true" focusable="false">` +
    (ICON_PATHS[name] ?? '') +
    '</svg>'
  );
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 正文 Markdown / HTML 里的第一张图（与 app.js firstImageFrom() 同规则）。 */
function firstImageFrom(content: unknown): string {
  const s = String(content ?? '');
  const md = /!\[[^\]]*\]\(\s*(https?:[^)\s]+)\s*\)/i.exec(s);
  if (md) return md[1];
  const html = /<img[^>]+src=["'](https?:[^"']+)["']/i.exec(s);
  return html ? html[1] : '';
}

/** 文章缩略图：与 app.js renderPostThumb() 同构。
 *  · 无图时给主题渐变占位（.post-thumb.ph），卡片右侧不会留一块空白；
 *  · 外链封面改走本站反代（/api/img），首次加载省掉一次跨洋 DNS+TLS；
 *  · 前两张 eager + fetchpriority=high，其余 lazy；
 *  · onload 加 .thumb-in 走 CSS 淡入，onerror 兜底摘掉破图。 */
function renderPostThumb(post: PostRow, index: number): string {
  const raw = String(post.cover ?? '').trim() || firstImageFrom(post.content);
  const url = imageProxyUrl(raw);
  const title = String(post.title ?? '');
  if (url) {
    const eager = index < 2;
    return (
      `<span class="post-thumb has-img"><img src="${escapeHtml(url)}"` +
      ` alt="${escapeHtml(title || T.thumbnailAlt)}"` +
      ` loading="${eager ? 'eager' : 'lazy'}" decoding="async"` +
      ` fetchpriority="${eager ? 'high' : 'low'}" referrerpolicy="no-referrer"` +
      ` onload="this.classList.add('thumb-in')" onerror="this.remove()"></span>`
    );
  }
  return `<span class="post-thumb ph"><span class="post-thumb-ph">${svgIcon('image', 26)}</span></span>`;
}

function renderCard(post: PostRow, index: number): string {
  const tags = parseTags(post.tags).slice(0, 3);
  const badges = post.pinned ? `<span class="pin">${svgIcon('pin', 13)} ${T.pin}</span>` : '';
  // 摘要：优先 excerpt，其次正文去 Markdown；长度与上游一致（100 字）
  const excerpt =
    String(post.excerpt ?? '').trim() || stripMarkdown(String(post.content ?? '')).slice(0, 100);
  const tagHtml = tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');

  return (
    `<a class="post-card" href="/posts/${encodeURIComponent(post.id)}/">` +
    '<div class="post-card-main">' +
    `<div class="meta"><span class="date">${escapeHtml(formatDate(post.date))}</span>${badges}</div>` +
    `<h2>${escapeHtml(post.title ?? '')}</h2>` +
    `<div class="excerpt">${escapeHtml(excerpt)}</div>` +
    // 恒渲染：无标签时留空容器，保证卡片等高
    `<div class="mini-tags">${tagHtml}</div>` +
    '</div>' +
    renderPostThumb(post, index) +
    '</a>'
  );
}

/** 首页标签行：标签 + 计数；后台勾选的 homeTags 为白名单（空 = 全显示）。 */
function renderHomeTagRow(posts: PostRow[], activeTag: string, allow: string[]): string {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of parseTags(post.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let order = [...counts.keys()];
  if (allow.length) {
    const allowSet = new Set(allow);
    order = order.filter((tag) => allowSet.has(tag) || tag === activeTag);
  }
  if (!order.length) return '';
  const chips = order
    .map((tag) => {
      const on = tag === activeTag;
      return (
        `<a class="home-tag${on ? ' active' : ''}" href="/?tag=${encodeURIComponent(tag)}" data-home-tag>` +
        `<span class="home-tag-text">${escapeHtml(tag)}</span>` +
        `<span class="home-tag-count">${counts.get(tag) ?? 0}</span></a>`
      );
    })
    .join('');
  return (
    `<div class="home-tags"><span class="home-tags-label">${T.categoryLabel}</span>` +
    `<div class="home-tags-track">${chips}</div></div>`
  );
}

/** 翻页器：query 形式保留标签与页码（链接可前进/后退）；单页不渲染。 */
function pagerHtml(page: number, totalPages: number, tag: string, category: string): string {
  if (totalPages <= 1) return '';
  const link = (p: number): string => {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    if (category) q.set('category', category);
    q.set('page', String(p));
    return `/?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page > 1) parts.push(`<a class="pager-btn" href="${escapeHtml(link(page - 1))}">${T.prev}</a>`);
  parts.push(`<span class="pager-info">第 ${page} / ${totalPages} 页</span>`);
  if (page < totalPages) parts.push(`<a class="pager-btn" href="${escapeHtml(link(page + 1))}">${T.next}</a>`);
  return `<div class="pager">${parts.join('')}</div>`;
}

export interface HomeOptions {
  /** 当前筛选的标签（?tag=），用于筛选条与翻页链接。 */
  tag?: string;
  /** 当前筛选的分类（?category=）。 */
  category?: string;
  /** ?page= 页码，从 1 开始。 */
  page?: number;
  /** 每页条数：>0 分页，0 = 全部显示（与 app.js homePageSize() 同义）。 */
  pageSize?: number;
  /** 后台勾选的首页标签白名单；空 = 全显示。 */
  homeTags?: string[];
  /** 后台配置的首页广告位 HTML。 */
  adsHtml?: string;
}

/** 渲染首页主体（与 app.js 的 renderHome 结构同构）。 */
export function renderHomeContent(
  posts: PostRow[],
  _site: SiteIdentity,
  opts: HomeOptions = {}
): string {
  const tag = String(opts.tag ?? '');
  const category = String(opts.category ?? '');
  const pageSize = Number(opts.pageSize ?? 8);

  let filtered = posts;
  if (tag) filtered = filtered.filter((p) => parseTags(p.tags).includes(tag));
  if (category) filtered = filtered.filter((p) => String(p.category ?? '').trim() === category);

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  let page = Math.floor(Number(opts.page) || 1);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const pageItems = pageSize > 0 ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;

  const list = pageItems.length
    ? pageItems.map((post, index) => renderCard(post, index)).join('')
    : `<div class="empty"><div class="big">${svgIcon('doc', 36)}</div><p>${
        tag || category ? T.noPostsFiltered : T.noPosts
      }</p></div>`;
  const pager = pagerHtml(page, totalPages, tag, category);

  let html =
    '<main class="container page-fade">' +
    `<div class="list-head"><h2 class="page-title">${T.latest}</h2></div>`;
  if (tag) {
    html +=
      `<div class="current-tag"><span class="tag-chip">${escapeHtml(tag)} ` +
      '<a class="tag-clear" href="/">✕</a></span></div>';
  }
  if (category) {
    html +=
      `<div class="current-tag"><span class="tag-chip">${svgIcon('tag', 13)} ${escapeHtml(category)} ` +
      '<a class="tag-clear" href="/">✕</a></span></div>';
  }
  html += renderHomeTagRow(posts, tag, opts.homeTags ?? []);
  if (opts.adsHtml) {
    html += `<div class="ad-slot"><span class="ad-label">${T.adLabel}</span>${opts.adsHtml}</div>`;
  }
  // 不分页时翻页器不渲染，其下边距随之消失，末尾文章会贴住底部导航 ——
  // 此时给列表容器加 list-nopager 类，由 CSS 补齐同等间距
  html +=
    `<div id="homeBody"><div id="listContainer"${pager ? '' : ' class="list-nopager"'}>${list}</div>${pager}</div>`;
  html += '</main>';
  return html;
}

/** 首页需要展示的文章：已发布、置顶优先、按日期倒序。
 *  不在此处 LIMIT —— 分页/筛选由 renderHomeContent 按后台配置切分，
 *  截断会让 ?page=2 拿不到数据。 */
export const HOME_POSTS_SQL =
  "SELECT * FROM posts WHERE COALESCE(status, 'published') = 'published' " +
  'ORDER BY COALESCE(pinned, 0) DESC, date DESC';