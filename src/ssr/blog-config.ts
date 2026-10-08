/* ============================================================
 * 读取前端静态配置 window.BLOG_CONFIG
 * ------------------------------------------------------------
 * 背景（铁律 4）：app.js 的 `getConfig()` 把 `cfg.footer`（页脚导航 / 声明 /
 * 联系邮箱 / 友情链接 / 起始年 / 备案号）取自 **静态 config.js**，而不是
 * site_settings——后台保存的 site_settings 只会覆盖其中的
 * `copyrightName`（取自 site_info.copyright）与 `decl`（取自 site_info.footerText）。
 *
 * SSR 若只读 site_settings，页脚就会是另一副样子：导航从「Docs · GitHub」
 * 变成站点主导航的全量列表、`.footer-extra` 整块（声明/邮箱/友链）缺失、
 * 版权行文案也对不上。这些都会在 app.js 接管瞬间整块换掉。
 *
 * 所以这里直接读浏览器读的那份 `config.min.js`，在隔离沙箱里求值，
 * 拿到与 `window.BLOG_CONFIG` 完全一致的配置对象。config.min.js 是本站自己的
 * 静态文件、不含 `document` / `location`，求值安全；任何异常都回退为空对象。
 * ============================================================ */
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

export interface BlogFooterLink {
  text?: string;
  url?: string;
  children?: BlogFooterLink[];
}

export interface BlogFooterConfig {
  text?: string;
  icp?: string;
  decl?: string;
  email?: string;
  startYear?: string | number;
  copyrightName?: string;
  /** 页脚导航行（仅本站静态配置提供） */
  contact?: BlogFooterLink[];
  /** 友情链接（site_settings.friend_links 优先于它） */
  links?: BlogFooterLink[];
}

export interface BlogAdsConfig {
  enabled?: boolean;
  content?: string;
}

export interface BlogConfig {
  siteUrl?: string;
  /** 首页每页文章数（0 = 不分页）；site_settings.features.pageSize 优先于它。 */
  pageSize?: number;
  /** 首页标签行白名单；site_settings.home_tags 非空时优先于它。 */
  homeTags?: string[];
  footer?: BlogFooterConfig;
  /** 广告位（site_settings.features.ads 会按字段覆盖它，见 getConfig()） */
  ads?: BlogAdsConfig;
}

const EMPTY: BlogConfig = {};

let cache: { file: string; mtimeMs: number; value: BlogConfig } | null = null;

/**
 * 读取 `publicDir/config.min.js` 的配置对象（带 mtime 缓存）。
 * 与前端 index.html 加载的是同一个文件，保证 SSR 与 SPA 同源。
 */
export async function readBlogConfig(publicDir: string): Promise<BlogConfig> {
  const file = path.join(publicDir, 'config.min.js');
  try {
    const stat = await fsp.stat(file);
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.value;

    const source = await fsp.readFile(file, 'utf8');
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.createContext(sandbox);
    // 超时保护：静态配置文件不应有耗时逻辑，1s 足够。
    new vm.Script(source, { filename: 'config.min.js' }).runInContext(sandbox, { timeout: 1000 });

    const raw = sandbox.window.BLOG_CONFIG;
    const value: BlogConfig =
      raw && typeof raw === 'object' ? (raw as BlogConfig) : EMPTY;
    cache = { file, mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    /* 配置缺失/语法错误时按空配置处理，页面仍能正常降级渲染 */
    return EMPTY;
  }
}

/** 供测试重置模块级缓存。 */
export function __resetBlogConfigCache(): void {
  cache = null;
  versionCache = null;
}

let versionCache: { file: string; mtimeMs: number; value: string } | null = null;

/**
 * 读取全站统一的前端版本号（铁律 1）：取自 index.html 里 `?v=` 的取值，
 * 与 app.js 的 BLOG_VERSION / sw.js 的 CACHE_VERSION 同源。
 * 关于页要显示 `v2.10.93` 这类文案，SSR 必须用同一个值。
 */
export async function readBlogVersion(publicDir: string): Promise<string> {
  const file = path.join(publicDir, 'index.html');
  try {
    const stat = await fsp.stat(file);
    if (versionCache && versionCache.file === file && versionCache.mtimeMs === stat.mtimeMs) {
      return versionCache.value;
    }
    const html = await fsp.readFile(file, 'utf8');
    const match = /(?:href|src)="[^"]*[?&]v=([\w.-]+)"/.exec(html);
    const value = match ? (match[1] as string) : '';
    versionCache = { file, mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return '';
  }
}
