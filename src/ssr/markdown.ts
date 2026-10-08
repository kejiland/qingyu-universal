/* ============================================================
 * 公开站 SSR：Markdown 渲染器
 * ------------------------------------------------------------
 * **逐行复刻 `app/public/app.js` 的 renderMarkdown / inlineMd / tokenizeCode。**
 *
 * 为什么不用现成的 Markdown 库（原先用的是 `marked`）：
 *   1. 上游前端是**手写**渲染器，任何第三方库的产出都与它不同构——
 *      代码块 class（`code-block` vs `language-xx`）、标题锚点（`id="toc-N"`）、
 *      表格结构、行内高亮 span 全都不一样，于是首屏（SSR）与 app.js 接管后的
 *      结果不一致，表现为布局抖动。这是项目铁律 4 明令禁止的。
 *   2. 上游渲染器**先转义再解析**（inlineMd 第一行就是 esc），
 *      所以正文里的原始 HTML 在前端是当纯文本显示的；而 `marked` 默认放行
 *      原始 HTML，导致同一篇正文「前端安全、SSR 可执行脚本」——
 *      既是 XSS，也是前后端行为分裂。
 *
 * 因此本文件是 `app.js` 对应函数的**同构移植**，改动必须与上游逐函数对照。
 * 上游对应位置：
 *   esc          app.js:389
 *   tokenizeCode app.js:458
 *   renderMarkdown app.js:492
 *   inlineMd     app.js:609
 *   resolveWikiLink / relationTitleKey / slug  app.js:1089 / 2969 / 2972
 *   href / appRoot / postUrl  app.js:4343 / 4375 / 4385
 *   （href 在 HTTP 下是恒等映射：appRoot() 返回 ''，hash 模式仅 file:// 触发）
 * ============================================================ */
import { escapeHtml } from '../seo/meta.js';

/** 与 app.js 的 esc() 逐字符一致（已用测试锁定）。 */
const esc = escapeHtml;

/* ---------- 代码块高亮（app.js:458 tokenizeCode） ---------- */

export function tokenizeCode(lang: string, code: string): string {
  if (!lang || !/^(js|javascript|ts|typescript|python|py|bash|sh|css|html|json)$/i.test(lang)) {
    return esc(code);
  }
  const lower = lang.toLowerCase();
  let kw = '';
  if (lower === 'js' || lower === 'javascript' || lower === 'ts' || lower === 'typescript') {
    kw =
      '\\b(?:const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|throw|switch|case|break|continue|typeof|instanceof|in|of|this|do|yield|delete|void|null|undefined|true|false)\\b';
  } else if (lower === 'python' || lower === 'py') {
    kw =
      '\\b(?:def|return|if|else|elif|for|while|import|from|class|try|except|finally|with|as|pass|break|continue|lambda|global|nonlocal|yield|True|False|None|not|and|or|in|is|raise|assert|del)\\b';
  } else if (lower === 'bash' || lower === 'sh') {
    kw =
      '\\b(?:if|then|else|fi|for|while|do|done|case|esac|function|echo|export|cd|exit|return|local|sudo|grep|sed|awk|curl|wget|npm|node|npx|git)\\b';
  } else if (lower === 'css') {
    kw =
      '\\b(?:display|position|color|background|margin|padding|border|width|height|font|opacity|flex|grid|z-index|top|right|bottom|left|transform|transition|@media|@keyframes)\\b';
  } else if (lower === 'html') {
    return esc(code);
  } else if (lower === 'json') {
    return esc(code);
  }
  const re = new RegExp(
    '(' +
      kw +
      ')|(\\d+(?:\\.\\d+)?)|(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|#.*|<!--[\\s\\S]*?-->)|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')',
    'g'
  );
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += '<span class="tok-kw">' + esc(m[1]) + '</span>';
    else if (m[2]) out += '<span class="tok-num">' + esc(m[2]) + '</span>';
    else if (m[3]) out += '<span class="tok-com">' + esc(m[3]) + '</span>';
    else if (m[4]) out += '<span class="tok-str">' + esc(m[4]) + '</span>';
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

/* ---------- Wiki 双链解析（app.js:1089 / 2969 / 2972） ---------- */

/** 已发布文章的最小信息，用于解析 `[[标题]]` / `[[id]]`。 */
export interface WikiPostRef {
  id: string;
  title?: string | null;
}

