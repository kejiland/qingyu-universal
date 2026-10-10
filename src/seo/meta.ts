/* ============================================================
 * SEO 元数据：服务端渲染
 * ------------------------------------------------------------
 * 上游把 SEO 逻辑放在浏览器里（app/public/app.js 的 updateSEO()）：
 * 它读 settings 与文章数据，动态改写 <meta>、canonical 与 JSON-LD。
 * 问题是对社交爬虫完全不可见——微信/Twitter/Facebook 拿到的是
 * index.html 里那套写死的「Qingyu'Blog · 轻量博客」。
 *
 * 这里把同一套规则搬到服务端，在返回 HTML 之前就注入正确的标签。
 * 字段优先级、回退顺序、JSON-LD 结构都与 updateSEO() 保持一致，
 * 避免爬虫看到的和用户看到的对不上。
 *
 * 对应上游：app/public/app.js → updateSEO() / _setMeta() / _setOG() / _setJsonLd()
 * ============================================================ */
import type { AppDatabase } from '../types.js';

/* ---------- 常量（与 app/public/locales/zh-CN.json 的默认值保持一致） ---------- */
const DEFAULT_SITE_NAME = "Qingyu'Blog";
const DEFAULT_SITE_DESC = '零依赖轻量博客，双击即开；支持 Cloudflare Pages / Workers 云端存储。';
const ROBOTS_INDEX = 'index, follow, max-image-preview:large, max-snippet:-1';
const ROBOTS_NOINDEX = 'noindex, nofollow';

/* ---------- 工具 ---------- */

/** 与前端 stripMd 完全一致的 Markdown 纯文本提取（用于生成描述）。 */
export function stripMarkdown(markdown: string): string {
  return String(markdown ?? '')
    // 文章正文在本项目里存的是 HTML（渲染时直接当 HTML 用），
    // 只去 Markdown 符号会留下 <p> 之类的裸标签，
    // 摘要卡片与 SEO 描述里就会出现标签文本。
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, String.fromCharCode(34))
    .replace(/&amp;/gi, '&')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML 属性转义：meta 的 content 属性可能来自用户输入的文章标题。 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON-LD 内联到 <script> 中：必须转义，否则标题里的 </script> 能逃逸出标签。 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function safeJson<T = Record<string, unknown>>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 把站内相对路径补成绝对 URL（og:image / canonical 必须是绝对地址）。 */
export function absolutize(url: string, base: string): string {
  const value = str(url);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${base}${value}`;
  return `${base}/${value}`;
}

/** 列表截断，避免 description 超长被搜索引擎截断得难看。 */
function clamp(text: string, max: number): string {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/* ---------- 站点身份（来自 site_settings） ---------- */

export interface SiteIdentity {
  name: string;
  description: string;
  author: string;
  avatar: string;
}

/**
 * 读取站点身份。回退顺序与前端 getSiteName() / getSiteAuthor() 一致：
 *   name   : settings.site.name → settings.footer.copyrightName → i18n 默认
 *   author : settings.profile.name → footer.copyrightName → name
 */
export async function readSiteIdentity(
  db: AppDatabase,
  prefetchedRows?: Array<{ k: string; v: string }> | null
): Promise<SiteIdentity> {
  let rows: Array<{ k: string; v: string }> = [];
  if (prefetchedRows) {
    rows = prefetchedRows;
  } else {
    try {
      rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
    } catch {
      rows = [];
    }
  }
  const map = new Map(rows.map((row) => [row.k, row.v]));
  const site = safeJson(map.get('site'), {} as Record<string, unknown>);
  const footer = safeJson(map.get('footer'), {} as Record<string, unknown>);
  const profile = safeJson(map.get('profile'), {} as Record<string, unknown>);

  const copyrightName = str((footer as Record<string, unknown>).copyrightName);
  const name = str(site.name) || copyrightName || DEFAULT_SITE_NAME;

  return {
    name,
    description: str(site.desc) || DEFAULT_SITE_DESC,
    author: str(profile.name) || copyrightName || name,
    avatar: str(site.avatar)
  };
}

/* ---------- 文章行 ---------- */

export interface PostRow {
  id: string;
  title?: string | null;
  date?: string | null;
  excerpt?: string | null;
  content?: string | null;
  cover?: string | null;
  category?: string | null;
  series?: string | null;
  og_image?: string | null;
  tags?: string | null;
  seo?: string | null;
  status?: string | null;
  /** 作者署名（后台文章属性里可填）。参与 ETag 指纹。 */
  author?: string | null;
  protected?: number | null;
  pinned?: number | null;
  updated_at?: string | null;
  /** 系列内排序（部分后端无此列，缺省按 0 处理）。 */
  series_order?: number | null;
}

interface SeoOverride {
  title: string;
  desc: string;
  canonical: string;
  noindex: boolean;
}

function readSeoOverride(raw: unknown): SeoOverride {
  const seo = safeJson(raw, {} as Record<string, unknown>);
  return {
    title: str(seo.title),
    desc: str(seo.desc),
    canonical: str(seo.canonical),
    noindex: seo.noindex === true || seo.noindex === 1
  };
}

/* ---------- 元数据模型与渲染 ---------- */

export interface MetaTags {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  ogType: 'website' | 'article';
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
  ogImage: string;
  ogSiteName: string;
  author: string;
  publishedTime: string;
  tags: string[];
  jsonLd: Record<string, unknown>;
}

/** 渲染成一段可直接插入 <head> 的标签。 */
export function renderHeadBlock(meta: MetaTags): string {
  const lines: string[] = [
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta name="robots" content="${escapeHtml(meta.robots)}">`,
    `<meta name="author" content="${escapeHtml(meta.author)}">`,
    '',
    `<meta property="og:type" content="${escapeHtml(meta.ogType)}">`,
    `<meta property="og:site_name" content="${escapeHtml(meta.ogSiteName)}">`,
    `<meta property="og:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.ogDescription)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.ogUrl)}">`
  ];
  if (meta.ogImage) lines.push(`<meta property="og:image" content="${escapeHtml(meta.ogImage)}">`);
  if (meta.publishedTime) lines.push(`<meta property="article:published_time" content="${escapeHtml(meta.publishedTime)}">`);
  for (const tag of meta.tags) lines.push(`<meta property="article:tag" content="${escapeHtml(tag)}">`);

  lines.push(
    '',
    `<meta name="twitter:card" content="${meta.ogImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.ogDescription)}">`
  );
  if (meta.ogImage) lines.push(`<meta name="twitter:image" content="${escapeHtml(meta.ogImage)}">`);

  lines.push(
    '',
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}">`,
    '',
    `<script type="application/ld+json">${escapeJsonForScript(meta.jsonLd)}</script>`
  );
  return lines.join('\n');
}

