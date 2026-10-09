/* ============================================================
 * 公开站 SSR：站点框架（顶栏 / 页脚）
 * ------------------------------------------------------------
 * 框架也服务端渲染出来，避免「先只有正文、app.js 加载后突然长出
 * 导航栏和页脚」的布局跳动。
 *
 * 结构与文案必须与 app/public/app.js 的 renderNav() / renderFooter()
 * 逐项对齐：同样的导航数据源（site_settings.nav_menu）、
 * 同样的「发现」二级下拉拆分、同样的自定义分类子菜单、
 * 同样的页脚附加区块。app.js 接管后原地替换，肉眼无跳动。
 *
 * 对应上游：app.js → NAV / SECONDARY_NAV / renderNav() / renderFooter()
 * ============================================================ */
import { escapeHtml } from '../seo/meta.js';
import type { AppDatabase } from '../types.js';

export interface NavChild {
  text: string;
  url: string;
}

export interface NavItem {
  text: string;
  url: string;
  /** 路由匹配用的路径键（app.js 的 item.path） */
  path: string;
  /** 子项：自定义分类 / 后台自定义的下拉 */
  children: NavChild[];
  /** 归入「发现」下拉；显式 false 表示强制留在一级导航 */
  discover: boolean | undefined;
}

export interface ChromeData {
  siteName: string;
  nav: NavItem[];
  primaryNav: NavItem[];
  secondaryNav: NavItem[];
  footerNav: NavItem[];
  friendLinks: NavChild[];
  footer: {
    copyrightName: string;
    startYear: string;
    icp: string;
    /** 自定义文字 */
    text: string;
    /** 站点声明 */
    decl: string;
    contactEmail: string;
    links: NavChild[];
  };
}

/**
 * 渲染入口的**输入**形态（区别于 readChrome() 的产出形态 ChromeData）。
 *
 * hydrateChrome() 从一开始就是为「精简结构」设计的兜底：调用方（测试、
 * 静态导出、第三方复用）可以只给 { siteName, nav, footer }，缺字段一律补
 * 默认值，绝不在渲染期抛错。类型上必须如实反映这一点 —— 早期签名写死
 * `ChromeData`，于是这类受支持的精简调用只能靠 `as unknown as` 强转才能过
 * 类型检查，把「合法用法」渲染成了「看起来非法的用法」。
 *
 * 放宽**只针对渲染入口**；readChrome() 仍返回完整 ChromeData，
 * 而 ChromeData 可无损赋给 ChromeInput，生产调用点不受影响。
 */
export type ChromeInput = Partial<Omit<ChromeData, 'nav' | 'footer'>> & {
  siteName?: string;
  /** 精简项：只给 text / url，path 与 children 由 hydrateChrome 补齐 */
  nav?: Array<Partial<NavItem> & { text: string; url: string }>;
  footer?: Partial<ChromeData['footer']>;
};

/* ---------- 常量：与 app.js 的 NAV / SECONDARY_NAV 一一对应 ---------- */

interface NavDef {
  url: string;
  path: string;
  text: string;
}

const NAV_DEFS: NavDef[] = [
  { url: '/', path: '/', text: '首页' },
  { url: '/tags', path: '/tags', text: '标签' },
  { url: '/categories', path: '/categories', text: '分类' },
  { url: '/history', path: '/history', text: '历史' },
  { url: '/series', path: '/series', text: '系列' },
  { url: '/popular', path: '/popular', text: '热门' },
  { url: '/archive', path: '/archive', text: '归档' },
  { url: '/guestbook', path: '/guestbook', text: '留言板' },
  { url: '/about', path: '/about', text: '关于' }
];

/** 「发现」下拉的固定内容（app.js SECONDARY_NAV）。 */
const SECONDARY_PATHS = new Set(['/tags', '/history', '/series', '/popular']);
/** 功能开关 navExtras=false 时隐藏的入口（app.js NAV_EXTRA_PATHS）。 */
const EXTRA_PATHS = new Set(['/history', '/series', '/popular']);
/** 后台导航默认项版本：老数据首次渲染时补齐新增默认项。 */
const NAV_DEFAULT_VERSION = 1;

