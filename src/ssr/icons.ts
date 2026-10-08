/* ============================================================
 * SSR 版 svgIcon()
 * ------------------------------------------------------------
 * 逐字节复刻 app.js:176 `svgIcon(name, size)` 的实现与图标路径：
 *   width/height = size（默认 18），viewBox 0 0 24 24，stroke 1.7 圆头。
 *
 * 为什么不能省：图标本身就是 DOM 节点，缺了会让 app.js 接管时
 * 元素数量与尺寸发生变化（例如卡片缩略图占位、热门页的浏览/点赞/评论
 * 三连指标），属于铁律 4 里的「同构」范畴。
 *
 * 护栏：tests/ssr-icons.test.ts 会从 app/public/app.js 里把 `var I = {...}`
 * 的图标表整表抽出来，逐个与这里比对；任何一处路径写错都会让测试变红。
 * 因此本文件**不要**手写「差不多的」路径，必须从 app.js 原样抄。
 * ============================================================ */

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

/** 与 app.js `var I = {...}` 一一对应的图标路径（顺序亦保持一致，便于对照）。 */
const PATHS: Record<string, { cls?: string; body: string }> = {
  sun: { body: '<circle cx="12" cy="12" r="4"/><path d="M12 2.4v2.4M12 19.2v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.4 12h2.4M19.2 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>' },
  moon: { body: '<path d="M20.5 13.2A8.5 8.5 0 1 1 11 3.5a6.6 6.6 0 0 0 9.5 9.7z"/>' },
  pin: { body: '<path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>' },
  lock: { body: '<rect x="5" y="11" width="14" height="9" rx="1.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>' },
  eye: { body: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>' },
  heart: { body: '<path d="M12 20s-7-4.6-7-9.3A3.7 3.7 0 0 1 12 7a3.7 3.7 0 0 1 7 3.7C19 15.4 12 20 12 20z"/>' },
  cloud: { body: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 17.5 18z"/><path d="M12 13v5M9.5 15.5 12 13l2.5 2.5"/>' },
  save: { body: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>' },
  external: { body: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>' },
  download: { body: '<path d="M12 4v10M8 11l4 4 4-4M5 19h14"/>' },
  upload: { body: '<path d="M12 20V10M8 13l4-4 4 4M5 5h14"/>' },
  file: { body: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>' },
  rss: { body: '<circle cx="5" cy="18" r="1"/><path d="M4 11a9 9 0 0 1 9 9M4 5a15 15 0 0 1 15 15"/>' },
  sitemap: { body: '<rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="4" width="7" height="5" rx="1"/><rect x="9" y="15" width="7" height="5" rx="1"/><path d="M6.5 9v3h11V9M12.5 12v3"/>' },
  spinner: { cls: 'spin-icon', body: '<path d="M12 3a9 9 0 1 0 9 9" />' },
  question: { body: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.6a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 2-2.6 3.6M12 17h.01"/>' },
  doc: { body: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M9.5 12h5M9.5 15h5"/>' },
  top: { body: '<path d="M12 20V6"/><path d="M6 11.5 12 5.5l6 6"/>' },
  'arrow-left': { body: '<path d="M19 12H5M11 6l-6 6 6 6"/>' },
  chevron: { body: '<path d="M6 9.5l6 6 6-6"/>' },
  plus: { body: '<path d="M12 5.2v13.6M5.2 12h13.6"/>' },
  grip: { body: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>' },
  layers: { body: '<path d="M12 3.2l8.6 4.6-8.6 4.6-8.6-4.6L12 3.2z"/><path d="M3.4 12.4l8.6 4.6 8.6-4.6"/><path d="M3.4 16.6l8.6 4.6 8.6-4.6"/>' },
  pen: { body: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  logout: { body: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>' },
  trash: { body: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/>' },
  link: { body: '<path d="M10 14a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>' },
  image: { body: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l4.5-4.5 3 3L16 13l4 4"/>' },
  quote: { body: '<path d="M10 7H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2v-4H6"/><path d="M20 7h-4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2v-4h-2"/>' },
  tag: { body: '<path d="M3 3h7l11 11-7 7L3 10V3z"/><circle cx="7.5" cy="7.5" r="1.5"/>' },
  list: { body: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>' },
  check: { body: '<path d="M4 12.5l5 5L20 6.5"/>' },
  send: { body: '<path d="M3 11l18-8-8 18-2-8-8-2z"/><path d="M21 3 11 13"/>' },
  palette: { body: '<path d="M12 3a9 9 0 1 0 5.4 16.2A2.4 2.4 0 0 0 15.6 17h-.9a2.6 2.6 0 0 1-2.6-2.6c0-1.4 1.1-2.6 2.6-2.6h1.4A3.9 3.9 0 0 0 20.2 8 9 9 0 0 0 12 3z"/><circle cx="7.4" cy="11.3" r="1"/><circle cx="10.6" cy="7.2" r="1"/><circle cx="15.4" cy="8.6" r="1"/>' },
  globe: { body: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15.5 15.5 0 0 1 0 18M12 3a15.5 15.5 0 0 0 0 18"/>' },
  spark: { body: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>' },
  star: { body: '<path d="M12 3.4l2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.6l5.8-.9z"/>' },
  copy: { body: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>' },
  music: { body: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  play: { body: '<path d="M7 4.5v15l13-7.5z"/>' },
  pause: { body: '<path d="M7 4.5h3.4v15H7zM13.6 4.5H17v15h-3.4z"/>' },
  prev: { body: '<path d="M6 5v14M19 5l-9 7 9 7z"/>' },
  next: { body: '<path d="M18 5v14M5 5l9 7-9 7z"/>' },
  volume: { body: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>' },
  gauge: { body: '<path d="M4.5 17.5A8.5 8.5 0 1 1 19.5 17.5"/><path d="M12 14.2 16.8 9.4M3 17.5h18"/>' },
  sliders: { body: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9M13 4.5v5M7 14.5v5"/>' },
  clock: { body: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.2"/>' },
  bug: { body: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9 6.5a3 3 0 0 1 6 0M3.5 11H7M17 11h3.5M3.5 16H7M17 16h3.5"/>' },
  refresh: { body: '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v4.5h-4.5"/>' }
};

/** app.js 里 `var I = {...}` 的键序（护栏测试用来核对「一个不落、一个不多」）。 */
export const ICON_NAMES: readonly string[] = Object.keys(PATHS);

/** 与 app.js 的 svgIcon() 同构：size 缺省 18。未知图标返回空字符串（app.js 亦如此）。 */
export function svgIcon(name: string, size = 18): string {
  const icon = PATHS[name];
  if (!icon) return '';
  const s = `width="${size}" height="${size}"`;
  const cls = icon.cls ? ` class="${icon.cls}"` : '';
  return `<svg${cls} ${s} viewBox="0 0 24 24" ${STROKE}>${icon.body}</svg>`;
}
