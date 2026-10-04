/* ============================================================
 * SEO 路由：在返回 HTML 之前注入正确的 meta
 * ------------------------------------------------------------
 * 挂载点（都在 catch-all 之前，因此会先于上游 worker 命中）：
 *   GET /                  → 首页元数据 + 绝对 canonical
 *   GET /posts/:id[/]      → 文章元数据 + OG 卡片 + BlogPosting JSON-LD
 *
 * 未找到 / 草稿 / 定时发布的文章 → 与上游 SPA 回退行为一致（返回外壳，
 * 由前端渲染 404），且**不会**把标题泄露给爬虫。
 * ============================================================ */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'hono';
import type { AppConfig } from '../config.js';
import type { D1Database } from '../bindings/d1.js';
import {
  buildArticleMeta,
  buildHomeMeta,
  injectHead,
  readSiteIdentity,
  renderHeadBlock,
  type PostRow,
  type SiteIdentity
} from '../seo/meta.js';
import { injectAppContent, renderPostContent } from '../ssr/post.js';
import { HOME_POSTS_SQL, renderHomeContent } from '../ssr/list.js';
import { weakEtag } from '../etag.js';
import { readChrome, wrapWithChrome } from '../ssr/chrome.js';
import {
  ARCHIVE_POSTS_SQL,
  filterPosts,
  renderArchiveContent,
  renderCategoriesContent,
  renderTagsContent
} from '../ssr/pages.js';

export interface SeoDeps {
  config: AppConfig;
  db: D1Database;
  /** 复用上游的安全响应头，避免两处定义漂移。 */
  securityHeaders?: () => Record<string, string>;
}

function htmlResponse(c: Context, html: string, extra: Record<string, string>): Response {
  return new Response(c.req.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(html)),
      ...extra
    }
  });
}

/** index.html 外壳缓存：按 mtime 失效，改文件无需重启进程。 */
function createShellLoader(publicDir: string) {
  let cache: { html: string; mtimeMs: number } | null = null;
  return async (): Promise<string> => {
    const file = path.join(publicDir, 'index.html');
    const stat = await fsp.stat(file);
    if (!cache || cache.mtimeMs !== stat.mtimeMs) {
      cache = { html: await fsp.readFile(file, 'utf8'), mtimeMs: stat.mtimeMs };
    }
    return cache.html;
  };
}

export interface SeoHandlers {
  home: (c: Context) => Promise<Response>;
  article: (c: Context) => Promise<Response>;
  archive: (c: Context) => Promise<Response>;
  tags: (c: Context) => Promise<Response>;
  categories: (c: Context) => Promise<Response>;
}

export function createSeoHandlers(deps: SeoDeps): SeoHandlers {
  const { config, db } = deps;
  const loadShell = createShellLoader(config.publicDir);
  const security = (): Record<string, string> => deps.securityHeaders?.() ?? {};

  const home = async (c: Context): Promise<Response> => {
    const shell = await loadShell();
    const site = readSiteIdentity(db);
    const meta = buildHomeMeta(site, config.siteUrl);

    // 把最新文章列表渲染进 #app，让爬虫与首屏无需等待 JS
    let withList = shell;
    try {
      // 带 ?tag= / ?category= 时按条件筛选（标签是 JSON 数组，需取全量后比对）
      const url = new URL(c.req.url);
      const tag = url.searchParams.get('tag');
      const category = url.searchParams.get('category');
      let posts = db.native.prepare(HOME_POSTS_SQL).all() as unknown as PostRow[];
      if (tag || category) {
        const all = db.native.prepare(ARCHIVE_POSTS_SQL).all() as unknown as PostRow[];
        posts = filterPosts(all, { tag, category }).slice(0, 10);
      }
      if (posts.length) {
        const chrome = readChrome(db, site.name);
        withList = injectAppContent(shell, wrapWithChrome(chrome, renderHomeContent(posts, site), '/'));
      }
    } catch {
      /* 查询失败时回落到原始外壳，不影响页面可用性 */
    }

    const html = injectHead(withList, meta, renderHeadBlock(meta));
    return htmlResponse(c, html, {
      'Cache-Control': 'no-cache',
      ETag: weakEtag('home', config.siteUrl),
      ...security()
    });
  };

  const article = async (c: Context): Promise<Response> => {
    const shell = await loadShell();

    let id = c.req.param('id') ?? '';
    try {
      id = decodeURIComponent(id);
    } catch {
      /* 保留原值，按未找到处理 */
    }

    let row: PostRow | undefined;
    try {
      row = db.native.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
    } catch {
      row = undefined;
    }

    // 草稿 / 定时 / 已删除：只注入站点级信息并标记 noindex。
    // 既不会泄露文章标题，又让这类页面的分享卡片显示正确的站点名，
    // 而不是 index.html 里写死的上游默认值。
    if (!row || String(row.status || 'published') !== 'published') {
      const fallbackSite = readSiteIdentity(db);
      const fallbackMeta = buildHomeMeta(fallbackSite, config.siteUrl, { noindex: true });
      const fallbackHtml = injectHead(shell, fallbackMeta, renderHeadBlock(fallbackMeta));
      return htmlResponse(c, fallbackHtml, { 'Cache-Control': 'no-cache', ...security() });
    }

    const site = readSiteIdentity(db);
    const meta = buildArticleMeta(row, site, config.siteUrl);
    const etag = weakEtag('post', row.id, row.updated_at ?? row.date);

    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...security() } });
    }

    // 先把正文渲染进 #app，再注入 head 元数据。
    // app.js 启动后会照常接管 #app —— 标记同构，因此是原地替换。
    const content = renderPostContent(row, site);
    const chrome = readChrome(db, site.name);
    const withBody = content
      ? injectAppContent(shell, wrapWithChrome(chrome, content, new URL(c.req.url).pathname))
      : shell;
    const html = injectHead(withBody, meta, renderHeadBlock(meta));
    return htmlResponse(c, html, { 'Cache-Control': 'no-cache', ETag: etag, ...security() });
  };

  /** 归档 / 标签 / 分类：同一套「查全量已发布文章 → 渲染对应结构」的模式。 */
  function makeListPage(render: (posts: PostRow[], site: SiteIdentity) => string) {
    return async (c: Context): Promise<Response> => {
      const shell = await loadShell();
      const site = readSiteIdentity(db);
      let withContent = shell;
      try {
        const posts = db.native.prepare(ARCHIVE_POSTS_SQL).all() as unknown as PostRow[];
        const chrome = readChrome(db, site.name);
        withContent = injectAppContent(
          shell,
          wrapWithChrome(chrome, render(posts, site), new URL(c.req.url).pathname)
        );
      } catch {
        /* 查询失败时回落到原始外壳 */
      }
      return htmlResponse(c, withContent, { 'Cache-Control': 'no-cache', ...security() });
    };
  }

  const archive = makeListPage(renderArchiveContent);
  const tags = makeListPage(renderTagsContent);
  const categories = makeListPage(renderCategoriesContent);

  return { home, article, archive, tags, categories };
}