/** app.js isDefaultZhText：这些中文文案视为「默认值」，应按内置项翻译。 */
const DEFAULT_ZH: Record<string, string> = {};
const DEFAULT_ZH_ALIAS: Record<string, string[]> = { '/guestbook': ['留言'] };
for (const def of NAV_DEFS) DEFAULT_ZH[def.path] = def.text;

/** 归一化路径键：去锚点、去尾斜杠（app.js navUrlKey）。 */
export function navUrlKey(item: { url?: string }): string {
  const u = String(item.url ?? '/').replace(/^#/, '');
  if (!u.startsWith('/')) return u;
  return u.replace(/\/+$/, '') || '/';
}

function isDefaultZhText(norm: string, text: string): boolean {
  if (!text) return true;
  if (DEFAULT_ZH[norm] === text) return true;
  const alias = DEFAULT_ZH_ALIAS[norm];
  return alias ? alias.includes(text) : false;
}

/* ---------- 读取与归一化 ---------- */

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

function toChild(raw: unknown, parentPath: string): NavChild | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const norm = navUrlKey({ url: str(item.url) || '/' });
  const text = str(item.text) || DEFAULT_ZH[norm] || '';
  if (!text) return null;
  // 分类导航的子项 = 自定义分类：链接自动指向「按该分类筛选」的文章列表
  const url = parentPath === '/categories' ? `/?category=${encodeURIComponent(text)}` : str(item.url) || '/';
  return { text, url };
}

function normalizeNav(raw: unknown): NavItem[] {
  const source = Array.isArray(raw) && raw.length ? raw : NAV_DEFS;
  const items: NavItem[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const url = str(item.url) || '/';
    const norm = navUrlKey({ url });
    const text = str(item.text) || DEFAULT_ZH[norm] || '';
    if (!text) continue;
    const discover =
      item.discover === true ? true : item.discover === false ? false : undefined;
    items.push({
      text,
      url,
      path: str(item.path) || norm,
      children: Array.isArray(item.children)
        ? item.children
            .map((child) => toChild(child, norm))
            .filter((child): child is NavChild => child !== null)
        : [],
      discover
    });
  }
  return items.length ? items : NAV_DEFS.map((d) => ({ ...d, children: [], discover: undefined }));
}

/** 旧导航补齐新默认项（app.js mergeNavDefaults），按默认顺序插入且不重复。 */
function mergeNavDefaults(items: NavItem[]): NavItem[] {
  if (!items.length) return normalizeNav(null);
  const out = items.slice();
  const order = new Map<string, number>();
  NAV_DEFS.forEach((def, i) => order.set(navUrlKey(def), i));
  for (const def of NAV_DEFS) {
    const key = navUrlKey(def);
    if (out.some((it) => navUrlKey(it) === key)) continue;
    const myOrder = order.get(key) ?? Number.POSITIVE_INFINITY;
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
      const cur = order.get(navUrlKey(out[i]!)) ?? Number.POSITIVE_INFINITY;
      if (cur > myOrder) {
        insertAt = i;
        break;
      }
    }
    out.splice(insertAt, 0, { ...def, children: [], discover: undefined });
  }
  return out;
}

/** 是否归入「发现」二级下拉（app.js isDiscoverItem）。 */
function isDiscoverItem(item: NavItem): boolean {
  if (item.discover === false) return false;
  return SECONDARY_PATHS.has(navUrlKey(item)) || item.discover === true;
}

