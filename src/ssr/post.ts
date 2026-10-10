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
 * 安全说明：正文来自已认证的作者（后台撰写），与 SPA 的信任级别一致。
 * 公开访客生成的内容（评论）不走这条路径，仍由前端渲染。
 * ============================================================ */
import { marked } from 'marked';
import { escapeHtml, escapeJsonForScript, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { proxyHtmlImgSources } from '../lib/image-url.js';
import { formatDate } from './format.js';

/** 与 public/index.html 里的启动动画元素匹配（app.js 不引用它，替换安全）。 */
const BOOT_LOADER = /<div class="boot-load" id="bootLoad">[\s\S]*?<\/div>\s*<\/div>/;

/* marked 默认放行内联 HTML，而渲染结果最终会 innerHTML 进页面。
 * 写入面目前只有管理员，但仍要兜底三层现实风险：
 *   ① 后台会话存在 localStorage，被 XSS 一次即整站接管；
 *   ② 从不可信备份恢复（restore）可绕过编辑器直接注入正文；
 *   ③ 将来开放多作者 / 导入功能时，这里立刻变成存储型 XSS。
 * 只移除「正常写作不需要」的构造，保留 iframe/video 等嵌入 —— 视频嵌入是
 * 合理需求，且跨源 iframe 受同源策略约束，取不到父页面。
 */
const DANGEROUS_BLOCK = /<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DANGEROUS_SELF = /<\s*(script|style)\b[^>]*\/?>/gi;
const EVENT_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_PROTOCOL = /(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html)\s*:[^"']*\2/gi;

function sanitizeRenderedHtml(html: string): string {
  return html
    .replace(DANGEROUS_BLOCK, '')
    .replace(DANGEROUS_SELF, '')
    .replace(EVENT_ATTR, '')
    .replace(JS_PROTOCOL, '$1=""');
}

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(String(markdown ?? ''), {
    async: false,
    gfm: true,
    breaks: false
  }) as string;
  // 正文配图常常也是外链图床，与封面一样改走本站反代（/api/img）。
  // 放在 sanitize 之后：先消毒、再改写，避免改写出来的地址绕过消毒规则。
  return proxyHtmlImgSources(sanitizeRenderedHtml(html));
}

export function injectAppContent(shell: string, content: string): string {
  return shell.replace(BOOT_LOADER, content);
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

/** 与 renderPost() 的 .post-header / .meta 结构对齐。 */
function renderHeader(post: PostRow): string {
  const parts: string[] = [`<span class="meta-date">${escapeHtml(formatDate(post.date))}</span>`];
  if (post.series) {
    parts.push(
      `<a class="pin" href="/series/${encodeURIComponent(post.series)}/">${escapeHtml(post.series)}</a>`
    );
  }
  if (post.category) {
    parts.push(
      `<a class="pin" href="/categories/${encodeURIComponent(post.category)}/">${escapeHtml(post.category)}</a>`
    );
  }
  for (const tag of parseTags(post.tags)) {
    parts.push(`<a class="pin" href="/tags/${encodeURIComponent(tag)}/">${escapeHtml(tag)}</a>`);
  }
  return `<div class="post-header"><h1>${escapeHtml(post.title ?? '')}</h1><div class="meta">${parts.join('')}</div></div>`;
}

/** 阅读工具条：静态标记，SPA 启动后由它接管并绑定事件。 */
const READING_TOOLS =
  '<div class="reading-tools"><span class="rt-label">字号</span>' +
  '<button type="button" class="rt-btn" data-rs="-1" aria-label="缩小字号">A−</button>' +
  '<button type="button" class="rt-btn" data-rs="0" aria-label="默认字号">A</button>' +
  '<button type="button" class="rt-btn" data-rs="1" aria-label="放大字号">A+</button></div>';

/**
 * 渲染文章正文。
 * 受保护文章（enc 存在）不注入正文——内容本身是密文，且已标记 noindex。
 */
export function renderPostContent(post: PostRow, _site: SiteIdentity): string | null {
  if (post.protected) return null;

  const body = renderMarkdown(String(post.content ?? ''));
  return (
    '<main class="container page-fade"><div class="post-body">' +
    '<div class="reading-progress" id="readingProgress" aria-hidden="true"><span></span></div>' +
    renderHeader(post) +
    READING_TOOLS +
    `<article class="article">${body}</article>` +
    '</div></main>'
  );
}
/* ============================================================
 * 首屏数据内联
 * ------------------------------------------------------------
 * SSR 只把正文渲染成 HTML，没有把数据交给 app.js。于是 app.js 接管时
 * 在本地列表里找不到这篇文章：先渲染「加载中」→ 拉全量列表 → 拉正文
 * → route() 整页重渲染。手机端网络慢，这套二次拉取正是用户看到的
 * 「进文章后又刷一遍」。
 *
 * 这里把文章数据内联成 window.BLOG_POSTS（并标记 _fullLoaded），
 * 让 app.js 首次 route() 就能直接渲染正文，不再重复拉取。
 * ============================================================ */

/** 数据库行 → app.js 期望的文章形态（字段与 static-site 的 toClientPost 对齐）。 */
export function toClientPost(post: PostRow, options: { withContent?: boolean } = {}): Record<string, unknown> {
  const withContent = options.withContent !== false;
  const out: Record<string, unknown> = {
    id: post.id,
    title: post.title ?? '',
    date: post.date ?? '',
    excerpt: post.excerpt ?? '',
    cover: post.cover ?? '',
    ogImage: post.og_image ?? '',
    content: withContent ? (post.content ?? '') : '',
    pinned: Boolean(post.pinned),
    protected: Boolean(post.protected),
    enc: null,
    category: post.category ?? '',
    series: post.series ?? '',
    author: post.author ?? '',
    seriesOrder: Number(post.series_order) || 0,
    status: 'published',
    publishAt: null,
    seo: parseJsonObject(post.seo),
    tags: parseTags(post.tags)
  };
  // 明文已内联 → app.js 不必再拉一次正文，也就不会「再刷一遍」
  if (withContent && !post.protected) out._fullLoaded = true;
  return out;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 在 </head> 前插入启动数据。
 * 用同步内联脚本：它在解析阶段就执行，早于 defer 的 boot.js / app.min.js，
 * 所以 app.js 启动时 window.BLOG_POSTS 已就绪。
 */
export function injectBootstrapData(html: string, posts: Array<Record<string, unknown>>): string {
  if (!posts.length) return html;
  const script = '<script>window.BLOG_POSTS=' + escapeJsonForScript(posts) + ';window.__SSR_DATA__=1;</script>';
  if (html.indexOf('</head>') >= 0) return html.replace('</head>', script + '</head>');
  return script + html;
}