function relationTitleKey(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function slug(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** 与 app.js:2972 resolveWikiLink 一致：id → 标题归一化 → 标题 slug，三级回退。 */
function makeWikiResolver(posts: readonly WikiPostRef[] | undefined) {
  const list = Array.isArray(posts) ? posts : [];
  return function resolveWikiLink(label: unknown): WikiPostRef | null {
    const raw = String(label || '').trim();
    if (!raw) return null;
    let hit = list.find((p) => String(p.id) === raw);
    if (!hit) {
      const key = relationTitleKey(raw);
      hit = list.find((p) => relationTitleKey(p.title) === key);
    }
    if (!hit) {
      const sl = slug(raw);
      hit = list.find((p) => slug(p.title) === sl);
    }
    return hit ?? null;
  };
}

/* ---------- 行内渲染（app.js:609 inlineMd） ---------- */

const SMOJI_RE = /!\[smoji:([^\]]{1,40})\]\((https?:\/\/s3-cdn\.zsh\.moe\/smoji\/[^()\s]+)\)/g;

type WikiResolver = ReturnType<typeof makeWikiResolver>;

function inlineMd(source: string, resolveWikiLink: WikiResolver): string {
  let t = esc(String(source || ''));
  t = t.replace(/\\\\([*_`~[\]])/g, '\u0001$1');
  // 行内代码
  t = t.replace(/`([^`]*)`/g, '<code class="inline-code">$1</code>');
  // 斜体
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 加粗
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 删除线
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // Smoji 表情（先于普通图片；仅匹配 smoji: 标记 + Smoji 官方 CDN 的 http(s) 图片 URL 后才渲染）
  t = t.replace(SMOJI_RE, function (_m, label: string, src: string) {
    return (
      '<img class="smoji-inline" src="' +
      src +
      '" alt="[表情：' +
      label +
      ']" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
    );
  });
  // 图片（过滤 javascript:/data: 等危险协议）
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt: string, src: string) {
    if (/^\s*(javascript|data|vbscript):/i.test(String(src).trim())) return m;
    return (
      '<img src="' +
      src +
      '" alt="' +
      alt +
      '" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
    );
  });
  // 链接（过滤 javascript:/data: 等危险协议）
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, txt: string, url: string) {
    if (/^\s*(javascript|data|vbscript):/i.test(String(url).trim())) return m;
    return '<a href="' + url + '">' + txt + '</a>';
  });
  // Wiki 双向链接：[[文章标题]] 或 [[文章标题|显示文字]]
  t = t.replace(/\[\[([^[\]\n]{1,160})\]\]/g, function (_m, raw: string) {
    const parts = String(raw || '').split('|');
    const target = String(parts[0] || '')
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const label = String(parts.length > 1 ? parts[1] : parts[0] || '').trim();
    const hit = resolveWikiLink(target);
    if (!hit) return '<span class="wiki-link missing">' + label + '</span>';
    return '<a class="wiki-link" href="' + esc(postUrl(hit.id)) + '">' + label + '</a>';
  });
  // 恢复遮罩
  t = t.replace(/\u0001([*_`~[\]])/g, '$1');
  return t;
}

/** app.js:4385 postUrl + href(appRoot() === '' + history 模式) 的等价形式。 */
function postUrl(id: string): string {
  return '/posts/' + encodeURIComponent(id) + '/';
}

/* ---------- 块级渲染（app.js:492 renderMarkdown） ---------- */

/**
 * 渲染正文 Markdown。
 *
 * @param markdown 正文源码
 * @param wikiPosts 已发布文章索引；用于解析 `[[双链]]`。
 *                  与前端 `getPublishedPosts()` 同源（仅 status='published'）。
 *                  不传时双链一律渲染为 `.missing`，与前端「索引尚未加载」的
 *                  首屏状态一致。
 */
export function renderMarkdown(markdown: string, wikiPosts?: readonly WikiPostRef[]): string {
  const src = String(markdown || '');
  const resolveWikiLink = makeWikiResolver(wikiPosts);
  let tocCount = 0;
  const lines = src.split(/\r?\n/);
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    // 代码块
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] as string)) {
        codeLines.push(lines[i] as string);
        i++;
      }
      if (i < lines.length) i++; // 跳过 ```
      html +=
        '<pre class="code-block"><code class="lang-' +
        esc(lang) +
        '">' +
        tokenizeCode(lang, codeLines.join('\n')) +
        '</code></pre>\n';
      continue;
    }

    // 标题
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const lvl = (hm[1] as string).length;
      const txt = (hm[2] as string).trim();
      tocCount++;
      html +=
        '<h' + lvl + ' id="toc-' + tocCount + '">' + inlineMd(txt, resolveWikiLink) + '</h' + lvl + '>\n';
      i++;
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // 表格
    if (i + 1 < lines.length && /\|/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(lines[i + 1] as string)) {
      const headerRow = line;
      const headerCells = headerRow
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i] as string) && (lines[i] as string).trim() !== '') {
        const cells = (lines[i] as string)
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        rows.push(cells);
        i++;
      }
      html +=
        '<table><thead><tr>' +
        headerCells
          .map((c) => '<th>' + inlineMd(c, resolveWikiLink) + '</th>')
          .join('') +
        '</tr></thead><tbody>';
      rows.forEach((r) => {
        html +=
          '<tr>' + r.map((c) => '<td>' + inlineMd(c, resolveWikiLink) + '</td>').join('') + '</tr>';
      });
      html += '</tbody></table>\n';
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) {
        quoteLines.push((lines[i] as string).replace(/^>\s?/, ''));
        i++;
      }
      html += '<blockquote><p>' + inlineMd(quoteLines.join(' '), resolveWikiLink) + '</p></blockquote>\n';
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      html += '<ul>\n';
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] as string)) {
        html += '<li>' + inlineMd((lines[i] as string).replace(/^\s*[-*+]\s+/, ''), resolveWikiLink) + '</li>\n';
        i++;
      }
      html += '</ul>\n';
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      html += '<ol>\n';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] as string)) {
        html += '<li>' + inlineMd((lines[i] as string).replace(/^\s*\d+\.\s+/, ''), resolveWikiLink) + '</li>\n';
        i++;
      }
      html += '</ol>\n';
      continue;
    }

    // 分割线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }

    // 普通段落（聚合到空行）
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== '' &&
      !/^```/.test(lines[i] as string) &&
      !/^#{1,6}\s+/.test(lines[i] as string) &&
      !/^\s*[-*+]\s+/.test(lines[i] as string) &&
      !/^\s*\d+\.\s+/.test(lines[i] as string) &&
      !/^>\s?/.test(lines[i] as string) &&
      !/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i] as string)
    ) {
      para.push(lines[i] as string);
      i++;
    }
    html += '<p>' + inlineMd(para.join(' '), resolveWikiLink) + '</p>\n';
  }

  return html;
}

/** 供测试断言「SSR 渲染器与 app.js 同构」用。 */
export const __internals = { esc, inlineMd, postUrl, relationTitleKey, slug };