/** 站点框架的配置来源与 app.js getConfig() 相同：site_settings 的一组键。 */
export async function readChrome(
  db: AppDatabase,
  siteName: string,
  prefetchedRows?: Array<{ k: string; v: string }> | null
): Promise<ChromeData> {
  let map = new Map<string, string>();
  if (prefetchedRows) {
    map = new Map(prefetchedRows.map((row) => [row.k, row.v]));
  } else {
    try {
      const rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
      map = new Map(rows.map((row) => [row.k, row.v]));
    } catch {
      /* 读取失败时用默认值 */
    }
  }

  const footer = safeJson<Record<string, unknown>>(map.get('footer'), {});
  const site = safeJson<Record<string, unknown>>(map.get('site_info') ?? map.get('site'), {});
  const profile = safeJson<Record<string, unknown>>(map.get('profile'), {});
  const features = safeJson<Record<string, unknown>>(map.get('features'), {});

  // 后台保存的键是 nav_menu；早期数据里可能残留 nav，两个都读。
  let nav = normalizeNav(safeJson<unknown>(map.get('nav_menu') ?? map.get('nav'), null));
  if (Number(map.get('nav_defaults_version') ?? 0) < NAV_DEFAULT_VERSION) nav = mergeNavDefaults(nav);
  if (features.navExtras === false) nav = nav.filter((it) => !EXTRA_PATHS.has(navUrlKey(it)));

  const primaryNav = nav.filter((it) => !isDiscoverItem(it));
  const secondaryNav = nav.filter((it) => isDiscoverItem(it));

  const toLink = (raw: unknown): NavChild | null => {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const text = str(item.text);
    if (!text) return null;
    return { text, url: str(item.url) || '/' };
  };
  const listOf = (raw: unknown): NavChild[] => {
    const parsed = safeJson<unknown>(raw, []);
    return Array.isArray(parsed)
      ? parsed.map(toLink).filter((x): x is NavChild => x !== null)
      : [];
  };

  const friendLinks = listOf(map.get('friend_links'));
  const footerNav = listOf(map.get('footer_nav')).map((link) => ({
    ...link,
    path: link.url,
    children: [],
    discover: undefined
  }));

  return {
    siteName: str(site.name) || siteName,
    nav,
    primaryNav,
    secondaryNav,
    footerNav,
    friendLinks: friendLinks.length ? friendLinks : listOf(footer.links),
    footer: {
      copyrightName: str(site.copyright) || str(footer.copyrightName) || siteName,
      startYear: str(footer.startYear),
      icp: str(footer.icp),
      text: str(footer.text),
      decl: str(site.footerText) || str(footer.decl),
      contactEmail: str(profile.email) || str(footer.email),
      links: listOf(footer.links)
    }
  };
}

/* ---------- 渲染 ---------- */

const CHEVRON =
  '<span class="nav-caret" aria-hidden="true">' +
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"' +
  ' stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg></span>';

const TOP_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"' +
  ' stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V6"/><path d="M6 11.5 12 5.5l6 6"/></svg>';

function extOf(url: string): string {
  return /^https?:|^\/\//.test(url) ? ' target="_blank" rel="noopener"' : '';
}

/** 命中判定：与 app.js 一样用 path 键与当前路由比较。 */
function pathKeyOf(item: NavItem): string {
  if (item.path) return item.path;
  const raw = item.url || '/';
  if (raw.startsWith('#/')) return raw.slice(1);
  return raw.startsWith('/') ? raw : '';
}

/**
 * 渲染入口兜底：允许调用方直接传 { siteName, nav, footer } 这样的精简结构
 * （测试、静态导出、第三方复用），缺字段一律补默认值，绝不在渲染期抛错。
 */
export function hydrateChrome(input: ChromeInput): ChromeData {
  const nav: NavItem[] = (Array.isArray(input.nav) ? input.nav : []).map((item) => ({
    ...item,
    path: item.path || navUrlKey(item),
    children: Array.isArray(item.children) ? item.children : [],
    discover: item.discover
  }));
  const footer = input.footer ?? ({} as ChromeData['footer']);
  return {
    siteName: input.siteName || '',
    nav,
    primaryNav: input.primaryNav?.length ? input.primaryNav : nav.filter((it) => !isDiscoverItem(it)),
    secondaryNav: input.secondaryNav?.length ? input.secondaryNav : nav.filter(isDiscoverItem),
    footerNav: Array.isArray(input.footerNav) ? input.footerNav : [],
    friendLinks: Array.isArray(input.friendLinks) ? input.friendLinks : [],
    footer: {
      copyrightName: footer.copyrightName || '',
      startYear: footer.startYear || '',
      icp: footer.icp || '',
      text: footer.text || '',
      decl: footer.decl || '',
      contactEmail: footer.contactEmail || '',
      links: Array.isArray(footer.links) ? footer.links : []
    }
  };
}
export interface ActiveState {
  /** 当前路由路径，例如 /tags */
  path: string;
  /** 首页 ?category=xxx 选中的分类 */
  category: string;
}

