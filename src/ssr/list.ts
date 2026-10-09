/* ============================================================
 * 公开站 SSR：首页文章列表
 * ------------------------------------------------------------
 * 与 src/ssr/post.ts 同一套思路：渲染进 #app，app.js 启动后原地替换。
 * 标记对齐 app.js 的 renderHome() / renderPostCard()：
 *   main.container.page-fade > .list-head + #homeBody > a.post-card
 * ============================================================ */
import { escapeHtml, stripMarkdown, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { formatDate } from './format.js';

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function renderThumb(post: PostRow, index: number): string {
  const cover = String(post.cover ?? '').trim();
  if (!cover) return '';
  // 前两张是首屏可视区，给高优先级；其余懒加载 + 低优先级
  const priority = index < 2 ? ' fetchpriority="high"' : ' fetchpriority="low" loading="lazy"';
  // onerror 兜底必须与服务端渲染期就有：外链图床挂掉时（DNS 失败/代理挂死），
  // 浏览器可能几十秒都不报错，期间用户看到的是一张挂着加载态的破图。
  // app.js 接管后重新渲染的卡片自带 onerror="this.remove()"，但接管前的
  // SSR 阶段同样要有，否则首屏破图 + 标签页转圈的感知都发生在这段时间。
  // referrerpolicy 与 app.js 的 renderPostThumb() 保持一致（防盗链图床）。
  return `<div class="post-thumb"><img src="${escapeHtml(cover)}" alt="" decoding="async"${priority} referrerpolicy="no-referrer" onerror="this.remove()"></div>`;
}

function renderCard(post: PostRow, index: number): string {
  const tags = parseTags(post.tags);
  const badges =
    (post.pinned ? '<span class="badge-pin">置顶</span>' : '') +
    (post.protected ? '<span class="badge-lock">加密</span>' : '');

  // 摘要：优先 excerpt，其次正文去 Markdown，最后空
  const excerpt = String(post.excerpt ?? '').trim() || stripMarkdown(String(post.content ?? '')).slice(0, 120);

  const tagHtml = tags
    .slice(0, 3)
    .map((tag) => `<span class="mini-tag">${escapeHtml(tag)}</span>`)
    .join('');

  return (
    `<a class="post-card" href="/posts/${encodeURIComponent(post.id)}/">` +
    '<div class="post-card-main">' +
    `<div class="meta"><span class="date">${escapeHtml(formatDate(post.date))}</span>${badges}</div>` +
    `<h2>${escapeHtml(post.title ?? '')}</h2>` +
    `<div class="excerpt">${escapeHtml(excerpt)}</div>` +
    // 恒渲染：无标签时留空容器，保证卡片等高
    `<div class="mini-tags">${tagHtml}</div>` +
    '</div>' +
    renderThumb(post, index) +
    '</a>'
  );
}

/** 渲染首页主体（与 app.js 的 renderHome 结构同构）。 */
export function renderHomeContent(posts: PostRow[], _site: SiteIdentity): string {
  const body = posts.map((post, index) => renderCard(post, index)).join('');
  return (
    '<main class="container page-fade">' +
    '<div class="list-head"><h2 class="page-title">最新</h2></div>' +
    `<div id="homeBody">${body}</div>` +
    '</main>'
  );
}

/** 首页需要展示的文章：已发布、置顶优先、按日期倒序。 */
export const HOME_POSTS_SQL =
  "SELECT * FROM posts WHERE COALESCE(status, 'published') = 'published' " +
  'ORDER BY COALESCE(pinned, 0) DESC, date DESC LIMIT 10';