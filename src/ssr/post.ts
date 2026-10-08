/* ============================================================
 * 公开站服务端渲染
 * ------------------------------------------------------------
 * 目标：让不执行 JS 的抓取者（以及首屏）直接看到正文。
 *
 * 做法是「渐进增强」而不是重写 SPA：
 *   1. 服务端把文章渲染进 index.html 的 #app 容器
 *   2. app.js 启动后照常接管 #app，用自己的 renderPost() 重绘
 *   3. 因此**不需要改动任何上游前端代码**
 *
 * 标记刻意与 app.js 的 renderPost() 保持同一套 class
 * （.container.page-fade / .post-body / .post-header / .article），
 * 这样 SPA 接管时是「原地替换」而不是重新布局，视觉上不会跳。
 *
 * ── 同构的判据（铁律 4）────────────────────────────────────
 * SSR 必须复刻的是 app.js **同步吐出的那一版 HTML**，而不是「最终态」。
 * app.js renderPost() 里异步填充的部分 liabilities：
 *   · #viewCount / #likeCount / #commentCount   → 静态版恒为 0
 *   · ul#commentList                            → 静态版为空
 *   · #featuredGrid                             → 静态版是 .featured-loading
 *   · #postRelations                            → 静态版为空 div
 *   · .reading-tools 里的高亮/稍后读/导入导出     → initHighlight() 事后 append
 *   上面这些 SSR **绝不能**提前渲染成拉取后的样子，否则先画出来又被
 *   renderPost 的静态版打回去，变成「有 → 无 → 有」的三段式闪烁。
 * ────────────────────────────────────────────────────────────
 *
 * 安全说明：正文虽然来自已认证的作者，但依然按**不可信内容**处理——
 * 与 app.js 一致，Markdown 渲染时先 HTML 转义再解析（见 ./markdown.ts）。
 * 公开访客生成的内容（评论）不走这条路径，仍由前端渲染。
 * ============================================================ */
import { escapeHtml, stripMarkdown, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { formatDate } from './format.js';
import { renderMarkdown, type WikiPostRef } from './markdown.js';
import { svgIcon } from './icons.js';

// 渲染器本体在 ./markdown.ts（与 app.js 逐函数同构）；这里转出，保持既有引用点不变。
export { renderMarkdown } from './markdown.js';
export type { WikiPostRef } from './markdown.js';

/** 与 public/index.html 里的启动动画元素匹配（app.js 不引用它，替换安全）。 */
const BOOT_LOADER = /<div class="boot-load" id="bootLoad">[\s\S]*?<\/div>\s*<\/div>/;

export function injectAppContent(shell: string, content: string): string {
  return shell.replace(BOOT_LOADER, content);
}

/* 文案与 app/public/i18n.js 逐字一致（少一处就会在首屏与 SPA 之间闪一下） */
const T_MIN_READ = '分钟阅读';
const T_VIEWS = '次浏览';
const T_PIN = '置顶';
const T_FONT_SIZE = '阅读字号';
const T_FONT_SMALLER = '调小字号';
const T_FONT_RESET = '恢复默认字号';
const T_FONT_LARGER = '调大字号';
const T_TOC_TITLE = '目录';
const T_TOC_OPEN = '打开目录';
const T_CLOSE = '关闭公告';
const T_LOADING = '加载中';
const T_PRINT = '打印 / PDF';
const T_SHARE = '分享';
const T_SHARE_NATIVE = '系统分享';
const T_SHARE_WEIBO = '微博';
const T_SHARE_X = 'X（推特）';
const T_SHARE_FACEBOOK = 'Facebook';
const T_SHARE_TELEGRAM = 'Telegram';
const T_SHARE_EMAIL = '邮件';
const T_COPY_LINK = '复制链接';
const T_IN_SERIES = '收录于系列';
const T_PREV = '← 上一篇';
const T_NEXT = '下一篇 →';
const T_RELATED = '相关文章';
const T_BACKLINKS = '引用本文';
const T_COMMENT_TITLE = '评论';
const T_COMMENT_SORT_HOT = '最热';
const T_COMMENT_SORT_NEW = '最新';
const T_COMMENT_HINT = '在此输入昵称与内容发表评论';
const T_COMMENT_AUTHOR = '昵称';
const T_COMMENT_CONTENT = '说点什么…';
const T_COMMENT_EMOJI = '表情';
const T_COMMENT_SUBMIT = '发表评论';
const T_COMMENT_MORE = '加载更多评论';
const T_FEATURED = '精选文章';
const T_AD_LABEL = '广告';
const T_LOCK_TITLE = '文章已加密';
const T_LOCK_DESC = '本文已加密，请输入访问密码后查看正文。';
const T_LOCK_PLACEHOLDER = '访问密码';
const T_UNLOCK = '解锁';

/* ---------- 小工具：与 app.js 同名函数逐一对齐 ---------- */

/**
 * app.js normalizeTags() 的服务端等价物。
 * 差异在于数据来源：前端拿到的 `tags` 恒为数组（来自 /api/posts 或 posts.js），
 * 而 SSR 直接读库时它是存 JSON 数组的字符串。所以这里先按 JSON 解析，
 * 失败才退化到 normalizeTags 的中英文逗号切分，避免出现
 * `["技术"` / `"随笔"]` 这种半个 JSON 当标签的怪结果。
 */
function postTags(post: PostRow): string[] {
  const raw: unknown = post.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      /* 坏 JSON 按文本处理 */
    }
  }
  return text.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
}