/** active 归一化：容忍直接传字符串路径（旧签名 / 静态导出脚本）。 */
export function activeOf(active: ActiveState | string | undefined): ActiveState {
  if (typeof active === 'string') return { path: navUrlKey({ url: active }), category: '' };
  return { path: active?.path ?? '', category: active?.category ?? '' };
}

function subMenu(items: NavItem[], activeInput: ActiveState | string, idPrefix: string): string {
  const active = activeOf(activeInput);
  return items
    .map((item) => {
      const key = pathKeyOf(item);
      const cls = key && key === active.path ? 'nav-link active' : 'nav-link';
      if (item.children.length) {
        const kids = item.children
          .map((child) => {
            const on = child.text === active.category;
            const cCls = on ? 'nav-link active' : 'nav-link';
            return `<a href="${escapeHtml(child.url)}" class="${cCls}" role="menuitem">${escapeHtml(child.text)}</a>`;
          })
          .join('');
        return (
          '<div class="nav-item has-sub click-dropdown" data-nav-dropdown>' +
          `<a href="${escapeHtml(item.url)}" class="${cls}"${extOf(item.url)}` +
          ' data-nav-dropdown-trigger="true" aria-haspopup="true" aria-expanded="false">' +
          `${escapeHtml(item.text)}</a>` +
          '<div class="sub-menu sub-sub-menu" role="menu">' +
          kids +
          '</div></div>'
        );
      }
      return `<a href="${escapeHtml(item.url)}" class="${cls}" role="menuitem"${extOf(item.url)}>${escapeHtml(item.text)}</a>`;
    })
    .join('');
}

