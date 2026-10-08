/* ============================================================
 * 公开站 SSR：站点框架（顶栏 / 页脚）
 * ------------------------------------------------------------
 * 之前只渲染了 <main>（正文区），顶栏与页脚仍由 app.js 在加载后补上，
 * 于是页面会先显示"只有正文"，随后突然长出导航栏和页脚 —— 明显的布局跳动。
 *
 * 这里把框架也服务端渲染出来，标记与逻辑逐项对齐 app.js 的 renderNav() /
 * renderFooter() —— 上游 2.10.92 起顶栏改为「首页 + 发现 ▾ + 其余一级项」，
 * 且「分类」独立为一级导航、子项即自定义分类。SSR 必须复刻同一套解析规则，
 * 否则服务端渲染的导航与 app.js 接管后的导航会明显不同（先抖一下再变）。
 *
 *   header.topbar > .container.topbar-inner > .topbar-left + nav.main-nav + .topbar-actions
 *   footer > .container.footer-inner > .footer-nav + .footer-copy
 *
 * 图标按钮（语言/主题/搜索/配色）只渲染 <button class="icon-btn"> 空壳：
 * CSS 给了 .icon-btn 固定 34×34 尺寸，因此空间能占住，
 * 图标与交互仍由 app.js 接管后填充。
 *
 * 说明：移动端抽屉侧栏（.mobile-sidebar）仍未做 SSR —— 它默认在画布外，
 * 不影响首屏布局，由 app.js 接管后生成。
 * ============================================================ */
import { PUBLIC_DIR } from '../config.js';
import { escapeHtml } from '../seo/meta.js';
import { readBlogConfig, type BlogFooterConfig, type BlogFooterLink } from './blog-config.js';
import type { AppDatabase } from '../types.js';

export interface NavItem {
  text: string;
  url: string;
  path?: string | null;
  i18n?: string;
  /** 三态：true 强制放进「发现」下拉；false 强制留在一级导航；缺省按内置路径识别 */
  discover?: boolean;
  children?: NavItem[];
}

export interface ChromeData {
  siteName: string;
  nav: NavItem[];
  navDefaultsVersion: number;
  navExtras: boolean;
  footerNav: NavItem[];
  /** 首页每页文章数（features.pageSize 优先，其次 config.js pageSize；0 = 不分页）。 */
  pageSize: number;
  /** 首页标签行白名单（site_settings.home_tags 优先，空 = 全部显示）。 */
  homeTags: string[];
  footer: {
    copyrightName: string;
    startYear: string;
    icp: string;
    /** 自定义页脚文字（app.js 读 config.js footer.text） */
    text: string;
    /** 站点声明（site_info.footerText 优先，其次 config.js footer.decl） */
    decl: string;
    /** 联系邮箱（profile.email 优先，其次 config.js footer.email） */
    email: string;
    /** 友情链接（friend_links 优先，其次 config.js footer.links） */
    friends: BlogFooterLink[];
  };
}

/**
 * app.js 内置 NAV 常量的等价物（顺序与文案逐项对齐）。
 * 站点未在后台配置导航时，前后台必须用同一份默认值，
 * 否则 SSR 渲染 6 项、app.js 接管后变成 9 项，导航栏会明显跳一下。
 */
const DEFAULT_NAV: NavItem[] = [
  { text: '', i18n: 'nav.home', url: '/', path: '/' },
  { text: '', i18n: 'nav.tags', url: '/tags', path: '/tags' },
  { text: '', i18n: 'nav.categories', url: '/categories', path: '/categories' },
  { text: '', i18n: 'nav.history', url: '/history', path: '/history' },
  { text: '', i18n: 'nav.series', url: '/series', path: '/series' },
  { text: '', i18n: 'nav.popular', url: '/popular', path: '/popular' },
  { text: '', i18n: 'nav.archive', url: '/archive', path: '/archive' },
  { text: '', i18n: 'nav.guestbook', url: '/guestbook', path: '/guestbook' },
  { text: '', i18n: 'nav.about', url: '/about', path: '/about' }
];