/** app.js postUrl() */
function postUrl(id: unknown): string {
  return '/posts/' + encodeURIComponent(String(id ?? '')) + '/';
}

/** app.js seriesUrl() */
function seriesUrl(name: unknown): string {
  return '/series/' + encodeURIComponent(String(name ?? '')) + '/';
}

/** app.js `href('/', { tag })` —— 首页带查询的筛选链接 */
function tagUrl(tag: string): string {
  return '/?tag=' + encodeURIComponent(tag);
}

/** app.js sortPosts()：置顶优先 → 日期倒序 → id 倒序 */
function sortPosts(a: PostRow, b: PostRow): number {
  const ap = Boolean(a.pinned);
  const bp = Boolean(b.pinned);
  if (ap !== bp) return ap ? -1 : 1;
  const ad = String(a.date ?? '');
  const bd = String(b.date ?? '');
  if (ad === bd) return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  return ad < bd ? 1 : ad > bd ? -1 : 0;
}

/** app.js seriesSort()：seriesOrder 优先，其次日期、id */
function seriesSort(a: PostRow, b: PostRow): number {
  const ao = Number(a.series_order ?? 0) || 0;
  const bo = Number(b.series_order ?? 0) || 0;
  if (ao > 0 && bo > 0 && ao !== bo) return ao - bo;
  if (ao > 0 && bo <= 0) return -1;
  if (ao <= 0 && bo > 0) return 1;
  const ad = String(a.date ?? '');
  const bd = String(b.date ?? '');
  return ad.localeCompare(bd) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/* ---------- 目录（对齐 app.js buildToc + stampHeadingNumbers） ---------- */

interface TocHeading {
  lvl: number;
  id: string;
  text: string;
  /** 少于 2 个标题时 app.js 不会计算编号，此处为 '' — 与「渲染出空 toc-num」一致 */
  num?: string;
}

/** app.js htmlToText() */
function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从渲染好的正文里抽标题、算多级编号，并把编号插回正文（等价于
 * app.js 的 buildToc() + stampHeadingNumbers() 两步）。
 */
function buildToc(bodyHtml: string): { headings: TocHeading[]; body: string; html: string } {
  const re = /<h([1-6]) id="(toc-(\d+))">([\s\S]*?)<\/h[1-6]>/g;
  const sections: TocHeading[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) {
    sections.push({ lvl: Number(m[1]), id: m[2], text: htmlToText(m[4]) });
  }
  if (sections.length < 2) {
    // 关键细节：标题不足 2 个时 app.js 提前 return，编号**不会被计算**，
    // 但 stampHeadingNumbers 仍会插入一个空的 .toc-num。
    return { headings: sections, body: stamp(bodyHtml, sections), html: '' };
  }
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const s of sections) {
    counts[s.lvl]++;
    for (let k = s.lvl + 1; k <= 6; k++) counts[k] = 0;
    const parts: number[] = [];
    for (let j = 1; j <= s.lvl; j++) if (counts[j]) parts.push(counts[j]);
    s.num = parts.join('.');
  }
  const items = sections
    .map(
      (s) =>
        '<a href="#' + s.id + '" data-toc="' + s.id + '" style="padding-left:' + (s.lvl - 1) * 14 + 'px">' +
        '<span class="toc-num">' + escapeHtml(s.num ?? '') + '</span>' + escapeHtml(s.text) + '</a>'
    )
    .join('');
  return {
    headings: sections,
    body: stamp(bodyHtml, sections),
    html:
      '<details class="toc"><summary>' + svgIcon('list', 14) + ' ' + escapeHtml(T_TOC_TITLE) + '</summary>' +
      '<div class="toc-list">' + items + '</div></details>'
  };
}