export function renderTopbar(input: ChromeInput, activeInput: ActiveState | string): string {
  const chrome = hydrateChrome(input);
  const active = activeOf(activeInput);
  const secondaryActive = chrome.secondaryNav.some((it) => {
    const key = pathKeyOf(it);
    return !!key && key === active.path;
  });

  const secondaryLinks = subMenu(chrome.secondaryNav, active, 'navExploreMenu');

  const links: string[] = chrome.primaryNav.map((item) => {
    const key = pathKeyOf(item);
    const url = item.url || '/';
    const cls = key && key === active.path ? 'nav-link active' : 'nav-link';
    if (item.children.length) {
      const kids = item.children
        .map(
          (child) =>
            `<a href="${escapeHtml(child.url)}" class="nav-link"${extOf(child.url)} role="menuitem">${escapeHtml(child.text)}</a>`
        )
        .join('');
      // 主链接保留跳转能力（点标题直达），右侧箭头单独负责展开下拉
      return (
        '<div class="nav-item has-sub click-dropdown" data-nav-dropdown>' +
        `<a href="${escapeHtml(url)}" class="${cls}"${extOf(url)}` +
        ' data-nav-dropdown-trigger="true" aria-haspopup="true" aria-expanded="false">' +
        `${escapeHtml(item.text)}</a>` +
        '<button type="button" class="nav-sub-caret" data-nav-dropdown-trigger="true"' +
        ` aria-label="${escapeHtml(item.text)}" aria-haspopup="true" aria-expanded="false">${CHEVRON}</button>` +
        `<div class="sub-menu" role="menu">${kids}</div></div>`
      );
    }
    return (
      `<div class="nav-item"><a href="${escapeHtml(url)}" class="${cls}"${extOf(url)}>` +
      `${escapeHtml(item.text)}</a></div>`
    );
  });

  // 「发现」入口：button 负责展开/收起，本身不跳转；位置固定在「首页」之后
  if (chrome.secondaryNav.length) {
    const dropdown =
      '<div class="nav-item has-sub click-dropdown" data-nav-dropdown>' +
      `<button type="button" class="nav-link nav-dropdown-trigger${secondaryActive ? ' active' : ''}"` +
      ' data-nav-dropdown-trigger="true" aria-haspopup="true" aria-expanded="false" aria-controls="navExploreMenu">' +
      `发现${CHEVRON}</button>` +
      `<div class="sub-menu" id="navExploreMenu" role="menu">${secondaryLinks}</div></div>`;
    let insertAt = 0;
    for (let i = 0; i < chrome.primaryNav.length; i++) {
      if (pathKeyOf(chrome.primaryNav[i]!) === '/') {
        insertAt = i + 1;
        break;
      }
    }
    links.splice(insertAt, 0, dropdown);
  }

  /*
   * 顶栏动作区必须**连图标一起**随 SSR 输出。
   * 此前这里只放 4 个空壳 .icon-btn，等 app.js 空闲接管后才补图标与弹层，
   * 于是首屏右上角会长时间显示几个空方块（app.js 实际是 5 个动作）。
   * 现在静态标记与 renderNav() 一一对应；app.js 接管后原地替换并绑定事件。
   * 主题按钮同时带日/月两枚 SVG，由 style.css 按 html[data-theme] 选择，
   * 所以深浅色首屏也不会先显示反向图标。
   */
  const svgAttrs =
    'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
  const searchSvg =
    '<svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<circle cx="11" cy="11" r="7"></circle><circle class="search-dot" cx="15.2" cy="15.2" r="1.6"></circle></svg>';
  const globeSvg = `<svg ${svgAttrs}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15.5 15.5 0 0 1 0 18M12 3a15.5 15.5 0 0 0 0 18"/></svg>`;
  const paletteSvg =
    `<svg ${svgAttrs}><path d="M12 3a9 9 0 1 0 5.4 16.2A2.4 2.4 0 0 0 15.6 17h-.9a2.6 2.6 0 0 1-2.6-2.6c0-1.4 1.1-2.6 2.6-2.6h1.4A3.9 3.9 0 0 0 20.2 8 9 9 0 0 0 12 3z"/>` +
    '<circle cx="7.4" cy="11.3" r="1"/><circle cx="10.6" cy="7.2" r="1"/><circle cx="15.4" cy="8.6" r="1"/></svg>';
  const sparkSvg =
    `<svg ${svgAttrs}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>` +
    '<path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>';
  const moonSvg =
    `<svg class="ssr-theme-icon ssr-theme-moon" ${svgAttrs}><path d="M20.5 13.2A8.5 8.5 0 1 1 11 3.5a6.6 6.6 0 0 0 9.5 9.7z"/></svg>`;
  const sunSvg =
    `<svg class="ssr-theme-icon ssr-theme-sun" ${svgAttrs}><circle cx="12" cy="12" r="4"/>` +
    '<path d="M12 2.4v2.4M12 19.2v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.4 12h2.4M19.2 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></svg>';

  const topbarActions =
    `<button class="icon-btn search-toggle" id="searchToggle" aria-label="搜索文章" title="搜索文章">${searchSvg}</button>` +
    '<div class="lang-wrap" id="langWrap" role="group" aria-label="语言">' +
    `<button class="icon-btn" id="langToggle" aria-label="语言" title="语言" aria-haspopup="listbox"` +
    ` aria-controls="langPop" aria-expanded="false">${globeSvg}</button>` +
    '<div class="lang-pop" id="langPop" role="listbox" aria-label="语言">' +
    '<div class="accent-pop-title">语言</div><div class="lang-pop-options" id="langPopInner"></div>' +
    '</div></div>' +
    '<div class="accent-wrap" id="accentWrap" role="group" aria-label="主题色">' +
    `<button class="icon-btn" id="accentToggle" aria-label="主题色" title="主题色" aria-haspopup="true"` +
    ` aria-expanded="false" aria-controls="accentPop">${paletteSvg}</button>` +
    '<div class="accent-pop" id="accentPop" role="group" aria-label="主题色">' +
    '<div class="accent-pop-title">主题色</div><div class="accent-pop-swatches"></div>' +
    '</div></div>' +
    `<button class="icon-btn" id="bgAnimToggle" aria-pressed="false" aria-label="背景动画"` +
    ` title="背景动画已关闭（点击开启）">${sparkSvg}</button>` +
    `<button class="icon-btn" id="themeToggle" aria-label="切换深色/浅色模式"` +
    ` title="切换深色/浅色模式">${moonSvg}${sunSvg}</button>`;

  return (
    '<header class="topbar"><div class="container topbar-inner">' +
    '<div class="topbar-left">' +
    '<button class="hamburger-btn" id="hamburgerBtn" aria-label="打开菜单"><span></span><span></span><span></span></button>' +
    `<a class="brand" href="/">${escapeHtml(chrome.siteName)}</a>` +
    '</div>' +
    `<nav class="main-nav">${links.join('')}</nav>` +
    `<div class="topbar-actions">${topbarActions}</div>` +
    '</div><div class="search-panel" id="searchPanel"></div></header>'
  );
}

