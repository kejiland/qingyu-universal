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
  SERIES_POSTS_SQL,
  readSettingJson,
  renderAboutContent,
  renderGuestbookContent,
  renderLinksContent,
  renderPopularContent,
  renderSeriesContent,
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
import { readChrome, wrapWithChrome, type ActiveState, type ChromeData } from '../ssr/chrome.js';
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

/** 可短期缓存的 HTML（列表页 / 静态页）缓存策略：1 分钟新鲜 + 10 分钟后台刷新。 */
const LIST_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600';

/** 把整批 site_settings 折成一个稳定指纹，用于静态页的 ETag。 */
function fingerprintOfSettings(rows: Array<{ k: string; v: string }>): string {
  return rows.map((r) => `${r.k}=${r.v}`).join('|');
}

function activeOf(c: Context): ActiveState {
  const url = new URL(c.req.url);
  return { path: url.pathname.replace(/\/+$/, '') || '/', category: url.searchParams.get('category') || '' };
}

/** 当前请求的导航高亮状态：路径 + 首页 ?category= 选中的分类。 */
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
  series: (c: Context) => Promise<Response>;
  guestbook: (c: Context) => Promise<Response>;
}

export function createSeoHandlers(deps: SeoDeps): SeoHandlers {
  const { config, db } = deps;
  const loadShell = createShellLoader(config.publicDir);
  const security = (): Record<string, string> => deps.securityHeaders?.() ?? {};

  const home = async (c: Context): Promise<Response> => {
    const shell = await loadShell();
    // 首页同样只读一次 site_settings：站点身份与顶栏/页脚共用同一批数据。
    let settingsRows: Array<{ k: string; v: string }> = [];
    try {
      settingsRows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
    } catch {
      settingsRows = [];
    }
    const site = await readSiteIdentity(db, settingsRows);
    const meta = buildHomeMeta(site, config.siteUrl);

    let withList = shell;
    // ETag 指纹要在 try 外可见：列表查询失败时为空串，同样能算出一个稳定的 ETag。
    let fingerprint = '';
    // tag / category 必须进指纹：不同筛选条件可能筛出同一批文章，
    // 若只按列表算指纹，两种条件的 ETag 会撞在一起，浏览器拿到 304
    // 却显示的是另一种筛选的页面。
    let filterKey = '';
    try {
      const url = new URL(c.req.url);
      const tag = url.searchParams.get('tag');
      const category = url.searchParams.get('category');
      filterKey = `${tag ?? ''}|${category ?? ''}`;
      let posts = await db.all<PostRow>(HOME_POSTS_SQL);
      if (tag || category) {
        const all = await db.all<PostRow>(ARCHIVE_POSTS_SQL);
        posts = filterPosts(all, { tag, category }).slice(0, 10);
      }
      // 同 article 页：updated_at 从不被写入，光看它无法反映正文变化，
      // 这里把参与渲染的字段一起纳入，避免允许缓存后出现「改了还是旧内容」。
      fingerprint = posts
        .map((p) => `${p.id}:${p.title ?? ''}:${p.excerpt ?? ''}:${(p.content ?? '').length}:${p.tags ?? ''}:${p.category ?? ''}:${p.pinned ?? ''}:${p.protected ?? ''}`)
        .join('|');
      if (posts.length) {
        const chrome = await readChrome(db, site.name, settingsRows);
        withList = injectAppContent(shell, wrapWithChrome(chrome, renderHomeContent(posts, site), { path: '/', category: category || '' }));
      }
    } catch {
      /* 查询失败时回落到原始外壳，不影响页面可用性 */
    }

    const html = injectHead(withList, meta, renderHeadBlock(meta));
    /* ETag 必须含内容指纹：此前只按 'home' + siteUrl 计算，是个常量，
     * 于是「文章列表变了但 ETag 不变」 —— 违反 HTTP 语义。眼下首页没有走
     * If-None-Match 协商（所以暂未表现为内容不更新），但一旦前面挂了
     * CDN / 反向代理按 ETag 做缓存，新发布的文章就永远推不到访客和爬虫。
     * 这里把列表里每篇的 id 与更新时间纳入指纹。 */
    const etag = weakEtag('home', config.siteUrl, filterKey, fingerprint);
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': LIST_CACHE_CONTROL, ...security() }
      });
    }
    // 首页列表同样是「未更新前静态」的内容：允许短期复用 + 后台刷新，
    // 新文章发布时 ETag 立刻变化，会强制回源，不会被压住 60 秒。
    return htmlResponse(c, html, {
      'Cache-Control': LIST_CACHE_CONTROL,
      ETag: etag,
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

    // 文章页只需要读一次 site_settings：站点身份与顶栏/页脚共用同一批数据，
    // 避免首次打开一篇文章时把整张设置表连续查两遍。
    let settingsRows: Array<{ k: string; v: string }> = [];
    try {
      settingsRows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
    } catch {
      settingsRows = [];
    }
    const site = await readSiteIdentity(db, settingsRows);
    const meta = buildArticleMeta(row, site, config.siteUrl);
    /* ETag 必须反映**正文本身**。
     * 之前只按 (id, updated_at ?? date) 算，而上游写路径从不写 updated_at，
     * 于是同一天内改一次文章，ETag 纹丝不动 —— 配合 no-cache 时浏览器会拿到
     * 304 并继续显示旧正文；一旦允许短期缓存，后果从「偶尔看到旧内容」
     * 放大成「60 秒内所有人都看到旧内容」。所以把参与渲染的字段一起纳入指纹。
     * 代价只是对几 KB 文本做一次 sha1，微秒级，换来「改了立刻生效」。 */
    const etag = weakEtag(
      'post',
      row.id,
      row.updated_at ?? row.date,
      row.title,
      row.excerpt,
      row.content,
      row.cover,
      row.og_image,
      row.tags,
      row.category,
      row.series,
      row.author,
      row.seo,
      row.pinned,
      row.protected
    );
    const cacheControl = row.protected
      ? 'private, no-cache'
      : 'public, max-age=60, stale-while-revalidate=600';

    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl, ...security() } });
    }

    const content = renderPostContent(row, site);
    const chrome = await readChrome(db, site.name, settingsRows);
    const withBody = content
      ? injectAppContent(shell, wrapWithChrome(chrome, content, activeOf(c)))
      : shell;
    const html = injectHead(withBody, meta, renderHeadBlock(meta));
    // 已发布正文在未更新前是静态的：允许浏览器/前置代理短期复用，
    // ETag 保证文章一改就立刻回源；动态评论和浏览数仍由 API 单独读取。
    return htmlResponse(c, html, {
      'Cache-Control': cacheControl,
      ETag: etag,
      ...security()
    });
  };

  function makeListPage(render: (posts: PostRow[], site: SiteIdentity) => string, pagePath: string) {
    return async (c: Context): Promise<Response> => {
      const shell = await loadShell();
      let settingsRows: Array<{ k: string; v: string }> = [];
      try {
        settingsRows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
      } catch {
        settingsRows = [];
      }
      const site = await readSiteIdentity(db, settingsRows);
      let withContent = shell;
      let fingerprint = '';
      try {
        const posts = await db.all<PostRow>(ARCHIVE_POSTS_SQL);
        const chrome = await readChrome(db, site.name, settingsRows);
        withContent = injectAppContent(
          shell,
          wrapWithChrome(chrome, render(posts, site), activeOf(c))
        );
        fingerprint = posts
          .map((p) => `${p.id}:${p.title ?? ''}:${p.excerpt ?? ''}:${(p.content ?? '').length}:${p.tags ?? ''}:${p.category ?? ''}`)
          .join('|');
      } catch {
        /* 查询失败时回落到原始外壳 */
      }
      // 与文章页同策略：列表页内容在文章改动前是静态的，允许短期复用。
      const etag = weakEtag(pagePath, config.siteUrl, fingerprint);
      if (fingerprint && c.req.header('if-none-match') === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': LIST_CACHE_CONTROL, ...security() }
        });
      }
      return htmlResponse(c, withContent, {
        'Cache-Control': fingerprint ? LIST_CACHE_CONTROL : 'no-cache',
        ETag: etag,
        ...security()
      });
    };
  }

  const archive = makeListPage(renderArchiveContent, '/archive');
  const tags = makeListPage(renderTagsContent, '/tags');
  const categories = makeListPage(renderCategoriesContent, '/categories');

  function makePage(render: (site: SiteIdentity, chrome: ChromeData) => string | Promise<string>, pagePath: string, title: string, desc?: string) {
    return async (c: Context): Promise<Response> => {
      const shell = await loadShell();
      let settingsRows: Array<{ k: string; v: string }> = [];
      try {
        settingsRows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
      } catch {
        settingsRows = [];
      }
      const site = await readSiteIdentity(db, settingsRows);
      const chrome = await readChrome(db, site.name, settingsRows);
      let withContent = shell;
      try {
        withContent = injectAppContent(shell, wrapWithChrome(chrome, await render(site, chrome), { path: pagePath, category: '' }));
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
      // 关于/友链这类页面只有站点设置会变，跟着设置一起做指纹即可。
      const etag = weakEtag('page', pagePath, config.siteUrl, meta.title, meta.description, fingerprintOfSettings(settingsRows));
      if (c.req.header('if-none-match') === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': LIST_CACHE_CONTROL, ...security() }
        });
      }
      return htmlResponse(c, injectHead(withContent, meta, renderHeadBlock(meta)), {
        'Cache-Control': LIST_CACHE_CONTROL,
        ETag: etag,
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

  // /series 与 /guestbook 此前没有 SSR：只返回空外壳，要等 app.js 延迟加载
  // （实测 3~5s）才有内容，首屏长时间空白。补上后与其余公开页一致。
  const series = makePage(async () => {
    const posts = await db.all<PostRow>(SERIES_POSTS_SQL);
    return renderSeriesContent(posts);
  }, '/series', '系列');

  const guestbook = makePage(async () => renderGuestbookContent(), '/guestbook', '留言板');

  return { home, article, archive, tags, categories, about, links, popular, series, guestbook };
}