/** 「发现」下拉的固定内容：标签 / 历史 / 系列 / 热门（分类已独立为一级导航）。 */
const SECONDARY_NAV: NavItem[] = [
  { text: '', i18n: 'nav.tags', url: '/tags', path: '/tags' },
  { text: '', i18n: 'nav.history', url: '/history', path: '/history' },
  { text: '', i18n: 'nav.series', url: '/series', path: '/series' },
  { text: '', i18n: 'nav.popular', url: '/popular', path: '/popular' }
];

/** 导航默认项版本，与 app.js 的 NAV_DEFAULT_VERSION 保持一致。 */
const NAV_DEFAULT_VERSION = 1;

/** 受「显示新增导航项」开关控制的内置项（与 app.js 的 NAV_EXTRA_PATHS 一致）。 */
const NAV_EXTRA_PATHS = new Set(['/history', '/series', '/popular']);

/** SSR 只输出默认语言（中文）文案，内嵌一份导航相关的中文表，等价于 app.js 的 t()。 */
const NAV_ZH: Record<string, string> = {
  'nav.home': '首页',
  'nav.tags': '标签',
  'nav.categories': '分类',
  'nav.history': '历史',
  'nav.series': '系列',
  'nav.popular': '热门',
  'nav.archive': '归档',
  'nav.guestbook': '留言板',
  'nav.about': '关于',
  'nav.links': '友链',
  'nav.subscribe': '邮件订阅',
  'nav.explore': '发现',
  'nav.toggle': '展开导航',
  /* 页脚区块文案（与 locales/zh-CN.json 的 footer.* 逐字一致） */
  'footer.declPrefix': '站点声明：',
  'footer.contactPrefix': '相关侵权、举报、投诉及建议等，请发邮件至 E-mail：',
  'footer.friends': '友情链接：',
  'footer.backTop': '返回顶部'
};

/** 与 app.js 同款的描边 chevron（size=15）。 */
const CHEVRON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>';

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

/** app.js navUrlKey() 的等价实现：归一化路径，用于识别内置项。 */
function navUrlKey(it: NavItem | undefined | null): string {
  const u = String((it && it.url) || '/').replace(/^#/, '');
  if (u.charAt(0) !== '/') return u;
  return u.replace(/\/+$/, '') || '/';
}

const SECONDARY_KEYS = new Set(SECONDARY_NAV.map((it) => navUrlKey(it)));

function normalizeNav(raw: unknown): NavItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      text: str(item.text),
      url: str(item.url) || '/',
      ...(str(item.path) ? { path: str(item.path) } : {}),
      ...(str(item.i18n) ? { i18n: str(item.i18n) } : {}),
      ...(item.discover === true || item.discover === false ? { discover: item.discover } : {}),
      ...(Array.isArray(item.children)
        ? {
            children: item.children
              .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
              .map((c) => ({ text: str(c.text), url: str(c.url) || '/' }))
          }
        : {})
    }))
    .filter((item) => Boolean(item.url));
}

/** 解析成最终展示文案：优先后台自定义文字，其次按 i18n key 取中文。 */
function resolveText(it: NavItem): string {
  return it.text || (it.i18n ? NAV_ZH[it.i18n] : '') || '';
}

/** app.js mergeNavDefaults()：给旧导航补齐后来新增的默认项（按 NAV 顺序插入）。 */
function mergeNavDefaults(items: NavItem[]): NavItem[] {
  if (!Array.isArray(items) || !items.length) return DEFAULT_NAV.slice();
  const out = items.slice();
  const order: Record<string, number> = {};
  DEFAULT_NAV.forEach((it, i) => {
    order[navUrlKey(it)] = i;
  });
  DEFAULT_NAV.forEach((def) => {
    const key = navUrlKey(def);
    if (out.some((it) => navUrlKey(it) === key)) return;
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
      const curKey = navUrlKey(out[i]);
      const curOrder = Object.prototype.hasOwnProperty.call(order, curKey) ? order[curKey] : Infinity;
      if (curOrder > order[key]) {
        insertAt = i;
        break;
      }
    }
    out.splice(insertAt, 0, def);
  });
  return out;
}

