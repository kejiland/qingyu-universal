/* ============================================================
 * 静态站导出（服务端打包）
 * ------------------------------------------------------------
 * 把整站渲染成一份可以丢给任意静态托管的 ZIP：HTML 页面在这里用与
 * /api/... 服务端 SEO 完全相同的那套 SSR 渲染器生成，app.min.js
 * 只在页面内容缺失的地方（系列、历史、留言板、订阅等）接管。
 *
 * 为什么在服务端做：原版在浏览器里导出，文章多起来会卡住页面，
 * 而且拿不到服务端才有的阅读量、统计与 SEO 渲染结果。
 *
 * 已知限制（与原版一致，写进 ZIP 里的说明文件）：
 *   1. 不含图片 / 音频等媒体本体，文章里的媒体仍指向原地址；
 *   2. 纯静态下前端只读 config.min.js 里的 site / footer，
 *      自定义导航与页脚菜单会回到默认值；
 *   3. 加密文章只带密文，读者仍需输入密码；
 *   4. 统计、评论、搜索等依赖接口的功能在静态站里不可用。
 * ============================================================ */
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../types.js';
import type { ZipEntry } from '../lib/zip.js';
import { readChrome, wrapWithChrome } from './chrome.js';
import { readBlogVersion } from './blog-config.js';
import { injectAppContent, renderPostContent } from './post.js';
import { toClientPost } from './post-payload.js';
import { renderHomeContent } from './list.js';
import {
  POPULAR_POSTS_SQL,
  readSettingJson,
  renderAboutContent,
  renderArchiveContent,
  renderCategoriesContent,
  renderLinksContent,
  renderPopularContent,
  renderTagsContent,
  type FriendLink
} from './pages.js';
import {
  buildArticleMeta,
  buildHomeMeta,
  injectHead,
  readSiteIdentity,
  renderHeadBlock,
  type PostRow,
  type SiteIdentity
} from '../seo/meta.js';
import { formatDate } from './format.js';

interface StaticPostRow extends PostRow {
  enc?: string | null;
  author?: string | null;
  series_order?: number | null;
  views?: number | null;
}

export const PUBLISHED_POSTS_SQL =
  "SELECT * FROM posts WHERE COALESCE(status, 'published') = 'published' ORDER BY date DESC";

/** 只在本地渲染、静态站里没有对应页面的路由：留空壳交给 app.min.js。 */
const SHELL_ONLY_PAGES: Array<[string, string]> = [
  ['history', '历史'],
  ['series', '系列'],
  ['guestbook', '留言板'],
  ['subscribe', '订阅'],
  ['authors', '作者']
];

export interface StaticSiteDeps {
  config: AppConfig;
  db: AppDatabase;
}

export interface StaticSiteResult {
  files: ZipEntry[];
  postCount: number;
  skippedAssets: string[];
}

/* ---------- 小工具 ---------- */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 把数据库行转成 app.js 期望的文章形态 —— 映射器与 /posts.min.js 共用，
 *  避免「静态导出的 posts.min.js」与「服务端动态生成的 posts.min.js」不同形。 */
export { toClientPost };

/** 读 JSON（数组也接受，用于 static-export.json 清单）。 */
function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as T;
    } catch {
      /* 坏 JSON 按兜底值处理 */
    }
  }
  return fallback;
}

/** 文章 id 可能是任意字符串，做成目录名时必须转义，否则会穿出目录层。 */
function postDir(id: string): string {
  return encodeURIComponent(str(id) || 'post');
}

/**
 * 静态化的最后一步：把页面里的绝对站内地址改成相对地址。
 * 页面会被放到 /posts/<id>/index.html 这类子目录里，原来的 /style.min.css
 * 就会指向站点根目录；改成 ../../style.min.css 后，丢进任何目录都能打开。
 *
 * 带协议（http:、mailto:、data:）与纯锚点的地址原样保留 —— 原版这里是
 * 一刀切替换，会把 mailto: 之类也改坏。
 */
function finalize(html: string, base: string): string {
  const withoutSw = html.replace(/<script\b[^>]*>[^<]*navigator\.serviceWorker[\s\S]*?<\/script>\s*/gi, '');
  return withoutSw.replace(/\b(href|src)="([^"]*)"/gi, (match, attr: string, value: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value) || value === '') return match;
    const clean = value.startsWith('/') ? value.slice(1) : value;
    return `${attr}="${base}${clean}"`;
  });
}

/** 友链是后台自由填的，字段可能缺失/类型不对，逐条兜住。 */
function toFriendLinks(raw: unknown): FriendLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      name: str(item.name) || str(item.title),
      url: str(item.url) || str(item.link),
      desc: str(item.desc) || str(item.description),
      avatar: str(item.avatar) || str(item.logo)
    }))
    .filter((item) => item.name && item.url);
}