/** 需要被替换掉的旧标签（index.html 里写死的那一套）。 */
const STALE_HEAD_PATTERNS: RegExp[] = [
  /<meta\s+name="description"[^>]*>\s*/gi,
  /<meta\s+name="robots"[^>]*>\s*/gi,
  /<meta\s+name="author"[^>]*>\s*/gi,
  /<meta\s+property="og:[^"]*"[^>]*>\s*/gi,
  /<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi,
  /<link\s+rel="canonical"[^>]*>\s*/gi,
  /<script\s+type="application\/ld\+json">[\s\S]*?<\/script>\s*/gi,
  /<!--\s*(?:Open Graph|Twitter Card|Canonical|Schema\.org JSON-LD（首页）)\s*-->\s*/gi
];

/**
 * 把渲染好的标签注入 index.html：
 *   1. 删掉写死的 description / robots / author / og:* / twitter:* / canonical / JSON-LD
 *   2. 替换 <title>
 *   3. 在 </head> 前插入新块
 * 保留了 charset / viewport / theme-color / RSS 等无关标签。
 */
export function injectHead(html: string, meta: MetaTags, block: string): string {
  let output = html;
  for (const pattern of STALE_HEAD_PATTERNS) output = output.replace(pattern, '');

  const escapedTitle = escapeHtml(meta.title);
  output = /<title>[\s\S]*?<\/title>/i.test(output)
    ? output.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedTitle}</title>`)
    : output.replace(/<\/head>/i, `<title>${escapedTitle}</title>\n</head>`);

  return output.replace(/<\/head>/i, `${block}\n</head>`);
}

/* ---------- 构造：文章页 ---------- */

export function buildArticleMeta(row: PostRow, site: SiteIdentity, siteUrl: string): MetaTags {
  const seo = readSeoOverride(row.seo);
  const isProtected = Boolean(row.protected);

  const pageUrl = `${siteUrl}/posts/${encodeURIComponent(row.id)}/`;
  const canonical = seo.canonical || pageUrl;
  const title = seo.title || `${str(row.title) || '未命名'} · ${site.name}`;

  // 受保护文章：绝不使用正文（读取路径已把 content 清空，这里再兜一层）
  const bodyText = isProtected ? '' : stripMarkdown(str(row.content));
  const description = clamp(
    seo.desc || str(row.excerpt) || bodyText.slice(0, 200) || site.description,
    300
  );

  const image = absolutize(str(row.og_image) || str(row.cover), siteUrl);
  const tags = safeJson<string[]>(row.tags, []);
  const publishedTime = str(row.date);
  const modifiedTime = str(row.updated_at) || publishedTime;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: seo.title || str(row.title) || '未命名',
    description: seo.desc || str(row.excerpt) || '',
    datePublished: publishedTime,
    dateModified: modifiedTime,
    author: { '@type': 'Person', name: site.author },
    publisher: { '@type': 'Organization', name: site.name },
    mainEntityOfPage: pageUrl
  };
  if (image) jsonLd.image = image;
  if (tags.length) jsonLd.keywords = tags;

  return {
    title,
    description,
    canonical,
    // 受保护文章默认不索引：正文本来就不该被搜索引擎收录
    robots: seo.noindex || isProtected ? ROBOTS_NOINDEX : ROBOTS_INDEX,
    ogType: 'article',
    ogTitle: title,
    ogDescription: description,
    ogUrl: pageUrl,
    ogImage: image,
    ogSiteName: site.name,
    author: site.author,
    publishedTime,
    tags,
    jsonLd
  };
}

/* ---------- 构造：首页 ---------- */

export function buildHomeMeta(site: SiteIdentity, siteUrl: string, options: { noindex?: boolean } = {}): MetaTags {
  const homeUrl = `${siteUrl}/`;
  return {
    title: site.name,
    description: clamp(site.description, 300),
    canonical: homeUrl,
    robots: options.noindex ? ROBOTS_NOINDEX : ROBOTS_INDEX,
    ogType: 'website',
    ogTitle: site.name,
    ogDescription: clamp(site.description, 300),
    ogUrl: homeUrl,
    ogImage: absolutize(site.avatar, siteUrl),
    ogSiteName: site.name,
    author: site.author,
    publishedTime: '',
    tags: [],
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: site.name,
      url: homeUrl,
      description: site.description
    }
  };
}