function hideExtraNav(items: NavItem[]): NavItem[] {
  return items.filter((it) => !NAV_EXTRA_PATHS.has(navUrlKey(it)));
}

/** app.js navItems()：后台配置优先；旧数据补齐默认项；开关关闭时隐藏新增项。 */
function navItems(chrome: ChromeData): NavItem[] {
  let items: NavItem[];
  if (Array.isArray(chrome.nav) && chrome.nav.length) {
    const version = Number(chrome.navDefaultsVersion || 0);
    items = version < NAV_DEFAULT_VERSION ? mergeNavDefaults(chrome.nav) : chrome.nav;
  } else {
    items = DEFAULT_NAV.slice();
  }
  if (chrome.navExtras === false) items = hideExtraNav(items);
  return items;
}

/** app.js isDiscoverItem()：内置四项 + 后台手动标记，discover:false 强制移出。 */
function isDiscoverItem(it: NavItem): boolean {
  if (!it) return false;
  if (it.discover === false) return false;
  return SECONDARY_KEYS.has(navUrlKey(it)) || it.discover === true;
}

function primaryNavItems(chrome: ChromeData): NavItem[] {
  return navItems(chrome).filter((it) => !isDiscoverItem(it));
}

function secondaryNavItems(chrome: ChromeData): NavItem[] {
  const out: NavItem[] = [];
  navItems(chrome).forEach((it) => {
    if (!isDiscoverItem(it)) return;
    const key = navUrlKey(it);
    const def = SECONDARY_NAV.find((d) => navUrlKey(d) === key);
    if (!def) {
      out.push({ text: it.text, url: it.url, path: it.path, i18n: it.i18n, children: it.children });
      return;
    }
    const item: NavItem = { ...def };
    if (it.path) item.path = it.path;
    if (it.i18n) {
      item.i18n = it.i18n;
      item.text = '';
    } else if (it.text) {
      delete item.i18n;
      item.text = it.text;
    }
    if (it.children && it.children.length) item.children = it.children;
    out.push(item);
  });
  return out;
}

/**
 * app.js resolveNav()：套用翻译，并把「分类」入口的子项改写成
 * 「按分类筛选」的链接（/?category=名称）—— 后台只填分类名，不用写链接。
 */
function resolveNav(items: NavItem[]): NavItem[] {
  return items.map((it) => {
    const isCatParent = navUrlKey(it) === '/categories';
    const n: NavItem = { text: resolveText(it), url: it.url, path: it.path, i18n: it.i18n };
    if (it.children && it.children.length) {
      n.children = it.children.map((c) => {
        const cText = resolveText({ text: c.text, url: c.url });
        return {
          text: cText,
          url: isCatParent ? '/?category=' + encodeURIComponent(String(cText).trim()) : c.url
        };
      });
    }
    return n;
  });
}

/** app.js href()：SSR 直接用根路径；外链原样输出并补 target。 */
function extOf(url: string): string {
  return url && /^https?:|^\/\//.test(url) ? ' target="_blank" rel="noopener"' : '';
}

function activeClass(url: string, activePath: string, activeCategory: string): string {
  const key = navUrlKey({ text: '', url });
  const on = url === activePath || (url !== '/' && activePath.startsWith(url));
  const onCategory = activeCategory && url === '/?category=' + encodeURIComponent(activeCategory);
  return on || onCategory ? 'nav-link active' : 'nav-link';
}

/* ---------- 配置读取 ---------- */

/** 把任意形状的链接数组规整成 `{ text, url }` 列表（config.js 的 contact / links 与 site_settings 同形）。 */
function toLinks(raw: unknown): BlogFooterLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === 'object')
    .map((it) => ({ text: str(it.text), url: str(it.url) }))
    .filter((it) => Boolean(it.url));
}