/** 把 `.toc-num` 插到每个标题开头（app.js stampHeadingNumbers 的静态等价物）。 */
function stamp(bodyHtml: string, headings: TocHeading[]): string {
  let idx = 0;
  return bodyHtml.replace(/(<h[1-6] id="toc-\d+")>/g, (_all, open) => {
    const h = headings[idx++];
    return open + '><span class="toc-num">' + escapeHtml(h?.num ?? '') + '</span>';
  });
}

/* ---------- 文章头 meta ---------- */

/**
 * 文章头部 meta，逐项对齐 app.js:3194 的 renderPost()：
 *   <div class="post-header"><h1>标题</h1><div class="meta">
 *     <span class="meta-date">日期</span>
 *     [· <span class="meta-author">作者</span>]
 *     · <span>N 分钟阅读</span>
 *     · <span class="meta-views">👁 <span id="viewCount">0</span> 次浏览</span>
 *     [<a class="pin" href="/series/…">☰ 系列名</a>]
 *     [<span class="pin">📌 置顶</span>]
 *   </div></div>
 *
 * 注意上游这里**没有**标签/分类链接：早期 SSR 自作主张加的 .pin 标签云属于
 * 「SSR 多出节点」，会被 app.js 整段替换掉，正是铁律 4 禁止的抖动。
 *
 * 浏览量恒为 0：renderPost 也是先写 0 再由 loadStats/incView 覆盖。
 */
function renderHeader(post: PostRow, minutes: number): string {
  const parts: string[] = [`<span class="meta-date">${escapeHtml(formatDate(post.date))}</span>`];
  if (post.author) {
    parts.push(
      '<span class="meta-dot">·</span>' + `<span class="meta-author">${escapeHtml(post.author)}</span>`
    );
  }
  parts.push(`<span class="meta-dot">·</span><span>${minutes} ${escapeHtml(T_MIN_READ)}</span>`);
  parts.push(
    '<span class="meta-dot">·</span>' +
      '<span class="meta-views">' +
      svgIcon('eye', 14) + ' <span id="viewCount">0</span> ' + escapeHtml(T_VIEWS) +
      '</span>'
  );
  if (post.series) {
    parts.push(
      `<a class="pin" href="${escapeHtml(seriesUrl(post.series))}">` +
        svgIcon('list', 13) + ' ' + escapeHtml(post.series) +
        '</a>'
    );
  }
  if (post.pinned) {
    parts.push(`<span class="pin">${svgIcon('pin', 13)} ${escapeHtml(T_PIN)}</span>`);
  }
  return `<div class="post-header"><h1>${escapeHtml(post.title ?? '')}</h1><div class="meta">${parts.join('')}</div></div>`;
}