function footerLink(item: NavChild): string {
  return `<a href="${escapeHtml(item.url)}"${extOf(item.url)}>${escapeHtml(item.text)}</a>`;
}

export function renderFooter(input: ChromeInput): string {
  const chrome = hydrateChrome(input);
  // 页脚导航：优先后台「底部导航」，其次 footer.contact，最后回退主导航
  const source: NavChild[] = chrome.footerNav.length
    ? chrome.footerNav
    : chrome.footer.links.length
      ? chrome.footer.links
      : chrome.nav.map((it) => ({ text: it.text, url: it.url }));
  const list = source.slice();
  if (!list.some((x) => String(x.url) === '/links')) list.push({ text: '友链', url: '/links' });

  let navHtml = list.map(footerLink).join('<span class="footer-dot">·</span>');
  navHtml +=
    '<span class="footer-dot footer-rss">·</span><a class="footer-rss" href="/feed.xml">RSS</a>' +
    `<span class="footer-dot">·</span><a href="/subscribe">邮件订阅</a>`;

  let extra = '';
  if (chrome.footer.text) extra += `<p class="footer-text">${escapeHtml(chrome.footer.text)}</p>`;
  if (chrome.footer.decl) {
    extra += `<p class="footer-decl"><span class="footer-lbl">站点声明：</span>${escapeHtml(chrome.footer.decl)}</p>`;
  }
  if (chrome.footer.contactEmail) {
    extra +=
      '<p class="footer-contact"><span class="footer-lbl">相关侵权、举报、投诉及建议等，请发邮件至 E-mail：</span>' +
      `<a href="mailto:${escapeHtml(chrome.footer.contactEmail)}">${escapeHtml(chrome.footer.contactEmail)}</a></p>`;
  }
  const friends = chrome.friendLinks.map(footerLink).join('');
  if (friends) {
    extra += `<p class="footer-friends"><span class="footer-lbl">友情链接：</span><span class="footer-friend-links">${friends}</span></p>`;
  }

  const year = new Date().getFullYear();
  const start = Number(chrome.footer.startYear) || 2019;
  const range = start && start < year ? `${start}-${year}` : String(year);
  const icp = chrome.footer.icp ? ` <span class="footer-icp">${escapeHtml(chrome.footer.icp)}</span>` : '';

  return (
    '<footer><div class="container footer-inner">' +
    `<div class="footer-nav">${navHtml}</div>` +
    (extra ? `<div class="footer-extra">${extra}</div>` : '') +
    `<div class="footer-copy">Copyright ©${range} ${escapeHtml(chrome.footer.copyrightName)}${icp}</div>` +
    '</div>' +
    `<button class="btn-top" id="backTop" aria-label="返回顶部" title="返回顶部">${TOP_ICON}</button>` +
    '</footer>'
  );
}

/** 按 app.js 的顺序组装整页：顶栏 + 正文 + 页脚。 */
export function wrapWithChrome(chrome: ChromeInput, content: string, active: ActiveState | string): string {
  return renderTopbar(chrome, active) + content + renderFooter(chrome);
}