/**
 * 站点框架的配置来源与 app.js 完全一致：
 *   - site_settings：`nav_menu` / `footer_nav` / `friend_links` / `site_info` / `profile` / `features`
 *   - 静态 config.min.js：`footer`（导航行 contact / 声明 decl / 文字 text / 邮箱 email /
 *     起始年 startYear / 备案号 icp / 版权署名 copyrightName）
 *
 * 注意 `footer` **不是** site_settings 的键：app.js 的 `cfg.footer` 取自
 * `window.BLOG_CONFIG`，后台保存的 site_settings 只覆盖其中的两项
 * （`site_info.copyright` → copyrightName、`site_info.footerText` → decl）。
 * 同理 `nav` 已被上游迁移 0012 明确清除，这里不再兼容读取。
 */
export async function readChrome(
  db: AppDatabase,
  siteName: string,
  publicDir: string = PUBLIC_DIR
): Promise<ChromeData> {
  let map = new Map<string, string>();
  try {
    const rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
    map = new Map(rows.map((row) => [row.k, row.v]));
  } catch {
    /* 读取失败时用默认值 */
  }

  const blog = await readBlogConfig(publicDir);
  const cfgFooter: BlogFooterConfig =
    blog.footer && typeof blog.footer === 'object' ? blog.footer : {};

  // 站点信息在 `site_info` 下（与 app.js:1026 一致），不是 `site`。
  const site = safeJson<Record<string, unknown>>(map.get('site_info'), {});
  const profile = safeJson<Record<string, unknown>>(map.get('profile'), {});
  const features = safeJson<Record<string, unknown>>(map.get('features'), {});
  const navDefaultsVersion = Number(map.get('nav_defaults_version') || 0);

  /* ---- 页脚：复刻 app.js getConfig() 的合成顺序 ----
   *   var footer = cfg.footer || {};
   *   if (siteInfo.copyright)  footer.copyrightName = siteInfo.copyright;
   *   if (siteInfo.footerText) footer.decl        = siteInfo.footerText;
   *   if (siteInfo.startYear)  footer.startYear   = siteInfo.startYear;   // 自托管版增强
   *   if (siteInfo.icp)        footer.icp         = siteInfo.icp;         // 自托管版增强 */
  const footer: BlogFooterConfig = { ...cfgFooter };
  if (str(site.copyright)) footer.copyrightName = str(site.copyright);
  if (str(site.footerText)) footer.decl = str(site.footerText);
  /* 建站年份与备案号：上游只从静态 config.js 读，后台虽然给了输入框却永远不生效。
   * 这里与 app.js 的自有补丁保持同构，让 site_info 能覆盖它们。
   * 注意不要去读 site_settings 的 `footer` 键——那不是合法的 site_settings 键。 */
  if (str(site.startYear)) footer.startYear = str(site.startYear);
  if (str(site.icp)) footer.icp = str(site.icp);

  // 页脚导航行：footer_nav 优先，其次 config.js footer.contact（app.js:2470）
  const dbFooterNav = normalizeNav(safeJson<unknown>(map.get('footer_nav'), null));
  const footerNav = dbFooterNav.length ? dbFooterNav : normalizeNav(cfgFooter.contact ?? null);

  // 友情链接：friend_links 优先，其次 config.js footer.links（app.js:2499）
  const dbFriends = toLinks(safeJson<unknown>(map.get('friend_links'), null));
  const friends = dbFriends.length ? dbFriends : toLinks(cfgFooter.links ?? null);

  const strField = (v: unknown): string =>
    typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';

  /* ---- 首页分页与标签行白名单：与 app.js getConfig() 同一优先级 ----
   *   pageSize  = features.pageSize（>=0）优先，其次 config.js pageSize，最后 8
   *   homeTags  = site_settings.home_tags 非空则用它，否则 config.js homeTags */
  const featPageSize =
    features.pageSize != null && Number(features.pageSize) >= 0
      ? Math.floor(Number(features.pageSize))
      : null;
  const cfgPageSize = typeof blog.pageSize === 'number' && blog.pageSize >= 0 ? blog.pageSize : 8;
  const pageSize = featPageSize != null ? featPageSize : cfgPageSize;

  // home_tags 存的是字符串数组（后台保存 JSON.stringify(string[])）
  const rawHomeTags = safeJson<unknown>(map.get('home_tags'), null);
  const dbHomeTags = Array.isArray(rawHomeTags)
    ? rawHomeTags.map((x) => str(x)).filter(Boolean)
    : [];
  const cfgHomeTags = Array.isArray(blog.homeTags)
    ? blog.homeTags.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const homeTags = dbHomeTags.length ? dbHomeTags : cfgHomeTags;

  return {
    siteName: str(site.name) || siteName,
    nav: normalizeNav(safeJson<unknown>(map.get('nav_menu'), null)),
    navDefaultsVersion: Number.isFinite(navDefaultsVersion) ? navDefaultsVersion : 0,
    navExtras: features.navExtras !== false,
    footerNav,
    pageSize,
    homeTags,
    footer: {
      copyrightName: str(site.copyright) || strField(footer.copyrightName) || siteName,
      startYear: strField(footer.startYear),
      icp: strField(footer.icp),
      text: strField(footer.text),
      decl: strField(footer.decl),
      email: str(profile.email) || strField(footer.email),
      friends
    }
  };
}

