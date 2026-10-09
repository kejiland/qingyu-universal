/* ============================================================
 * 外链图片 → 本地反代地址（/api/img）
 * ------------------------------------------------------------
 * 背景：封面 / 头像常常挂在境外图床（Cloudflare 节点）。浏览器首次访问要
 * 自己完成 DNS + TCP + TLS（实测到西雅图节点 TLS 握手就 0.4~0.5s），
 * 首屏 load 事件被拖到 2s 级，而图片本身可能只有 2KB —— 慢的是跨洋建连，
 * 不是带宽。
 *
 * 改法：渲染期把跨域 http(s) 图片地址改写成同源的 /api/img?url=…，
 * 由服务端抓取一次并落盘缓存，之后浏览器拿到的是本站 immutable 字节。
 *
 * 约定：
 *   · 相对地址（/media/x.png）、data:、blob: 原样返回 —— 它们本来就是本站的；
 *   · 与本站同域的绝对地址原样返回 —— 再绕一圈反代纯属浪费；
 *   · 反代关闭时原样返回（服务端对 /api/img 也会 302 回原始地址，行为一致）。
 *
 * ⚠️ app/public/app.js 里有一份等价的 JS 实现（proxiedImg()），
 *    由 scripts/apply-frontend-split.mjs 注入。改这里的判定规则时，
 *    必须同步改那一处 —— 否则 SSR 与前端接管后渲染出的地址不一致，
 *    浏览器会把同一张图按两个 URL 各下一遍。tests/image-proxy.test.ts
 *    对两处做了交叉断言。
 * ============================================================ */

let proxyEnabled = true;
let selfHost = '';

/** 取 URL 的主机名；解析失败或不是 http(s) 时返回空串。 */
export function hostOfUrl(value: string): string {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 由 createApp() 在启动时注入一次。SSR 是纯函数渲染，拿不到 AppConfig，
 * 因此用模块级开关把配置传进来（默认开启，测试无需显式配置）。
 */
export function configureImageProxy(options: { enabled?: boolean; selfHost?: string }): void {
  if (typeof options.enabled === 'boolean') proxyEnabled = options.enabled;
  if (typeof options.selfHost === 'string') selfHost = options.selfHost.toLowerCase();
}

/** 仅供测试：恢复默认（开启 + 无自身域名）。 */
export function resetImageProxy(): void {
  proxyEnabled = true;
  selfHost = '';
}

/* ------------------------------------------------------------
 * 写路径预热
 * ------------------------------------------------------------
 * 反代只有「第一次抓、之后都走缓存」两段。发布新文章的封面是个全新 URL，
 * 如果等读者来触发，那第一位读者仍然是冷抓取 —— 也就是用户抱怨的
 * 「发布后第一次打开慢」。所以在文章写入成功后立刻后台预热，
 * 等作者自己打开时缓存大概率已经热了。
 *
 * 注册表由 createImageProxyHandler() 填充（生产只有一个实例）；
 * 未注册时 warmImageCache() 是空操作，不会拖累启动顺序。
 * ------------------------------------------------------------ */
type ImageWarmer = (urls: string[]) => void;
let warmer: ImageWarmer | null = null;

export function setImageWarmer(fn: ImageWarmer | null): void {
  warmer = fn;
}

/** 后台预热一批图片地址；失败静默（预热是尽力而为，不该影响业务响应）。 */
export function warmImageCache(urls: string[]): void {
  const list = (urls ?? []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 8);
  if (!warmer || !list.length) return;
  try {
    warmer(Array.from(new Set(list)));
  } catch {
    /* 预热失败不影响任何业务 */
  }
}

/** 单个图片地址 → 反代地址（不需要反代时原样返回）。 */
export function imageProxyUrl(raw: string): string {
  const url = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return url;
  if (!proxyEnabled) return url;
  if (selfHost && hostOfUrl(url) === selfHost) return url;
  return `/api/img?url=${encodeURIComponent(url)}`;
}

/**
 * 把一段已渲染 HTML 里的 `<img src="http(s)…">` 批量改写成反代地址。
 * 用于 SSR 的 Markdown 正文（src/ssr/post.ts）—— 正文里的配图往往也是外链。
 * 只动 src 属性：srcset 里的候选地址交给浏览器自己挑，改了反而容易选错。
 */
const IMG_SRC_EXTERNAL = /(<img\b[^>]*?\ssrc=)(["'])(https?:\/\/[^"']+)\2/gi;

export function proxyHtmlImgSources(html: string): string {
  if (!html) return html;
  return html.replace(IMG_SRC_EXTERNAL, (_all, head: string, quote: string, src: string) => {
    return head + quote + imageProxyUrl(src) + quote;
  });
}