/**
 * 阅读工具条。**只渲染字号三件套**：app.js 的 initHighlight() 会在其后
 * appendChild「高亮汇总 / 清除高亮 / 稍后读 / 导出 / 导入」五个按钮。
 * SSR 若先画出来，SPA 启动后就是十个按钮——重复图标条。
 */
const READING_TOOLS =
  `<div class="reading-tools"><span class="rt-label">${escapeHtml(T_FONT_SIZE)}</span>` +
  `<button type="button" class="rt-btn" data-rs="-1" aria-label="${escapeHtml(T_FONT_SMALLER)}" title="${escapeHtml(T_FONT_SMALLER)}">A−</button>` +
  `<button type="button" class="rt-btn" data-rs="0" aria-label="${escapeHtml(T_FONT_RESET)}" title="${escapeHtml(T_FONT_RESET)}">A</button>` +
  `<button type="button" class="rt-btn" data-rs="1" aria-label="${escapeHtml(T_FONT_LARGER)}" title="${escapeHtml(T_FONT_LARGER)}">A+</button>` +
  '</div>';

/* ---------- 文章页各区块，逐个对齐 renderPost() ---------- */

/** app.js aiPostSlot()：受保护文章不占槽 */
function aiPostSlot(post: PostRow): string {
  if (post.protected) return '';
  return `<div class="ai-post-slot" id="aiSummarySlot" data-slug="${escapeHtml(post.id)}"></div>`;
}

/** app.js 底部左右两侧：左标签云，右「打印 / 分享」 */
function articleFooter(post: PostRow): string {
  const tags = postTags(post)
    .map((t) => `<a href="${escapeHtml(tagUrl(t))}" data-tag-link>${escapeHtml(t)}</a>`)
    .join('');
  // 分享菜单：navigator.share 在 Chrome/Edge 桌面与移动端均已实现，按「有」渲染。
  // 菜单默认 hidden，个别浏览器不支持时 app.js 会移除「系统分享」一项，视觉无感。
  const shareMenu =
    '<div class="share-wrap">' +
    `<button class="btn" id="btnShare" aria-haspopup="true" aria-expanded="false" title="${escapeHtml(T_SHARE)}">` +
    svgIcon('external', 14) + ' ' + escapeHtml(T_SHARE) + '</button>' +
    '<div class="share-menu" id="shareMenu" role="menu" hidden>' +
    `<button class="share-item" id="btnCopyLink" data-share="copy" role="menuitem">` +
    svgIcon('link', 14) + ' ' + escapeHtml(T_COPY_LINK) + '</button>' +
    `<button class="share-item" data-share="native" role="menuitem">` +
    svgIcon('send', 14) + ' ' + escapeHtml(T_SHARE_NATIVE) + '</button>' +
    `<a class="share-item" data-share="weibo" role="menuitem" target="_blank" rel="noopener">${escapeHtml(T_SHARE_WEIBO)}</a>` +
    `<a class="share-item" data-share="x" role="menuitem" target="_blank" rel="noopener">${escapeHtml(T_SHARE_X)}</a>` +
    `<a class="share-item" data-share="facebook" role="menuitem" target="_blank" rel="noopener">${escapeHtml(T_SHARE_FACEBOOK)}</a>` +
    `<a class="share-item" data-share="telegram" role="menuitem" target="_blank" rel="noopener">${escapeHtml(T_SHARE_TELEGRAM)}</a>` +
    `<a class="share-item" data-share="email" role="menuitem">${escapeHtml(T_SHARE_EMAIL)}</a>` +
    '</div></div>';
  const printBtn =
    `<button class="btn" id="btnPrint" title="${escapeHtml(T_PRINT)}">` +
    svgIcon('file', 14) + ' ' + escapeHtml(T_PRINT) + '</button>';
  return (
    '<div class="article-footer">' +
    `<div class="af-tags">${tags}</div>` +
    `<div class="af-actions">${printBtn}${shareMenu}</div>` +
    '</div>'
  );
}