/* ---------- 渲染 ---------- */

function renderPrimary(items: NavItem[], activePath: string, activeCategory: string): string {
  return items
    .map((item) => {
      const url = item.url;
      const cls = activeClass(url, activePath, activeCategory);
      const text = escapeHtml(item.text);
      if (item.children?.length) {
        const kids = item.children
          .map((c) => {
            const cCls = activeCategory && String(c.text).trim() === activeCategory ? 'nav-link active' : 'nav-link';
            return `<a href="${escapeHtml(c.url)}" class="${cCls}"${extOf(c.url)} role="menuitem">${escapeHtml(c.text)}</a>`;
          })
          .join('');
        // 主链接保留跳转能力（点标题直达该页），右侧箭头单独负责展开下拉
        return (
          `<div class="nav-item has-sub click-dropdown" data-nav-dropdown>` +
          `<a href="${escapeHtml(url)}" class="${cls}"${extOf(url)} data-nav-dropdown-trigger="true" ` +
          `aria-haspopup="true" aria-expanded="false">${text}</a>` +
          `<button type="button" class="nav-sub-caret" data-nav-dropdown-trigger="true" ` +
          `aria-label="${text}" aria-haspopup="true" aria-expanded="false">` +
          `<span class="nav-caret" aria-hidden="true">${CHEVRON}</span></button>` +
          `<div class="sub-menu" role="menu">${kids}</div></div>`
        );
      }
      return `<div class="nav-item"><a href="${escapeHtml(url)}" class="${cls}"${extOf(url)}>${text}</a></div>`;
    })
    .join('');
}

function renderSecondary(items: NavItem[], activePath: string, activeCategory: string): string {
  return items
    .map((n) => {
      const url = n.url;
      const cls = activeClass(url, activePath, activeCategory);
      const text = escapeHtml(n.text);
      if (n.children?.length) {
        const kids = n.children
          .map((c) => {
            const cTxt = String(c.text).trim();
            const cCls = cTxt && cTxt === activeCategory ? 'nav-link active' : 'nav-link';
            return `<a href="${escapeHtml(c.url)}" class="${cCls}" role="menuitem">${escapeHtml(c.text)}</a>`;
          })
          .join('');
        return (
          `<div class="sub-item-group" data-nav-dropdown><div class="sub-item-row">` +
          `<a href="${escapeHtml(url)}" class="${cls}"${extOf(url)} role="menuitem">${text}</a>` +
          `<button type="button" class="sub-caret" data-nav-dropdown-trigger="true" aria-label="${text}" ` +
          `aria-haspopup="true" aria-expanded="false"><span class="nav-caret" aria-hidden="true">${CHEVRON}</span></button>` +
          `</div><div class="sub-menu sub-sub-menu" role="menu">${kids}</div></div>`
        );
      }
      return `<a href="${escapeHtml(url)}" class="${cls}" role="menuitem"${extOf(url)}>${text}</a>`;
    })
    .join('');
}