/* ---------- RSS / sitemap ---------- */

function rfc822(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return new Date(0).toUTCString();
  return date.toUTCString();
}

function xmlEscape(value: string): string {
  return str(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildFeedXml(posts: StaticPostRow[], site: SiteIdentity, siteUrl: string): string {
  const items = posts.filter((p) => !p.protected).slice(0, 20);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${xmlEscape(site.name)}</title>`,
    `<link>${xmlEscape(siteUrl)}</link>`,
    `<description>${xmlEscape(site.description)}</description>`,
    '<language>zh-CN</language>',
    `<lastBuildDate>${rfc822(str(posts[0]?.date))}</lastBuildDate>`,
    '<atom:link href="' + xmlEscape(`${siteUrl}/feed.xml`) + '" rel="self" type="application/rss+xml"/>'
  ];
  for (const post of items) {
    const link = `${siteUrl}/posts/${encodeURIComponent(str(post.id))}/`;
    lines.push(
      '<item>',
      `<title>${xmlEscape(str(post.title))}</title>`,
      `<link>${xmlEscape(link)}</link>`,
      `<guid isPermaLink="false">${xmlEscape(str(post.id))}</guid>`,
      `<pubDate>${rfc822(str(post.date))}</pubDate>`,
      `<description><![CDATA[${str(post.excerpt).replace(/]]>/g, ']]&gt;')}]]></description>`,
      '</item>'
    );
  }
  lines.push('</channel>', '</rss>');
  return lines.join('\n');
}

function buildSitemapXml(posts: StaticPostRow[], siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  const now = formatDate(new Date().toISOString());
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    `<url><loc>${xmlEscape(base)}/</loc><lastmod>${now}</lastmod></url>`,
    `<url><loc>${xmlEscape(base)}/about</loc><lastmod>${now}</lastmod></url>`,
    `<url><loc>${xmlEscape(base)}/archive</loc><lastmod>${now}</lastmod></url>`,
    `<url><loc>${xmlEscape(base)}/guestbook</loc><lastmod>${now}</lastmod></url>`
  ];
  for (const post of posts) {
    lines.push(
      `<url><loc>${xmlEscape(`${base}/posts/${encodeURIComponent(str(post.id))}/`)}</loc>` +
        `<lastmod>${formatDate(str(post.updated_at) || str(post.date))}</lastmod></url>`
    );
  }
  lines.push('</urlset>');
  return lines.join('\n');
}

/* ---------- 说明文件 ---------- */

function renderReadme(site: SiteIdentity, postCount: number, protectedCount: number): string {
  return [
    `${site.name} · 静态站导出`,
    '='.repeat(46),
    '',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `文章数量：${postCount} 篇（其中加密文章 ${protectedCount} 篇）`,
    '',
    '【怎么用】',
    '  1. 把 ZIP 里的全部文件原样上传到任意静态托管（对象存储、Pages、',
    '     Nginx、GitHub Pages 均可），保持目录结构不变。',
    '  2. 首页是 index.html；每篇文章在 posts/<文章ID>/index.html。',
    '  3. 上传后访问一次即可生效，无需任何服务端环境。',
    '',
    '【更新站点】',
    '  回到后台「导入导出」重新导出一次，覆盖旧文件即可。',
    '  静态站不会自动同步，请以最近一次导出为准。',
    '',
    '【文件说明】',
    '  posts.min.js     文章数据（前端启动时读取）',
    '  config.min.js    站点配置（站点名、备案号等）',
    '  app.min.js       前端主程序',
    '  sitemap.xml      搜索引擎收录用的站点地图',
    '  feed.xml         RSS 订阅源',
    '  404.html         页面不存在时的兜底页',
    '',
    '【请注意】',
    '  1. 本压缩包不含图片、音频等媒体文件，文章中的媒体地址仍指向',
    '     上传时的原始地址，需要对象存储可公开访问。',
    '  2. 加密文章只带密文，读者仍需在文章页输入密码。',
    '  3. 静态站下自定义导航与页脚菜单会回到默认值（这是前端在纯静态',
    '     模式下的已知限制），站点名、版权、备案号正常生效。',
    '  4. 统计、评论、在线搜索依赖接口，静态站中不可用。',
    '  5. 草稿、定时发布与加密之外的文章不会导出。',
    '  6. 受保护文章与标记了「不索引」的文章已加 noindex。',
    ''
  ].join('\n');
}

/* ---------- 主流程 ---------- */

export async function buildStaticSite(deps: StaticSiteDeps): Promise<StaticSiteResult> {
  const { config, db } = deps;
  const siteUrl = config.siteUrl.replace(/\/+$/, '');
  const site = await readSiteIdentity(db);

  const posts = (await db.all<StaticPostRow>(PUBLISHED_POSTS_SQL)) ?? [];
  if (!posts.length) {
    throw new Error('还没有已发布的文章，先发布一篇再导出静态站。');
  }

  const shell = await fsp.readFile(path.join(config.publicDir, 'index.html'), 'utf8');
  const chrome = await readChrome(db, site.name);

  /* 静态资源：以上游的 static-export.json 清单为准 */
  const manifest = await fsp
    .readFile(path.join(config.publicDir, 'static-export.json'), 'utf8')
    .then((raw) => safeJson<string[]>(raw, []))
    .catch(() => [] as string[]);

  // 上游清单里没有这两个文件（它们是我方 index.html 独有的），必须显式补上，
  // 否则导出的站会没有启动器或没有主样式。
  const assets = [...new Set([...manifest, 'boot.min.js', 'polish.min.css'])];
  const skippedAssets: string[] = [];

  const files: ZipEntry[] = [];
  for (const asset of assets) {
    if (!asset || asset.endsWith('/')) continue;
    try {
      const data = await fsp.readFile(path.join(config.publicDir, asset));
      files.push({ name: asset, data: new Uint8Array(data) });
    } catch {
      skippedAssets.push(asset);
    }
  }

  /* 数据与配置 */
  const clientPosts = posts.map(toClientPost);
  files.push({ name: 'posts.min.js', text: `window.BLOG_POSTS = ${JSON.stringify(clientPosts)};` });

  // `[[双链]]` 解析索引：静态导出里文章全量在手，直接复用，不必再查一次库
  const wikiPosts = posts.map((p) => ({ id: String(p.id), title: str(p.title) }));

  const siteCfg = await readSettingJson<Record<string, unknown>>(db, 'site_info', {});
  // 纯静态模式：前端不再请求任何接口，数据全部来自 posts.min.js。
  // 注意导航 / 页脚菜单 / 功能开关只从接口取，静态站里会回到默认值——
  // 这与原版静态导出是同一个限制，不在这里另开一套前端分支。
  //
  // 页脚必须与导出页面的 SSR 用同一份数据（chrome 已按 app.js 的规则合成），
  // 否则导出站的 HTML 页脚会带着 config.js 的声明/邮箱/友链，
  // 而 SPA 接管后（用的是这里生成的 config.min.js）又变成空的，前后不一致。
  const staticConfig = {
    mode: 'static',
    apiBase: '',
    siteUrl,
    writeToken: '',
    adminPwd: '',
    pageSize: 0,
    site: {
      name: str(siteCfg.name) || site.name,
      desc: str(siteCfg.desc) || site.description
    },
    footer: {
      text: chrome.footer.text,
      icp: chrome.footer.icp,
      decl: chrome.footer.decl,
      email: chrome.footer.email,
      startYear: chrome.footer.startYear || 2019,
      copyrightName: chrome.footer.copyrightName,
      contact: chrome.footerNav.map((it) => ({ text: it.text, url: it.url })),
      links: chrome.footer.friends.map((it) => ({ text: it.text, url: it.url }))
    },
    ads: {}
  };
  files.push({
    name: 'config.min.js',
    text: 'window.BLOG_CONFIG = ' + JSON.stringify(staticConfig) + ';',
  });

  /* 页面：首页 */
  files.push({
    name: 'index.html',
    text: finalize(
      injectHead(
        injectAppContent(
          shell,
          // 导出站的 config.min.js 里 pageSize 固定为 0（不分页、全量渲染），
          // 因此首页 SSR 也要按 pageSize:0 渲染，否则两边列表条数对不上。
          wrapWithChrome(
            chrome,
            renderHomeContent(posts, site, { ...chrome, pageSize: 0 }, {}),
            '/'
          )
        ),
        buildHomeMeta(site, siteUrl),
        renderHeadBlock(buildHomeMeta(site, siteUrl))
      ),
      ''
    )
  });

  /* 页面：文章页 */
  for (const post of posts) {
    const meta = buildArticleMeta(post, site, siteUrl);
    const content = renderPostContent(post, site, wikiPosts);
    const body = content ? injectAppContent(shell, wrapWithChrome(chrome, content, '/posts')) : shell;
    files.push({
      name: `posts/${postDir(str(post.id))}/index.html`,
      text: finalize(injectHead(body, meta, renderHeadBlock(meta)), '../../')
    });
  }

  /* 页面：列表页与固定页 */
  const listPage = (render: (list: StaticPostRow[], s: SiteIdentity) => string, pagePath: string, title: string, desc?: string) => {
    const base = buildHomeMeta(site, siteUrl);
    const meta = {
      ...base,
      title: `${title} · ${site.name}`,
      ogTitle: `${title} · ${site.name}`,
      description: desc || base.description,
      ogDescription: desc || base.description,
      canonical: siteUrl + pagePath,
      ogUrl: siteUrl + pagePath,
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: siteUrl + pagePath }
    };
    return {
      name: `${pagePath.replace(/^\//, '')}/index.html`,
      text: finalize(
        injectHead(
          injectAppContent(shell, wrapWithChrome(chrome, render(posts, site), pagePath)),
          meta,
          renderHeadBlock(meta)
        ),
        '../'
      )
    };
  };

  files.push(listPage(renderArchiveContent, '/archive', '归档'));
  files.push(listPage(renderTagsContent, '/tags', '标签'));
  files.push(listPage(renderCategoriesContent, '/categories', '分类'));

  // 固定页（关于 / 友链 / 热门）：配置读不出来时退回空壳，页面仍能打开。
  const fixedPage = async (name: string, title: string, build: () => Promise<string>): Promise<ZipEntry> => {
    const base = buildHomeMeta(site, siteUrl);
    const meta = {
      ...base,
      title: `${title} · ${site.name}`,
      ogTitle: `${title} · ${site.name}`,
      canonical: siteUrl + '/' + name,
      ogUrl: siteUrl + '/' + name,
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: siteUrl + '/' + name }
    };
    const render = async (): Promise<string> => {
      try {
        const content = await build();
        return injectAppContent(shell, wrapWithChrome(chrome, content, '/' + name));
      } catch {
        return shell;
      }
    };
    const body = await render();
    return {
      name: name + '/index.html',
      text: finalize(injectHead(body, meta, renderHeadBlock(meta)), '../')
    };
  };

  const aboutCfg = await readSettingJson<Record<string, unknown>>(db, 'site_info', {});
  const profileCfg = await readSettingJson<{ name?: string; bio?: string; avatar?: string }>(db, 'profile', {});
  // 导出站是纯静态（config.mode='static'），对应 app.js 的 _cloudOn() === false → 「静态模式」。
  // 版本号沿用线上的 index.html ?v=，保证导出站版本行与线上一致（铁律 1）。
  const exportVersion = await readBlogVersion(config.publicDir);
  // 友链在 `friend_links` 键下（与 app.js 的 cfg.friendLinks 一致），不是 footer.links
  const friendLinksCfg = await readSettingJson<Record<string, unknown> | unknown[]>(db, 'friend_links', []);
  const popularRows = await db.all<StaticPostRow>(POPULAR_POSTS_SQL);

  files.push(
    await fixedPage('about', '关于', async () =>
      renderAboutContent({
        markdown: str(aboutCfg.about),
        site,
        posts,
        profile: profileCfg,
        blogVersion: exportVersion,
        cloudMode: false,
        wikiPosts
      })
    ),
    await fixedPage('links', '友情链接', async () =>
      renderLinksContent(toFriendLinks(Array.isArray(friendLinksCfg) ? friendLinksCfg : friendLinksCfg.links))
    ),
    await fixedPage('popular', '热门文章', async () => renderPopularContent(popularRows))
  );

  /* 页面：只有前端才能渲染的路由 —— 保留启动动画，让 app.min.js 立刻接管 */
  for (const [name, label] of SHELL_ONLY_PAGES) {
    const base = buildHomeMeta(site, siteUrl, { noindex: true });
    const meta = { ...base, title: `${label} · ${site.name}`, ogTitle: `${label} · ${site.name}` };
    files.push({
      name: `${name}/index.html`,
      text: finalize(injectHead(shell, meta, renderHeadBlock(meta)), '../')
    });
  }
  files.push({ name: '404.html', text: finalize(injectHead(shell, buildHomeMeta(site, siteUrl, { noindex: true }), renderHeadBlock(buildHomeMeta(site, siteUrl, { noindex: true }))), '') });

  /* 收录与订阅 */
  files.push({ name: 'sitemap.xml', text: buildSitemapXml(posts, siteUrl) });
  files.push({ name: 'feed.xml', text: buildFeedXml(posts, site, siteUrl) });

  files.push({
    name: 'README-静态站说明.txt',
    text: renderReadme(site, posts.length, posts.filter((p) => p.protected).length)
  });

  return { files, postCount: posts.length, skippedAssets };
}