/** app.js 系列导航（仅当文章属于某个系列时渲染） */
function seriesNav(post: PostRow, siblings: readonly PostRow[]): string {
  if (!post.series) return '';
  const name = String(post.series).trim();
  const seriesPosts = siblings
    .filter((p) => String(p.series ?? '').trim() === name)
    .sort(seriesSort);
  const si = seriesPosts.findIndex((p) => p.id === post.id);
  if (si < 0) return '';
  const sp = si > 0 ? seriesPosts[si - 1] : null;
  const sn = si < seriesPosts.length - 1 ? seriesPosts[si + 1] : null;
  let html =
    '<div class="series-nav">' +
    '<div class="series-nav-title">' + svgIcon('list', 15) + ' ' + escapeHtml(T_IN_SERIES) + ': ' +
    `<a href="${escapeHtml(seriesUrl(name))}">${escapeHtml(name)}</a></div>` +
    '<div class="pn-nav">';
  if (sp) {
    html += `<a class="pn-item" href="${escapeHtml(postUrl(sp.id))}"><span class="pn-dir">${escapeHtml(T_PREV)}</span><span class="pn-title">${escapeHtml(sp.title ?? '')}</span></a>`;
  }
  if (sn) {
    html += `<a class="pn-item" href="${escapeHtml(postUrl(sn.id))}"><span class="pn-dir">${escapeHtml(T_NEXT)}</span><span class="pn-title">${escapeHtml(sn.title ?? '')}</span></a>`;
  }
  return html + '</div></div>';
}

/** app.js 上一篇 / 下一篇（ interactions 按 sortPosts 排序后的相邻项） */
function prevNextNav(post: PostRow, siblings: readonly PostRow[]): string {
  const sorted = siblings.slice().sort(sortPosts);
  const idx = sorted.findIndex((p) => p.id === post.id);
  const prev = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
  const next = idx > 0 ? sorted[idx - 1] : null;
  const item = (p: PostRow, dir: string, single: boolean) =>
    `<a class="pn-item${single ? ' pn-single' : ''}" href="${escapeHtml(postUrl(p.id))}">` +
    `<span class="pn-dir">${escapeHtml(dir)}</span>` +
    `<span class="pn-title">${escapeHtml(p.title ?? '')}</span></a>`;
  let html = '<div class="pn-nav">';
  if (prev && next) html += item(prev, T_PREV, false) + item(next, T_NEXT, false);
  else if (prev) html += item(prev, T_PREV, true);
  else if (next) html += item(next, T_NEXT, true);
  return html + '</div>';
}