function splitActive(active: string): { path: string; category: string } {
  const q = active.indexOf('?');
  if (q < 0) return { path: active || '/', category: '' };
  const path = active.slice(0, q) || '/';
  let category = '';
  try {
    category = String(new URLSearchParams(active.slice(q + 1)).get('category') || '').trim();
  } catch {
    category = '';
  }
  return { path, category };
}

export function renderTopbar(chrome: ChromeData, activePath: string): string {
  const { path: active, category: activeCategory } = splitActive(activePath);

  const navs = resolveNav(primaryNavItems(chrome));
  const secondaryNavs = resolveNav(secondaryNavItems(chrome));
  const secondaryActive = secondaryNavs.some((n) => navUrlKey({ text: '', url: n.url }) === active);

  const links = navs.map((n) => renderPrimary([n], active, activeCategory));

  // 「发现」入口：button 负责点击展开/收起，本身不触发页面跳转；空菜单不渲染
  if (secondaryNavs.length) {
    const dropdown =
      '<div class="nav-item has-sub click-dropdown" data-nav-dropdown>' +
      `<button type="button" class="nav-link nav-dropdown-trigger${secondaryActive ? ' active' : ''}"` +
      ' data-nav-dropdown-trigger="true" aria-haspopup="true" aria-expanded="false" aria-controls="navExploreMenu">' +
      `${escapeHtml(NAV_ZH['nav.explore'])}<span class="nav-caret" aria-hidden="true">${CHEVRON}</span></button>` +
      `<div class="sub-menu" id="navExploreMenu" role="menu">${renderSecondary(secondaryNavs, active, activeCategory)}</div></div>`;
    let insertAt = 0;
    for (let i = 0; i < navs.length; i++) {
      if (navUrlKey({ text: '', url: navs[i].url }) === '/') {
        insertAt = i + 1;
        break;
      }
    }
    links.splice(insertAt, 0, dropdown);
  }

  // 空壳按钮：.icon-btn 固定 34×34，占位正确；图标与事件由 app.js 接管后填充。
  // 顺序与 app.js 一致（搜索 / 语言 / 配色 / 背景动画 / 主题），
  // 语言与配色带各自的定位容器，保证与接管后的宽度和间距完全一致。
  const actions =
    '<button class="icon-btn search-toggle" id="searchToggle" tabindex="-1" aria-hidden="true"></button>' +
    '<div class="lang-wrap" id="langWrap"><button class="icon-btn" id="langToggle" tabindex="-1" aria-hidden="true"></button></div>' +
    '<div class="accent-wrap" id="accentWrap"><button class="icon-btn" id="accentToggle" tabindex="-1" aria-hidden="true"></button></div>' +
    '<button class="icon-btn" id="bgAnimToggle" tabindex="-1" aria-hidden="true"></button>' +
    '<button class="icon-btn" id="themeToggle" tabindex="-1" aria-hidden="true"></button>';

  return (
    '<header class="topbar"><div class="container topbar-inner">' +
    '<div class="topbar-left">' +
    `<button class="hamburger-btn" id="hamburgerBtn" aria-label="${escapeHtml(NAV_ZH['nav.toggle'])}"><span></span><span></span><span></span></button>` +
    `<a class="brand" href="/">${escapeHtml(chrome.siteName)}</a>` +
    '</div>' +
    `<nav class="main-nav">${links.join('')}</nav>` +
    `<div class="topbar-actions">${actions}</div>` +
    '</div><div class="search-panel" id="searchPanel"></div></header>'
  );
}

/** 与 app.js 的 btn-top 图标逐字节一致（svgIcon('top', 18)）。 */
const TOP_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 20V6"/><path d="M6 11.5 12 5.5l6 6"/></svg>';

