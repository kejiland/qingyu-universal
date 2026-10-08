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
import { escapeHtml, stripMarkdown, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { renderMarkdown, type WikiPostRef } from './post.js';
import { formatDate } from './format.js';
import { svgIcon } from './icons.js';

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/* ---------- 归档页 ---------- */

/**
 * 归档页。逐行对齐 app.js renderArchive()：
 *   yr = (p.date || '').slice(0, 4) || t('archive.unknown')   ← 无日期的文章落在「未知」
 *   mo = Number((p.date || '').slice(5, 7) || 0)              ← 无月份时归到 0 月
 *   年份用 `Object.keys().sort().reverse()`（字符串排序后反转），月份数值倒序
 * 空列表时**只渲染标题**——app.js 没有空态，SSR 补一个反而会先闪一下再消失。
 */
export function renderArchiveContent(posts: PostRow[], _site: SiteIdentity): string {
  const byYear = new Map<string, Map<number, PostRow[]>>();
  for (const post of posts) {
    const date = String(post.date ?? '');
    const year = date.slice(0, 4) || '未知';
    const month = Number(date.slice(5, 7) || 0);
    if (!byYear.has(year)) byYear.set(year, new Map());
    const months = byYear.get(year)!;
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(post);
  }

  const blocks = [...byYear.keys()]
    .sort()
    .reverse()
    .map((year) => {
      const months = byYear.get(year)!;
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
    })
    .join('');

  return (
    '<main class="container page-fade">' +
    '<h2 class="page-title">归档</h2>' +
    blocks +
    '</main>'
  );
}

/* ---------- 标签 / 分类云 ---------- */

function cloudContent(
  posts: PostRow[],
  title: string,
  emptyText: string | null,
  param: 'tag' | 'category',
  pick: (post: PostRow) => string[]
): string {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const name of pick(post)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // 与 app.js 一致用默认字典序（Object.keys(counts).sort()），
  // 不用 localeCompare('zh-CN')——两者对中文的先后不同，会让首屏的标签顺序跳一次。
  const names = [...counts.keys()].sort();

  const chips = names
    .map(
      (name) =>
        `<a class="cloud-chip" href="/?${param}=${encodeURIComponent(name)}">${escapeHtml(name)}` +
        `<span class="cloud-count">${counts.get(name)}</span></a>`
    )
    .join('');

  // 空状态在 .tag-cloud 内部（与 app.js 的 renderCategories 一致）；
  // 标签页没有空状态文案（app.js 的 renderTags 直接渲染空容器）。
  const empty = !names.length && emptyText ? `<p class="ab-muted">${emptyText}</p>` : '';
  return `<main class="container page-fade"><h2 class="page-title">${title}</h2><div class="tag-cloud">${chips}${empty}</div></main>`;
}

export function renderTagsContent(posts: PostRow[], _site: SiteIdentity): string {
  return cloudContent(posts, '标签', null, 'tag', (post) => parseTags(post.tags));
}

export function renderCategoriesContent(posts: PostRow[], _site: SiteIdentity): string {
  return cloudContent(posts, '分类', '暂无分类', 'category', (post) => {
    const value = String(post.category ?? '').trim();
    return value ? [value] : [];
  });
}

/** 归档需要全部已发布文章（不分页、置顶不影响年月分组，按日期倒序） */
export const ARCHIVE_POSTS_SQL =
  "SELECT id, title, date, category, tags FROM posts WHERE COALESCE(status, 'published') = 'published' ORDER BY date DESC";

/**
 * 文章页「上一篇 / 下一篇 / 系列导航」用：全部已发布文章的关键字段。
 * 对应 app.js renderPost() 里的 getPublishedPosts()（排序在内存里做）。
 */
export const POST_SIBLINGS_SQL =
  'SELECT id, title, date, series, series_order, pinned, tags FROM posts ' +
  "WHERE COALESCE(status, 'published') = 'published'";

/**
 * 关于页统计用的全量文章（对应 app.js renderAbout() 里的 getPublishedPosts()）。
 * 必须带 content——总字数 = Σ stripMd(content).length，少了它统计永远是 0。
 */
export const ABOUT_POSTS_SQL =
  "SELECT id, title, date, category, tags, content FROM posts WHERE COALESCE(status, 'published') = 'published'";

/**
 * 正文 `[[双链]]` 解析用的索引：只取已发布文章的 id 与标题。
 * 与前端 `getPublishedPosts()` 同源（过滤掉草稿），保证双链在 SSR 与 SPA 解析一致。
 */
export const WIKI_POSTS_SQL =
  "SELECT id, title FROM posts WHERE COALESCE(status, 'published') = 'published'";
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

/** 读取 site_settings 里的 JSON 配置（键名与前端一致，如 site_info / friend_links）。 */
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

/** 与词典 about.desc 的 zh-CN 值保持一致（app.js 的 renderAbout 回退分支用的是 t('about.desc')）。 */
const ABOUT_DESC_DEFAULT = '一个零依赖、双击即开的轻量博客';
/* 关于页其余文案（与 locales/zh-CN.json 的 about.* 逐字一致） */
const ABOUT_TITLE = '关于';
const ABOUT_POSTS = '篇内容';
const ABOUT_TAGS = '个标签';
const ABOUT_TOTAL_WORDS = '总字数';
const ABOUT_LATEST = '最新更新';
const ABOUT_VERSION = '版本';
const ABOUT_DATA_MODE = '数据模式';
const ABOUT_CLOUD_MODE = '云端模式';
const ABOUT_STATIC_MODE = '静态模式';
const ABOUT_FIRST_USE = '首次使用';
const ABOUT_FIRST_USE_HINT = '双击 index.html 即可开始。';

/** 关于页的渲染输入（对齐 app.js renderAbout 依赖的四处数据）。 */
export interface AboutContext {
  /** 后台「站点信息 → 关于页面内容」的 Markdown */
  markdown: string;
  site: SiteIdentity;
  /** 全部已发布文章：统计卡（篇数 / 标签数 / 总字数 / 最近更新）用 */
  posts: PostRow[];
  profile: { name?: string; bio?: string; avatar?: string };
  /** 全站统一的前端版本号（app.js BLOG_VERSION） */
  blogVersion: string;
  /** 数据模式：在线（有接口）显示「云端模式」，否则「静态模式」 */
  cloudMode: boolean;
  wikiPosts?: readonly WikiPostRef[];
}

/**
 * 关于页。逐块对齐 app.js renderAbout()：
 *   .about-card.card 里依次是
 *     正文（about 正文 / 收藏的 qingyu-blog-intro / 「站名 + about.desc」三选一）
 *     → 作者资料卡（有昵称/头像/简介才渲染）
 *     → <hr class="about-sep">
 *     → .stat-grid（篇数 / 标签数 / 总字数 / 最近更新）
 *     → 版本 / 数据模式 / 首次使用 三组「h3 + p」
 */
export function renderAboutContent(ctx: AboutContext): string {
  const { markdown, site, posts, profile, blogVersion, cloudMode, wikiPosts } = ctx;
  const text = String(markdown || '').trim();

  // 正文优先级：后台 about → 收藏的 qingyu-blog-intro 文章 → 「站名 + 简介」
  const intro = posts.find((p) => String(p.id) === 'qingyu-blog-intro');
  let body: string;
  if (text) {
    body = `<div class="article about-intro">${renderMarkdown(text, wikiPosts)}</div>`;
  } else if (intro && String(intro.content ?? '').trim()) {
    body = `<div class="article about-intro">${renderMarkdown(String(intro.content), wikiPosts)}</div>`;
  } else {
    body = `<h3>${escapeHtml(site.name)}</h3><p>${ABOUT_DESC_DEFAULT}</p>`;
  }

  // 作者资料卡
  const profName = String(profile.name ?? '').trim() || site.name;
  const profAvatar = String(profile.avatar ?? '').trim() || site.avatar;
  const profBio = String(profile.bio ?? '').trim();
  let author = '';
  if (profName || profAvatar || profBio) {
    const avatar = profAvatar
      ? `<img class="about-author-avatar" src="${escapeHtml(profAvatar)}" alt="${escapeHtml(profName || 'avatar')}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '';
    author =
      '<div class="about-author card">' +
      avatar +
      '<div class="about-author-info">' +
      (profName ? `<div class="about-author-name">${escapeHtml(profName)}</div>` : '') +
      (profBio ? `<div class="about-author-bio">${escapeHtml(profBio)}</div>` : '') +
      '</div></div>';
  }

  // 统计卡：与 app.js 同一口径（总字数按去 Markdown 后的字符数）
  const tagSet = new Set<string>();
  let totalWords = 0;
  let latest = '';
  for (const post of posts) {
    for (const tag of parseTags(post.tags)) tagSet.add(tag);
    totalWords += stripMarkdown(String(post.content ?? '')).length;
    const date = String(post.date ?? '');
    if (!latest || date > latest) latest = date;
  }

  const stats =
    '<div class="stat-grid">' +
    `<div class="stat"><b>${posts.length}</b><span>${escapeHtml(ABOUT_POSTS)}</span></div>` +
    `<div class="stat"><b>${tagSet.size}</b><span>${escapeHtml(ABOUT_TAGS)}</span></div>` +
    `<div class="stat"><b>${totalWords}</b><span>${escapeHtml(ABOUT_TOTAL_WORDS)}</span></div>` +
    `<div class="stat"><b>${escapeHtml(latest || '-')}</b><span>${escapeHtml(ABOUT_LATEST)}</span></div>` +
    '</div>';

  const meta =
    `<h3>${escapeHtml(ABOUT_VERSION)}</h3><p>v${escapeHtml(blogVersion)}</p>` +
    `<h3>${escapeHtml(ABOUT_DATA_MODE)}</h3><p>${escapeHtml(cloudMode ? ABOUT_CLOUD_MODE : ABOUT_STATIC_MODE)}</p>` +
    `<h3>${escapeHtml(ABOUT_FIRST_USE)}</h3><p>${escapeHtml(ABOUT_FIRST_USE_HINT)}</p>`;

  return (
    '<main class="container page-fade">' +
    `<h2 class="page-title">${escapeHtml(ABOUT_TITLE)}</h2>` +
    '<div class="about-card card">' +
    body +
    author +
    '<hr class="about-sep">' +
    stats +
    meta +
    '</div></main>'
  );
}

export interface FriendLink {
  text?: string;
  url?: string;
}

/** 友链页：数据来自 `friend_links` 设置，与 app.js 的 cfg.friendLinks 一致。 */
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
    : '<p class="ab-muted">暂无友链</p>';
  return '<main class="container page-fade"><h2 class="page-title">友情链接</h2>' + body + '</main>';
}

/* 文案与 app/public/i18n.js 的 popular.* / post.* 逐字一致 */
const POPULAR_TITLE = '热门文章';
const POPULAR_DESC = '按浏览、点赞和评论综合热度排序';
const POPULAR_ALL = '全部';
const POPULAR_LAST30 = '近 30 天';
const POPULAR_LAST7 = '近 7 天';
const POPULAR_EMPTY = '暂无统计数据';
const POPULAR_UNIT_VIEWS = '次浏览';
const POPULAR_UNIT_LIKES = '次点赞';
const POPULAR_UNIT_COMMENTS = '评论';
const POST_UNTITLED = '(无标题)';

/** 行上除了 PostRow 还带着 JOIN 出来的浏览量/点赞数/评论数。 */
export interface PopularRow extends PostRow {
  views?: number | string | null;
  likes?: number | string | null;
  comments?: number | string | null;
}

/**
 * 热门页。逐块对齐 app.js renderPopular() (1660) + renderPopularList() (1613)：
 *   main.container.page-fade
 *     > div.list-head.popular-head > div > h2.page-title（带 heart 图标 + 标题）
 *                                        + p.admin-head-sub
 *     > div.popular-ranges > button.popular-range[active] ×3      ← 只在 _cloudOn() 时出现
 *     > div.popular-list#popularList                              ← **list-head 的兄弟节点，不是子节点**
 *         > a.popular-card ×N 或 .empty（无数据时的空态）
 *
 * 注意 `.popular-ranges` 在 app.js 里是紧跟 list-head **之后**渲染的（不是塞在
 * list-head 里），`.popular-list` 又是独立于两者的第三个块。放错层级会改变
 * flex 布局，表现为筛选按钮与卡片混在一行。
 *
 * @param posts  按综合热度降序（见 POPULAR_POSTS_SQL）
 * @param cloudOn 对应 app.js 的 _cloudOn()：本后端始终提供 /api，故默认 true
 */
export function renderPopularContent(posts: PopularRow[], cloudOn = true): string {
  const cards = (posts || [])
    .map(function (post, index): string {
      const views = Number(post.views) || 0;
      const likes = Number(post.likes) || 0;
      const comments = Number(post.comments) || 0;
      // 与 app.js 一致：normalizeTags(p).slice(0, 3).join(' · ')，没有标签才回退 fmtDate(date)
      const tagsMarks = parseTags(post.tags).slice(0, 3).join(' · ');
      const meta = tagsMarks || formatDate(post.date) || '';
      return (
        '<a class="popular-card" href="/posts/' + encodeURIComponent(post.id) + '/">' +
        '<span class="popular-rank">' + (index + 1) + '</span>' +
        '<div class="popular-main">' +
        '<div class="popular-card-title">' + escapeHtml(post.title || POST_UNTITLED) + '</div>' +
        '<div class="popular-card-meta">' + escapeHtml(meta) + '</div>' +
        '</div>' +
        '<div class="popular-metrics">' +
        '<span title="' + escapeHtml(POPULAR_UNIT_VIEWS) + '">' + svgIcon('eye', 13) + ' ' + views + '</span>' +
        '<span title="' + escapeHtml(POPULAR_UNIT_LIKES) + '">' + svgIcon('heart', 13) + ' ' + likes + '</span>' +
        '<span title="' + escapeHtml(POPULAR_UNIT_COMMENTS) + '">' + svgIcon('quote', 13) + ' ' + comments + '</span>' +
        '</div></a>'
      );
    })
    .join('');

  // 空态也由 app.js 塞进 #popularList，结构与这里必须一致
  const listBody =
    cards ||
    '<div class="empty"><div class="big">' + svgIcon('heart', 34) + '</div><p>' + escapeHtml(POPULAR_EMPTY) + '</p></div>';

  const ranges = cloudOn
    ? '<div class="popular-ranges">' +
      '<button class="popular-range active" data-popular-range="all">' + escapeHtml(POPULAR_ALL) + '</button>' +
      '<button class="popular-range" data-popular-range="30">' + escapeHtml(POPULAR_LAST30) + '</button>' +
      '<button class="popular-range" data-popular-range="7">' + escapeHtml(POPULAR_LAST7) + '</button>' +
      '</div>'
    : '';

  return (
    '<main class="container page-fade">' +
    '<div class="list-head popular-head"><div>' +
    '<h2 class="page-title">' + svgIcon('heart', 20) + ' ' + escapeHtml(POPULAR_TITLE) + '</h2>' +
    '<p class="admin-head-sub">' + escapeHtml(POPULAR_DESC) + '</p>' +
    '</div></div>' +
    ranges +
    '<div class="popular-list" id="popularList">' + listBody + '</div>' +
    '</main>'
  );
}

/**
 * 热门页的查询：对齐上游 `app/functions/_lib/popular.js` 的 range=all 分支——
 *   综合得分 = 浏览 ×1 + 点赞 ×3 + 评论 ×5（mv + 3×lk + 5×cm）
 *   只统计已发布、未加密文章（publicPost()）；评论只数 approved / NULL 的
 */
export const POPULAR_POSTS_SQL =
  'SELECT p.*, COALESCE(s.views, 0) AS views, COALESCE(s.likes, 0) AS likes, COALESCE(c.cnt, 0) AS comments FROM posts p ' +
  'LEFT JOIN stats s ON s.post_id = p.id ' +
  "LEFT JOIN (SELECT post_id, COUNT(*) AS cnt FROM comments WHERE status IS NULL OR status = 'approved' GROUP BY post_id) c ON c.post_id = p.id " +
  "WHERE COALESCE(p.status, 'published') = 'published' AND COALESCE(p.protected, 0) = 0 " +
  'ORDER BY (COALESCE(s.views, 0) + COALESCE(s.likes, 0) * 3 + COALESCE(c.cnt, 0) * 5) DESC, ' +
  '         COALESCE(s.views, 0) DESC, p.date DESC ' +
  'LIMIT 20';