/** app.js 评论区静态骨架——列表为空，真实留言由 /api/comments 异步填充 */
const COMMENTS_BLOCK =
  '<div class="comments"><div class="comments-head">' +
  '<h3>' + escapeHtml(T_COMMENT_TITLE) + ' <span class="comment-count" id="commentCount">0</span></h3>' +
  '<div class="comment-sort" id="commentSort" role="tablist">' +
  `<button type="button" class="cs-btn active" data-sort="hot" role="tab" aria-selected="true">${escapeHtml(T_COMMENT_SORT_HOT)}</button>` +
  `<button type="button" class="cs-btn" data-sort="new" role="tab" aria-selected="false">${escapeHtml(T_COMMENT_SORT_NEW)}</button>` +
  '</div></div>' +
  `<p class="comment-hint">${escapeHtml(T_COMMENT_HINT)}</p>` +
  '<div class="reply-indicator" id="replyIndicator" style="display:none">' +
  '<span id="replyTo"></span><button class="reply-cancel" id="replyCancel">✕</button></div>' +
  '<div class="comment-form">' +
  '<input class="hp-field" type="text" id="commentHp" name="hp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
  `<input type="text" id="commentAuthor" maxlength="30" placeholder="${escapeHtml(T_COMMENT_AUTHOR)}">` +
  '<div class="comment-editor-row">' +
  `<textarea id="commentContent" rows="2" maxlength="1000" placeholder="${escapeHtml(T_COMMENT_CONTENT)}"></textarea>` +
  `<button type="button" class="comment-emoji-btn" id="commentEmoji" title="${escapeHtml(T_COMMENT_EMOJI)}" aria-label="${escapeHtml(T_COMMENT_EMOJI)}">😊</button>` +
  '</div>' +
  '<div class="comment-submit-row">' +
  `<button class="btn btn-primary" id="commentSubmit">${escapeHtml(T_COMMENT_SUBMIT)}</button>` +
  '<span class="c-status" id="commentStatus"></span></div></div>' +
  '<ul class="comment-list" id="commentList"></ul>' +
  '<div class="comment-more" id="commentMore" style="display:none">' +
  `<button type="button" class="btn" id="commentMoreBtn">${escapeHtml(T_COMMENT_MORE)}</button></div></div>`;

/** app.js renderFeaturedHtml()：网格里初始是「加载中…」，异步替换 */
const FEATURED_BLOCK =
  '<div class="featured-posts" id="featuredPosts">' +
  '<div class="featured-title">' + svgIcon('pin', 16) + ' ' + escapeHtml(T_FEATURED) + '</div>' +
  '<div class="featured-grid" id="featuredGrid">' +
  `<div class="featured-loading">${escapeHtml(T_LOADING)}…</div>` +
  '</div></div>';

/** app.js 的加密锁屏（受保护文章：标题/meta 照常显示，正文需要密码） */
const LOCK_BLOCK =
  '<div class="post-lock" id="postLock">' +
  '<div class="post-lock-ico">' + svgIcon('lock', 26) + '</div>' +
  `<p class="post-lock-title">${escapeHtml(T_LOCK_TITLE)}</p>` +
  `<p class="post-lock-desc">${escapeHtml(T_LOCK_DESC)}</p>` +
  '<div class="post-lock-row">' +
  `<input type="password" class="post-lock-input" id="postLockPwd" placeholder="${escapeHtml(T_LOCK_PLACEHOLDER)}" maxlength="64">` +
  `<button type="button" class="btn btn-primary" id="postUnlockBtn">${escapeHtml(T_UNLOCK)}</button>` +
  '</div><p class="post-lock-err" id="postLockErr"></p></div>' +
  '<article class="article" id="postArticle" style="display:none"></article>';

/** 广告位：config.js ads 与 site_settings.features.ads 的合成结果 */
function adSlot(ads?: { enabled?: boolean; content?: string }): string {
  if (!ads || !ads.enabled || !ads.content) return '';
  return `<div class="ad-slot"><span class="ad-label">${escapeHtml(T_AD_LABEL)}</span>${ads.content}</div>`;
}

/* ---------- 渲染入口 ---------- */

export interface PostRenderContext {
  site: SiteIdentity;
  /** 已发布文章索引，供正文里的 `[[双链]]` 解析；不传则渲染为 `.missing` */
  wikiPosts?: readonly WikiPostRef[];
  /** 全部已发布文章：上一篇/下一篇与系列导航要用（对应 getPublishedPosts()） */
  siblings?: readonly PostRow[];
  /** 绝对站点地址，用于 print-only 的原文链接 */
  siteUrl?: string;
  /** 合并后的广告配置（config.js ads ← features.ads 覆盖） */
  ads?: { enabled?: boolean; content?: string };
}

/**
 * 渲染文章正文页。
 * 受保护文章（enc / protected=1）渲染标题与锁屏，**不注入明文**。
 */
