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
import type { AppDatabase } from '../types.js';
import {
  POPULAR_POSTS_SQL,
  readSettingJson,
  renderAboutContent,
  renderLinksContent,
  renderPopularContent,
  type FriendLink,
} from '../ssr/pages.js';
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
import { readChrome, wrapWithChrome, type ChromeData } from '../ssr/chrome.js';
import {
  ARCHIVE_POSTS_SQL,
  filterPosts,
  renderArchiveContent,
  renderCategoriesContent,
  renderTagsContent
} from '../ssr/pages.js';

export interface SeoDeps {
  config: AppConfig;
  db: AppDatabase;
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
  about: (c: Context) => Promise<Response>;
  links: (c: Context) => Promise<Response>;
  popular: (c: Context) => Promise<Response>;
}

export function createSeoHandlers(deps: SeoDeps): SeoHandlers {
  const { config, db } = deps;
  const loadShell = createShellLoader(config.publicDir);
  const security = (): Record<string, string> => deps.securityHeaders?.() ?? {};

  const home = async (c: Context): Promise<Response> => {
    const shell = await loadShell();
    const site = await readSiteIdentity(db);
    const meta = buildHomeMeta(site, config.siteUrl);

    let withList = shell;
    try {
      const url = new URL(c.req.url);
      const tag = url.searchParams.get('tag');
      const category = url.searchParams.get('category');
      let posts = await db.all<PostRow>(HOME_POSTS_SQL);
      if (tag || category) {
        const all = await db.all<PostRow>(ARCHIVE_POSTS_SQL);
        posts = filterPosts(all, { tag, category }).slice(0, 10);
      }
      if (posts.length) {
        const chrome = await readChrome(db, site.name);
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
      row = await db.first<PostRow>('SELECT * FROM posts WHERE id = ?', id) ?? undefined;
    } catch {
      row = undefined;
    }

    if (!row || String(row.status || 'published') !== 'published') {
      const fallbackSite = await readSiteIdentity(db);
      const fallbackMeta = buildHomeMeta(fallbackSite, config.siteUrl, { noindex: true });
      const fallbackHtml = injectHead(shell, fallbackMeta, renderHeadBlock(fallbackMeta));
      return htmlResponse(c, fallbackHtml, { 'Cache-Control': 'no-cache', ...security() });
    }

    const site = await readSiteIdentity(db);
    const meta = buildArticleMeta(row, site, config.siteUrl);
    const etag = weakEtag('post', row.id, row.updated_at ?? row.date);

    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...security() } });
    }

    const content = renderPostContent(row, site);
    const chrome = await readChrome(db, site.name);
    const withBody = content
      ? injectAppContent(shell, wrapWithChrome(chrome, content, new URL(c.req.url).pathname))
      : shell;
    const html = injectHead(withBody, meta, renderHeadBlock(meta));
    return htmlResponse(c, html, { 'Cache-Control': 'no-cache', ETag: etag, ...security() });
  };

  function makeListPage(render: (posts: PostRow[], site: SiteIdentity) => string) {
    return async (c: Context): Promise<Response> => {
      const shell = await loadShell();
      const site = await readSiteIdentity(db);
      let withContent = shell;
      try {
        const posts = await db.all<PostRow>(ARCHIVE_POSTS_SQL);
        const chrome = await readChrome(db, site.name);
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

  function makePage(render: (site: SiteIdentity, chrome: ChromeData) => string | Promise<string>, pagePath: string, title: string, desc?: string) {
    return async (c: Context): Promise<Response> => {
      const shell = await loadShell();
      const site = await readSiteIdentity(db);
      const chrome = await readChrome(db, site.name);
      let withContent = shell;
      try {
        withContent = injectAppContent(shell, wrapWithChrome(chrome, await render(site, chrome), pagePath));
      } catch {
        /* 查询失败时回落到原始外壳 */
      }
      const base = buildHomeMeta(site, config.siteUrl);
      const meta = {
        ...base,
        title: title + ' · ' + site.name,
        ogTitle: title + ' · ' + site.name,
        description: desc || base.description,
        ogDescription: desc || base.description,
        canonical: config.siteUrl + pagePath,
        ogUrl: config.siteUrl + pagePath,
        jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: config.siteUrl + pagePath }
      };
      return htmlResponse(c, injectHead(withContent, meta, renderHeadBlock(meta)), {
        'Cache-Control': 'no-cache',
        ...security()
      });
    };
  }

  const about = makePage(async (site) => {
    const siteCfg = await readSettingJson<{ about?: string }>(db, 'site', {});
    return renderAboutContent(String(siteCfg.about || ''), site);
  }, '/about', '关于');

  const links = makePage(async () => {
    const footerCfg = await readSettingJson<{ links?: FriendLink[] }>(db, 'footer', {});
    return renderLinksContent(footerCfg.links || []);
  }, '/links', '友链');

  const popular = makePage(async () => {
    const posts = await db.all<PostRow>(POPULAR_POSTS_SQL);
    return renderPopularContent(posts);
  }, '/popular', '热门');

  return { home, article, archive, tags, categories, about, links, popular };
}