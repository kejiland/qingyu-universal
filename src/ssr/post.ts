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
import { escapeHtml, type PostRow, type SiteIdentity } from '../seo/meta.js';
import { formatDate } from './format.js';

/** 与 public/index.html 里的启动动画元素匹配（app.js 不引用它，替换安全）。 */
const BOOT_LOADER = /<div class="boot-load" id="bootLoad">[\s\S]*?<\/div>\s*<\/div>/;

export function renderMarkdown(markdown: string): string {
  return marked.parse(String(markdown ?? ''), {
    async: false,
    gfm: true,
    breaks: false
  }) as string;
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