export function renderPostContent(
  post: PostRow,
  site: SiteIdentity,
  wikiPosts?: readonly WikiPostRef[]
): string | null;
export function renderPostContent(post: PostRow, ctx: PostRenderContext): string | null;
export function renderPostContent(
  post: PostRow,
  siteOrCtx: SiteIdentity | PostRenderContext,
  legacyWiki?: readonly WikiPostRef[]
): string | null {
  const ctx: PostRenderContext =
    'name' in siteOrCtx
      ? { site: siteOrCtx as SiteIdentity, wikiPosts: legacyWiki }
      : (siteOrCtx as PostRenderContext);
  const { site, wikiPosts, siblings = [], siteUrl = '', ads } = ctx;

  const locked = Boolean(post.protected) || Boolean((post as { enc?: string | null }).enc);
  const rawContent = locked ? '' : String(post.content ?? '');
  const minutes = Math.max(1, Math.ceil(stripMarkdown(rawContent).length / 400));

  const bodyHtml = locked ? '' : renderMarkdown(rawContent, wikiPosts);
  const toc = locked ? { html: '', headings: [] as TocHeading[], body: '' } : buildToc(bodyHtml);

  let html =
    '<main class="container page-fade"><div class="post-body">' +
    '<div class="reading-progress" id="readingProgress" aria-hidden="true"><span></span></div>' +
    renderHeader(post, minutes) +
    READING_TOOLS +
    aiPostSlot(post) +
    toc.html;

  if (locked) {
    html += LOCK_BLOCK;
  } else {
    html += `<article class="article">${toc.body}</article>`;
  }

  // 仅打印时显示：站点名 + 原文链接
  const origin = String(siteUrl || '').replace(/\/+$/, '');
  html +=
    '<div class="print-only print-foot">' +
    escapeHtml(site.name) + ' · ' + escapeHtml(origin + postUrl(post.id)) +
    '</div>';

  if (toc.headings.length >= 2) {
    html +=
      `<button type="button" class="toc-fab" id="tocFab" aria-label="${escapeHtml(T_TOC_OPEN)}">` +
      svgIcon('list', 18) + '</button>' +
      '<div class="toc-sheet" id="tocSheet" hidden>' +
      `<div class="toc-sheet-head"><span>${escapeHtml(T_TOC_TITLE)}</span>` +
      `<button type="button" class="toc-sheet-close" id="tocSheetClose" aria-label="${escapeHtml(T_CLOSE)}">✕</button></div>` +
      '<div class="toc-sheet-list">' +
      toc.headings
        .map(
          (h) =>
            '<a href="#' + escapeHtml(h.id) + '" data-toc="' + escapeHtml(h.id) + '" style="padding-left:' +
            (8 + (h.lvl - 1) * 14) + 'px"><span class="toc-num">' + escapeHtml(h.num ?? '') + '</span>' +
            escapeHtml(h.text) + '</a>'
        )
        .join('') +
      '</div></div>';
  }

  // 点赞：正文尾部水平居中
  html +=
    '<div class="like-bar">' +
    '<button class="btn like-btn" id="likeBtn">' +
    svgIcon('heart', 15) + ' <span id="likeCount">0</span></button></div>';

  html += articleFooter(post);
  if (!locked) html += seriesNav(post, siblings);
  html += prevNextNav(post, siblings.length ? siblings : [post]);
  // 双向链接 / 相关文章：app.js 这里也是空容器，内容异步塞进来
  html += '<div class="relations-slot" id="postRelations"></div>';
  html += '<div class="webmentions" id="postWebmentions" hidden></div>';
  html += COMMENTS_BLOCK;
  html += FEATURED_BLOCK;
  html += adSlot(ads);

  return html + '</div></main>';
}

/** 关系区块用到的文案（供内部串联，避免上层拼错字） */
export const RELATIONS_LABELS = { related: T_RELATED, backlinks: T_BACKLINKS };
