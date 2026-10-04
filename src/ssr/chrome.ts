/* ============================================================
 * 公开站 SSR：站点框架（顶栏 / 页脚）
 * ------------------------------------------------------------
 * 之前只渲染了 <main>（正文区），顶栏与页脚仍由 app.js 在加载后补上，
 * 于是页面会先显示"只有正文"，随后突然长出导航栏和页脚 —— 明显的布局跳动。
 *
 * 这里把框架也服务端渲染出来，标记对齐 app.js 的 renderNav() / renderFooter()：
 *   header.topbar > .container.topbar-inner > .topbar-left + nav.main-nav + .topbar-actions
 *   footer > .container.footer-inner > .footer-nav + .footer-copy
 *
 * 图标按钮（语言/主题/搜索/配色）只渲染 <button class="icon-btn"> 空壳：
 * CSS 给了 .icon-btn 固定 34×34 尺寸，因此空间能占住，
 * 图标与交互仍由 app.js 接管后填充。
 * ============================================================ */
import { escapeHtml } from '../seo/meta.js';
import type { D1Database } from '../bindings/d1.js';

export interface NavItem {
  text: string;
  url: string;
  children?: NavItem[];
}

export interface ChromeData {
  siteName: string;
  nav: NavItem[];
  footer: {
    copyrightName: string;
    startYear: string;
    icp: string;
  };
}

/** app.js 在站点未配置导航时使用的默认项（与前台可见菜单一致）。 */
const DEFAULT_NAV: NavItem[] = [
  { text: '首页', url: '/' },
  { text: '归档', url: '/archive' },
  { text: '标签', url: '/tags' },
  { text: '分类', url: '/categories' },
  { text: '关于', url: '/about' },
  { text: '留言板', url: '/guestbook' }
];

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function normalizeNav(raw: unknown): NavItem[] {
  if (!Array.isArray(raw)) return DEFAULT_NAV;
  const items = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      text: str(item.text),
      url: str(item.url) || '/',
      ...(Array.isArray(item.children)
        ? {
            children: item.children
              .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
              .map((c) => ({ text: str(c.text), url: str(c.url) || '/' }))
          }
        : {})
    }))
    .filter((item) => item.text && item.url);
  return items.length ? items : DEFAULT_NAV;
}

/** 站点框架的配置来源与 app.js 相同：site_settings 的 nav / footer / site。 */
export function readChrome(db: D1Database, siteName: string): ChromeData {
  let map = new Map<string, string>();
  try {
    const rows = db.native.prepare('SELECT k, v FROM site_settings').all() as Array<{ k: string; v: string }>;
    map = new Map(rows.map((row) => [row.k, row.v]));
  } catch {
    /* 读取失败时用默认值 */
  }

  const footer = safeJson<Record<string, unknown>>(map.get('footer'), {});
  const site = safeJson<Record<string, unknown>>(map.get('site'), {});

  return {
    siteName: str(site.name) || siteName,
    nav: normalizeNav(safeJson<unknown>(map.get('nav'), null)),
    footer: {
      copyrightName: str(footer.copyrightName) || siteName,
      startYear: str(footer.startYear),
      icp: str(footer.icp)
    }
  };
}

/* ---------- 渲染 ---------- */

function linkFor(item: NavItem, activePath: string): string {
  const url = item.url;
  const isActive = url === activePath || (url !== '/' && activePath.startsWith(url));
  if (item.children?.length) {
    const sub = item.children
      .map((c) => `<a href="${escapeHtml(c.url)}">${escapeHtml(c.text)}</a>`)
      .join('');
    return (
      `<div class="nav-item has-sub">` +
      `<a href="${escapeHtml(url)}" class="${isActive ? 'active' : ''}">${escapeHtml(item.text)}</a>` +
      `<div class="sub-menu">${sub}</div></div>`
    );
  }
  return (
    `<div class="nav-item"><a href="${escapeHtml(url)}" class="${isActive ? 'active' : ''}">` +
    `${escapeHtml(item.text)}</a></div>`
  );
}

export function renderTopbar(chrome: ChromeData, activePath: string): string {
  const links = chrome.nav.map((item) => linkFor(item, activePath)).join('');
  // 空壳按钮：.icon-btn 固定 34×34，占位正确；图标与事件由 app.js 接管后填充
  const iconBtn = '<button class="icon-btn" tabindex="-1" aria-hidden="true"></button>';

  return (
    '<header class="topbar"><div class="container topbar-inner">' +
    '<div class="topbar-left">' +
    '<button class="hamburger-btn" id="hamburgerBtn" aria-label="打开菜单"><span></span><span></span><span></span></button>' +
    `<a class="brand" href="/">${escapeHtml(chrome.siteName)}</a>` +
    '</div>' +
    `<nav class="main-nav">${links}</nav>` +
    `<div class="topbar-actions">${iconBtn.repeat(4)}</div>` +
    '</div><div class="search-panel" id="searchPanel"></div></header>'
  );
}

export function renderFooter(chrome: ChromeData): string {
  const navHtml = chrome.nav
    .map((item) => `<a href="${escapeHtml(item.url)}">${escapeHtml(item.text)}</a>`)
    .join('<span class="footer-dot">·</span>');

  const year = new Date().getFullYear();
  const start = chrome.footer.startYear || String(year);
  const range = start === String(year) ? start : `${start}–${year}`;
  const icp = chrome.footer.icp ? ` <span class="footer-icp">${escapeHtml(chrome.footer.icp)}</span>` : '';

  return (
    '<footer><div class="container footer-inner">' +
    `<div class="footer-nav">${navHtml}` +
    '<span class="footer-dot footer-rss">·</span><a class="footer-rss" href="/feed.xml">RSS</a>' +
    '<span class="footer-dot">·</span><a href="/subscribe">订阅</a></div>' +
    `<div class="footer-copy">© ${escapeHtml(range)} ${escapeHtml(chrome.footer.copyrightName)}${icp}</div>` +
    '</div></footer>'
  );
}

/** 按 app.js 的顺序组装整页：顶栏 + 正文 + 页脚。 */
export function wrapWithChrome(chrome: ChromeData, content: string, activePath: string): string {
  return renderTopbar(chrome, activePath) + content + renderFooter(chrome);
}