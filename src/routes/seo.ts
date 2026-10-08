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
  ABOUT_POSTS_SQL,
  ARCHIVE_POSTS_SQL,
  POPULAR_POSTS_SQL,
  POST_SIBLINGS_SQL,
  WIKI_POSTS_SQL,
  filterPosts,
  readSettingJson,
  renderAboutContent,
  renderArchiveContent,
  renderCategoriesContent,
  renderLinksContent,
  renderPopularContent,
  renderTagsContent,
  type FriendLink,
  type PopularRow,
} from '../ssr/pages.js';
import { readBlogConfig, readBlogVersion, type BlogAdsConfig } from '../ssr/blog-config.js';
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
import type { WikiPostRef } from '../ssr/markdown.js';

/** 广告位形状（app.js getConfig().ads） */
interface PostAds extends BlogAdsConfig {}

export interface SeoDeps {
  config: AppConfig;
  db: AppDatabase;
  /** 复用上游的安全响应头，避免两处定义漂移。 */
  securityHeaders?: () => Record<string, string>;
}

/**
 * 取 `[[双链]]` 解析用的文章索引。
 * 只有在正文里真的出现 `[[` 时才调用，避免每个页面都多一次查询；
 * 查询失败时返回空数组，双链降级为 `.missing`（与前端索引未加载时一致）。
 */
async function readWikiPosts(db: AppDatabase): Promise<WikiPostRef[]> {
  try {
    return await db.all<WikiPostRef>(WIKI_POSTS_SQL);
  } catch {
    return [];
  }
}

/**
 * 取「上一篇 / 下一篇 / 系列导航」需要的兄弟文章列表。
 * 查询失败返回空数组——此时 renderPostContent 只用当前文章算，导航为空，
 * app.js 接手后会补上完整导航，不会因此报错。
 */
async function readSiblings(db: AppDatabase): Promise<PostRow[]> {
  try {
    return (await db.all<PostRow>(POST_SIBLINGS_SQL)) ?? [];
  } catch {
    return [];
  }
}

/** 复刻 app.js getConfig() 的 `ads = Object.assign({}, cfg.ads, features.ads)`。 */
function mergeAds(
  base: BlogAdsConfig | undefined,
  override: BlogAdsConfig | undefined
): PostAds {
  return { ...(base ?? {}), ...(override ?? {}) };
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
      const tag = url.searchParams.get('tag') ?? '';
      const category = url.searchParams.get('category') ?? '';
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      // 概览卡与标签行统计的是**全量**已发布文章，分页在渲染时按 features.pageSize 处理
      const posts = await db.all<PostRow>(HOME_POSTS_SQL);
      if (posts.length) {
        const chrome = await readChrome(db, site.name);
        // 带上查询串：/?category=名称 时服务端就能高亮对应的分类子项
        withList = injectAppContent(
          shell,
          wrapWithChrome(
            chrome,
            renderHomeContent(posts, site, chrome, { tag, category, page }),
            url.pathname + url.search
          )
        );
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

    // 双链索引只在正文真的用了 `[[` 时才查，避免每篇文章多一次查询
    const needsWiki = String(row.content ?? '').includes('[[');
    const [wikiPosts, siblings, chrome, blog, features] = await Promise.all([
      needsWiki ? readWikiPosts(db) : Promise.resolve([] as WikiPostRef[]),
      readSiblings(db),
      readChrome(db, site.name),
      readBlogConfig(config.publicDir),
      readSettingJson<{ ads?: { enabled?: boolean; content?: string } }>(db, 'features', {})
    ]);
    // 广告位：app.js 的 getConfig() 是 Object.assign({}, cfg.ads, features.ads)
    const ads = mergeAds(blog.ads, features.ads);
    const postContent = renderPostContent(row, {
      site,
      wikiPosts,
      siblings,
      siteUrl: config.siteUrl,
      ads
    });
    const articleUrl = new URL(c.req.url);
    const withBody = postContent
      ? injectAppContent(shell, wrapWithChrome(chrome, postContent, articleUrl.pathname + articleUrl.search))
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
        const listUrl = new URL(c.req.url);
        withContent = injectAppContent(
          shell,
          wrapWithChrome(chrome, render(posts, site), listUrl.pathname + listUrl.search)
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

  // 关于页：AboutContext 需要「站点信息 + 个人资料 + 全量文章 + 前端版本号」，
  // 缺任何一样都会让 SSR 少一块 DOM（作者卡 / 统计卡 / 版本行），app.js 接管时再补上就跳动。
  const about = makePage(async (site) => {
    const [siteCfg, profile, posts] = await Promise.all([
      readSettingJson<{ about?: string }>(db, 'site_info', {}),
      readSettingJson<{ name?: string; bio?: string; avatar?: string }>(db, 'profile', {}),
      db.all<PostRow>(ABOUT_POSTS_SQL)
    ]);
    const md = String(siteCfg.about || '');
    const wikiPosts = md.includes('[[') ? await readWikiPosts(db) : [];
    // 版本号取 index.html 的 ?v=（铁律 1：全站版本统一），app.js 里同一个 BLOG_VERSION
    const blogVersion = await readBlogVersion(config.publicDir);
    return renderAboutContent({
      markdown: md,
      site,
      posts,
      profile,
      blogVersion,
      // 本后端恒提供 /api，对应 app.js 的 _cloudOn() 为真
      cloudMode: true,
      wikiPosts
    });
  }, '/about', '关于');

  const links = makePage(async () => {
    // 友链存在 `friend_links` 键下（与 app.js 的 `cfg.friendLinks = parseArrSafe(s && s.friend_links)` 一致）。
    // 早期这里读的是 `footer.links`，会把站长配好的友链渲染成空列表。
    const cfg = await readSettingJson<{ links?: FriendLink[] } | FriendLink[]>(db, 'friend_links', {});
    return renderLinksContent(Array.isArray(cfg) ? cfg : cfg.links || []);
  }, '/links', '友情链接');

  const popular = makePage(async () => {
    const posts = await db.all<PopularRow>(POPULAR_POSTS_SQL);
    return renderPopularContent(posts);
  }, '/popular', '热门文章');

  return { home, article, archive, tags, categories, about, links, popular };
}