/** app.js 页脚里的 `l(x)`：站内路径原样输出，外链补 target。 */
function footerLink(x: { text?: string; url?: string }): string {
  let url = x.url || '/';
  if (/^#\//.test(url)) url = url.slice(1);
  const ext = /^https?:|^\/\//.test(url) ? ' target="_blank" rel="noopener"' : '';
  return `<a href="${escapeHtml(url)}"${ext}>${escapeHtml(x.text || '')}</a>`;
}

export function renderFooter(chrome: ChromeData): string {
  // 与 app.js 一致：优先后台「底部导航」，其次静态 config.js 的 footer.contact，
  // 两者都没有时才回退站点主导航（含二级项）。
  const custom = chrome.footerNav.length ? chrome.footerNav : null;
  // 注意：app.js 对自定义页脚导航**不做 i18n 解析**（`it.text || ''`），
  // 只有回退到站点主导航时才会经 resolveNav() 套用翻译。这里保持一致。
  let nav: Array<{ text: string; url: string }> = custom
    ? custom.map((it) => ({ text: it.text || '', url: it.url }))
    : resolveNav(navItems(chrome)).map((it) => ({ text: it.text, url: it.url }));
  if (!nav.some((x) => String(x.url || '') === '/links')) {
    nav = nav.concat([{ text: NAV_ZH['nav.links'], url: '/links' }]);
  }
  const navHtml = nav.map(footerLink).join('<span class="footer-dot">·</span>');

  // RSS 与「邮件订阅」：app.js 只在非管理员时追加（管理员已有后台入口）。
  // SSR 面向的是匿名访客，因此恒渲染这两项。
  const tail =
    '<span class="footer-dot footer-rss">·</span><a class="footer-rss" href="/feed.xml">RSS</a>' +
    `<span class="footer-dot">·</span><a href="/subscribe">${escapeHtml(NAV_ZH['nav.subscribe'])}</a>`;

  // 电脑端专属区块：自定义文字 / 站点声明 / 联系方式 / 友情链接（app.js:2493-2501）
  let extra = '';
  if (chrome.footer.text) {
    extra += `<p class="footer-text">${escapeHtml(chrome.footer.text)}</p>`;
  }
  if (chrome.footer.decl) {
    extra +=
      `<p class="footer-decl"><span class="footer-lbl">${escapeHtml(NAV_ZH['footer.declPrefix'])}</span>` +
      `${escapeHtml(chrome.footer.decl)}</p>`;
  }
  if (chrome.footer.email) {
    const mail = escapeHtml(chrome.footer.email);
    extra +=
      `<p class="footer-contact"><span class="footer-lbl">${escapeHtml(NAV_ZH['footer.contactPrefix'])}</span>` +
      `<a href="mailto:${mail}">${mail}</a></p>`;
  }
  const friends = chrome.footer.friends.map(footerLink).join('');
  if (friends) {
    extra +=
      `<p class="footer-friends"><span class="footer-lbl">${escapeHtml(NAV_ZH['footer.friends'])}</span>` +
      `<span class="footer-friend-links">${friends}</span></p>`;
  }

  const year = new Date().getFullYear();
  const startYear = Number(chrome.footer.startYear) || 2019;
  const range = startYear && startYear < year ? `${startYear}-${year}` : String(year);
  const icp = chrome.footer.icp ? ` <span class="footer-icp">${escapeHtml(chrome.footer.icp)}</span>` : '';
  const backTop = escapeHtml(NAV_ZH['footer.backTop']);

  return (
    '<footer><div class="container footer-inner">' +
    `<div class="footer-nav">${navHtml}${tail}</div>` +
    (extra ? `<div class="footer-extra">${extra}</div>` : '') +
    `<div class="footer-copy">Copyright ©${escapeHtml(range)} ${escapeHtml(chrome.footer.copyrightName)}${icp}</div>` +
    '</div>' +
    // 返回顶部：固定悬浮右下角，所有页面共用（默认隐藏，滚动后由 app.js 加 .show）
    `<button class="btn-top" id="backTop" aria-label="${backTop}" title="${backTop}">${TOP_ICON}</button>` +
    '</footer>'
  );
}

/** 按 app.js 的顺序组装整页：顶栏 + 正文 + 页脚。 */
export function wrapWithChrome(chrome: ChromeData, content: string, activePath: string): string {
  return renderTopbar(chrome, activePath) + content + renderFooter(chrome);
}
