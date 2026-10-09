/* ============================================================
 * 公开站前端拆分补丁（幂等）
 * ------------------------------------------------------------
 * 上游 qingyu-blog 的 app/public 仍是「296 KB 单文件 + 首屏直连」
 * 形态。本项目把旧后台回退拆成按需分包，并用轻量启动器接管首屏。
 * 覆盖 app/public 后执行本脚本即可重新应用；已打过补丁则只校验。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'app/public');
const read = (name) => fs.readFileSync(path.join(PUB, name), 'utf8');
const write = (name, text) => fs.writeFileSync(path.join(PUB, name), text, 'utf8');
const report = [];

const BOOT_SOURCE = `/* ============================================================
 * 公开站启动器（约 1 KB）
 * ------------------------------------------------------------
 * 服务端已 SSR 的页面先展示内容，再在空闲时机增强；
 * 没有 SSR 内容（启动动画仍在）或进入后台/预览时立即加载。
 * 该脚本在 config/posts/i18n 之后按 defer 顺序执行，保证依赖就绪。
 * ============================================================ */
(function () {
  'use strict';
  var script = document.currentScript;
  var ver = '';
  if (script && script.src && script.src.indexOf('?') >= 0) ver = script.src.slice(script.src.indexOf('?') + 1);
  var loaded = false;

  function loadApp() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement('script');
    s.src = 'app.min.js' + (ver ? '?' + ver : '');
    s.async = false;
    document.head.appendChild(s);
  }

  function isImmediate() {
    var p = location.pathname || '/';
    if (p === '/write' || p.indexOf('/admin') === 0 || p.indexOf('/preview/') === 0) return true;
    if (/^\\/posts\\/[^/]+\\/edit\\/?$/.test(p)) return true;
    var root = document.getElementById('app');
    return !root || !!root.querySelector('.boot-load');
  }

  function schedule() {
    if (isImmediate()) { loadApp(); return; }
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (evt) {
      window.addEventListener(evt, loadApp, { passive: true, once: true });
    });
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(loadApp, { timeout: 2500 });
    } else {
      window.setTimeout(loadApp, 1200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  } else {
    schedule();
  }
})();
`;

const LEGACY_HEADER = `/* ============================================================
 * 旧版后台回退分包（仅在新版 /admin 包缺失或加载失败时按需加载）
 * ------------------------------------------------------------
 * 由 app.js 的 ensureLegacyAdmin() 动态注入；本文件是经典脚本，
 * 顶层函数会挂到全局，与 app.js 共享同一套工具函数。
 * ============================================================ */
`;

function nextPatchVersion(version) {
  const parts = String(version || '0.0.0').split('.');
  while (parts.length < 3) parts.push('0');
  const n = Number(parts[2]);
  parts[2] = Number.isFinite(n) ? String(n + 1) : '1';
  return parts.join('.');
}

function splitLegacy(app) {
  const lines = app.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes('管理后台辅助函数'));
  const routing = lines.findIndex((l) => l.startsWith('/* ---------- 路由 ----------'));
  if (start < 0 || routing < 0 || routing <= start) {
    throw new Error('未找到旧后台块边界（管理后台辅助函数 / 路由）');
  }
  const legacy = lines.slice(start, routing);
  const rest = lines.slice(0, start).concat(lines.slice(routing));

  const ensure = [
    '/* 旧后台回退：仅在新版后台包加载失败时按需拉取，公开站首屏不再为它付费。 */',
    'var _legacyAdminPromise = null;',
    'function ensureLegacyAdmin() {',
    '  if (typeof window.renderAdmin === \'function\' || typeof renderAdmin === \'function\') return Promise.resolve(true);',
    '  if (!_legacyAdminPromise) {',
    '    _legacyAdminPromise = new Promise(function (resolve) {',
    '      var s = document.createElement(\'script\');',
    '      s.src = \'admin-legacy.min.js?v=\' + BLOG_VERSION;',
    '      s.onload = function () { resolve(typeof renderAdmin === \'function\'); };',
    '      s.onerror = function () { resolve(false); };',
    '      document.head.appendChild(s);',
    '    });',
    '  }',
    '  return _legacyAdminPromise;',
    '}',
    ''
  ];
  const exportIdx = rest.findIndex((l) => l.startsWith('/* ---------- 导出 ---------- */'));
  if (exportIdx < 0) throw new Error('未找到 app.js 导出标记');
  rest.splice(exportIdx, 0, ...ensure);

  const fail = [
    'function renderLegacyLoadFail(path) {',
    '  app().innerHTML = renderNav(path) + \'<main class="container page-fade"><div class="empty"><div class="big">\' +',
    '    svgIcon(\'question\', 36) + \'</div><p>\' + esc(t(\'post.loadFail\')) + \'</p><p><a href="\' +',
    '    esc(href(\'/\')) + \'">\' + esc(t(\'post.backHome\')) + \'</a></p></div></main>\' + renderFooter();',
    '}',
    ''
  ];
  const routeIdx = rest.findIndex((l) => l.startsWith('async function route()'));
  if (routeIdx < 0) throw new Error('未找到 route()');
  rest.splice(routeIdx, 0, ...fail);

  let writePatched = 0;
  let adminPatched = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].trim();
    if (t === 'renderWrite(id);') {
      rest[i] = [
        '      if (await ensureLegacyAdmin() && typeof renderWrite === \'function\') {',
        '        renderWrite(id);',
        '      } else {',
        '        renderLegacyLoadFail(path);',
        '      }'
      ].join('\n');
      writePatched++;
    } else if (t === 'renderAdmin();') {
      rest[i] = [
        '      if (await ensureLegacyAdmin() && typeof renderAdmin === \'function\') {',
        '        renderAdmin();',
        '      } else {',
        '        renderLegacyLoadFail(path);',
        '      }'
      ].join('\n');
      adminPatched++;
    }
  }
  if (!writePatched || !adminPatched) {
    throw new Error('route() 里的旧后台回退调用未找到，上游路由结构可能已变化');
  }
  write('admin-legacy.js', LEGACY_HEADER + legacy.join('\n'));
  return rest.join('\n');
}

function patchDisplayPolish(app) {
  if (app.includes('function fmtDate(')) return app;

  const anchor = 'function renderCard(p, idx) {';
  if (!app.includes(anchor)) throw new Error('未找到 renderCard()，上游结构可能已变化');

  const helper = [
    '/** 卡片 / 文章头的日期展示：ISO 串收敛成 YYYY-MM-DD，其余格式原样返回。',
    ' *  RSS rfc822、JSON-LD datePublished、archive 年份切片都不走这里。 */',
    'function fmtDate(v) {',
    "  var m = /^(\\d{4}-\\d{2}-\\d{2})/.exec(String(v || '').trim());",
    "  return m ? m[1] : String(v || '');",
    '}',
    ''
  ].join('\n');

  let out = app.replace(anchor, helper + '\n' + anchor);

  const swaps = [
    ["esc(tags || p.date || '')", "esc(tags || fmtDate(p.date) || '')"],
    ["esc(p.date || '')", "esc(fmtDate(p.date) || '')"],
    ["esc(c.date || '')", "esc(fmtDate(c.date) || '')"],
    ["esc(post.date || '')", "esc(fmtDate(post.date) || '')"]
  ];
  let hits = 0;
  for (const pair of swaps) {
    const n = out.split(pair[0]).length - 1;
    if (n === 0) throw new Error('日期展示点未找到：' + pair[0]);
    out = out.split(pair[0]).join(pair[1]);
    hits += n;
  }

  const oldExcerpt = "var excerpt = p.excerpt || stripMd(p.content || '').slice(0, 100);";
  const newExcerpt = "var excerpt = p.excerpt || stripMd(p.content || p.search || '').slice(0, 100);";
  if (!out.includes(oldExcerpt)) throw new Error('renderCard 摘要兜底语句未找到');
  out = out.split(oldExcerpt).join(newExcerpt);

  report.push('[ok]   日期规范化 fmtDate x' + hits + ' + 摘要兜底（search 全文）');
  return out;
}
function bumpCacheVersion(app) {
  const m = app.match(/BLOG_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('未找到 BLOG_VERSION');
  const oldVersion = m[1];
  const newVersion = nextPatchVersion(oldVersion);
  const nextApp = app.replace(`BLOG_VERSION = '${oldVersion}'`, `BLOG_VERSION = '${newVersion}'`);

  let html = read('index.html').split(oldVersion).join(newVersion);
  html = html.replace(
    /<script defer src="app\.min\.js(\?[^"]*)"><\/script>/,
    '<script defer src="boot.min.js?v=' + newVersion + '"></script>'
  );
  write('index.html', html);

  let sw = read('sw.js');
  sw = sw.replace(/CACHE_VERSION = '[^']+'/, `CACHE_VERSION = '${newVersion}'`);
  write('sw.js', sw);

  const llmsPath = path.join(PUB, 'llms.txt');
  if (fs.existsSync(llmsPath)) {
    const llms = fs.readFileSync(llmsPath, 'utf8').split(oldVersion).join(newVersion);
    fs.writeFileSync(llmsPath, llms, 'utf8');
  }
  report.push(`版本 ${oldVersion} -> ${newVersion}（缓存失效）`);
  return nextApp;
}

function patchShellReferences() {
  let html = read('index.html');
  if (!html.includes('boot.min.js')) {
    const before = html;
    html = html.replace(
      /<script defer src="app\.min\.js(\?[^"]*)"><\/script>/,
      (all, query) => '<script defer src="boot.min.js' + (query || '') + '"></script>'
    );
    if (html === before) throw new Error('index.html 未找到 app.min.js 启动脚本');
    write('index.html', html);
    report.push('index.html -> boot 启动器');
  }

  let sw = read('sw.js');
  if (!sw.includes('./boot.min.js') || !sw.includes('./admin-legacy.min.js')) {
    sw = sw.replace(
      /(\s*'\.\/app\.min\.js',)/,
      "\n  './boot.min.js',\n  './admin-legacy.min.js',$1"
    );
    write('sw.js', sw);
    report.push('sw.js 缓存清单补齐分包');
  }

  let headers = read('_headers');
  if (!headers.includes('/boot.min.js*')) {
    const crlf = headers.includes('\r\n');
    const nl = crlf ? '\r\n' : '\n';
    const anchor = `/app.min.js*${nl}  Cache-Control: public, max-age=31536000, immutable${nl}`;
    if (!headers.includes(anchor)) throw new Error('_headers 缺少 app.min.js 缓存锚点');
    headers = headers.replace(
      anchor,
      anchor + `${nl}/boot.min.js*${nl}  Cache-Control: public, max-age=31536000, immutable${nl}${nl}` +
        `/admin-legacy.min.js*${nl}  Cache-Control: public, max-age=31536000, immutable${nl}`
    );
    write('_headers', headers);
    report.push('_headers 缓存规则补齐分包');
  }
}

function ensurePolishShell() {
  const version = (read('app.js').match(/BLOG_VERSION\s*=\s*'([^']+)'/) || [])[1];
  if (!version) throw new Error('app.js 未找到 BLOG_VERSION');

  let html = read('index.html');
  if (!html.includes('polish.min.css')) {
    const before = html;
    html = html.replace(
      /(<link id="global-style"[^>]*style\.min\.css[^>]*>\s*\r?\n)/,
      '$1  <link rel="stylesheet" href="polish.min.css?v=' + version + '">\n'
    );
    if (html === before) throw new Error('index.html 未找到 style.min.css 锚点，无法插入 polish 样式');
    write('index.html', html);
    report.push('index.html -> polish.min.css 叠加样式');
  }

  let sw = read('sw.js');
  if (!sw.includes('./polish.min.css')) {
    const before = sw;
    sw = sw.replace("  './style.min.css',", "  './style.min.css',\n  './polish.min.css',");
    if (sw === before) throw new Error('sw.js 未找到 style.min.css 锚点');
    write('sw.js', sw);
    report.push('sw.js 缓存清单补齐 polish.min.css');
  }

  let headers = read('_headers');
  if (!headers.includes('/polish.min.css*')) {
    const nl = headers.includes('\r\n') ? '\r\n' : '\n';
    const anchor = '/style.min.css*' + nl + '  Cache-Control: public, max-age=31536000, immutable';
    if (!headers.includes(anchor)) throw new Error('_headers 未找到 style.min.css 缓存锚点');
    headers = headers.replace(
      anchor,
      anchor + nl + nl + '/polish.min.css*' + nl + '  Cache-Control: public, max-age=31536000, immutable'
    );
    write('_headers', headers);
    report.push('_headers 缓存规则补齐 polish.min.css');
  }
}
/* 主样式表立即加载：上游把 style.min.css 写成 media="print" + onload 切 all
 * （PageSpeed「消除渲染阻塞」技巧），但本站是 SSR —— 正文已服务端渲染，
 * 没有 CSS 首屏就是裸结构 + 启动动画，实测 FCP 476ms（DOM 79ms 就绪，
 * 白等 CSS 约 400ms）。改为 preload 提高下载优先级 + 正常阻塞渲染。
 * 幂等：找不到 media="print" 就说明已经改过，直接跳过。 */
function patchCriticalCss() {
  let html = read('index.html');
  if (!/id="global-style"[^>]*media="print"/.test(html)) {
    report.push('[skip] 主样式表已是立即加载');
    return;
  }
  const version = (read('app.js').match(/BLOG_VERSION\s*=\s*'([^']+)'/) || [])[1];
  if (!version) throw new Error('app.js 未找到 BLOG_VERSION');
  const nl = html.includes('\r\n') ? '\r\n' : '\n';
  // 先摘掉 global-style 的延迟属性，再在它前面插入 preload 提示
  html = html.replace(
    /(<link id="global-style"[^>]*?) media="print" onload="this\.media='all'"/,
    '$1'
  );
  if (!html.includes('rel="preload" as="style" href="style.min.css')) {
    html = html.replace(
      /(\s*)(<link id="global-style")/,
      `$1<link rel="preload" as="style" href="style.min.css?v=${version}">${nl}  $2`
    );
  }
  write('index.html', html);
  report.push('index.html -> 主样式表立即加载（SSR 首屏必需，FCP 实测 476ms -> <200ms）');
}

/* 外链图挂死看门狗：图床不可达时浏览器十几秒不报错，load 事件被拖住
 * （实测 12.5s，标签页一直转圈 —— 用户感知的「首页打开慢」）。
 * 在 index.html 注入内联看门狗：4s 没加载完的外链 eager 图直接移除。
 * 幂等：已有 data-watched 逻辑就跳过。 */
function patchImageWatchdog() {
  let html = read('index.html');
  if (html.includes('外链图挂死看门狗')) {
    report.push('[skip] 外链图看门狗已存在');
    return;
  }
  const nl = html.includes('\r\n') ? '\r\n' : '\n';
  const anchor = /(<script defer src="boot\.min\.js\?[^"]*"><\/script>)/;
  if (!anchor.test(html)) throw new Error('index.html 未找到 boot.min.js 锚点，无法注入看门狗');
  const watchdog = [
    '$1' + nl + '  <script>',
    '  /* 外链图挂死看门狗：图床 DNS 失败 / 代理挂死时，浏览器可能十几秒都不报',
    '   * error，load 事件被拖住（实测 12.5s）。对 4 秒内仍没加载完的外链 eager 图',
    '   * 直接移除：渐变占位顶上，load 事件尽快触发。同源图与懒加载图不设看门狗。',
    '   * app.js 接管重建 DOM 后，用 MutationObserver 把新插入的图也看住。 */',
    '  (function () {',
    '    function watch(img) {',
    '      var src = img.getAttribute(\'src\') || \'\';',
    '      if (!/^https?:/i.test(src)) return;',
    '      if ((img.getAttribute(\'loading\') || \'\').toLowerCase() === \'lazy\') return;',
    '      try { if (new URL(src, location.href).host === location.host) return; } catch (e) {}',
    '      var t = setTimeout(function () { if (!img.complete) img.remove(); }, 4000);',
    '      img.addEventListener(\'load\', function () { clearTimeout(t); }, { once: true });',
    '      img.addEventListener(\'error\', function () { clearTimeout(t); }, { once: true });',
    '    }',
    '    function scan(root) {',
    '      var imgs = (root || document).querySelectorAll(\'img\');',
    '      for (var i = 0; i < imgs.length; i++) {',
    '        if (!imgs[i].getAttribute(\'data-watched\')) { imgs[i].setAttribute(\'data-watched\', \'1\'); watch(imgs[i]); }',
    '      }',
    '    }',
    '    function boot() {',
    '      scan();',
    '      if (\'MutationObserver\' in window) {',
    '        new MutationObserver(function (muts) {',
    '          for (var i = 0; i < muts.length; i++) {',
    '            var n = muts[i].addedNodes;',
    '            for (var j = 0; j < n.length; j++) {',
    '              if (n[j].nodeType !== 1) continue;',
    '              if (n[j].tagName === \'IMG\') { n[j].setAttribute(\'data-watched\', \'1\'); watch(n[j]); }',
    '              else if (n[j].querySelectorAll) scan(n[j]);',
    '            }',
    '          }',
    '        }).observe(document.body, { childList: true, subtree: true });',
    '      }',
    '    }',
    '    if (document.readyState === \'loading\') document.addEventListener(\'DOMContentLoaded\', boot, { once: true });',
    '    else boot();',
    '  })();',
    '  </script>'
  ].join(nl);
  html = html.replace(anchor, watchdog);
  write('index.html', html);
  report.push('index.html -> 外链图挂死看门狗（4s 超时移除，load 不再被拖 10s+）');
}

/* 首屏阅读字号预设：与主题 / 主题色一样在 index.html 内联脚本里同步应用，
 * 避免 SSR 正文先用默认字号渲染、app.js 接管后才跳到用户设置的值。
 * 依赖 app.js 的 READING_SCALE_KEY('qingyu.readingScale') 与 .article 的
 * calc(16.5px * var(--reading-scale, 1))。幂等：已有该键就跳过。 */
function patchReadingScalePreset() {
  let html = read('index.html');
  if (html.includes('qingyu.readingScale')) {
    report.push('[skip] 首屏阅读字号预设已存在');
    return;
  }
  const nl = html.includes('\r\n') ? '\r\n' : '\n';
  const anchor = /(document\.documentElement\.setAttribute\('data-accent', a\);[\s\S]{0,40}?catch \(e\) \{\})/;
  if (!anchor.test(html)) throw new Error('index.html 未找到主题内联脚本锚点，无法注入阅读字号预设');
  const block = [
    '$1' + nl,
    '      // 正文字号（阅读缩放）：与主题 / 主题色一样在首屏前应用。',
    '      // 否则 SSR 出来的正文先用默认字号渲染，app.js 接管后才跳到用户设置的值。',
    '      // 键名与 app.js 的 READING_SCALE_KEY 一致，取值区间也对齐（0.85~1.5）。',
    '      try {',
    '        var rs = Number(localStorage.getItem(\'qingyu.readingScale\'));',
    '        if (rs >= 0.85 && rs <= 1.5) {',
    '          document.documentElement.style.setProperty(\'--reading-scale\', String(rs));',
    '        }',
    '      } catch (e) {}',
    '      /* 字号按钮的**首屏兜底**：SSR（src/ssr/post.ts）直接把 A-/A/A+ 渲染进',
    '       * 静态 HTML，而事件绑定在 app.js 里 —— 它要等到空闲或用户交互才加载',
    '       * （boot.js 的渐进增强），这之前按钮是死的，点了没反应。',
    '       * 这里用 document 级**捕获**委托让按钮首屏即可用；捕获阶段先于按钮上的',
    '       * handler，处理完 stopPropagation，避免 app.js 接管后两边各加一次 0.1。',
    '       * 逻辑与 app.js 的 setReadingScale 完全对齐（同键名、同 0.85~1.5 区间）。 */',
    '      document.addEventListener(\'click\', function (e) {',
    '        var btn = e.target && e.target.closest ? e.target.closest(\'[data-rs]\') : null;',
    '        if (!btn) return;',
    '        e.stopPropagation();',
    '        e.preventDefault();',
    '        var step = Number(btn.getAttribute(\'data-rs\'));',
    '        var cur = 1;',
    '        try { cur = Number(localStorage.getItem(\'qingyu.readingScale\')) || 1; } catch (err) {}',
    '        if (!(cur >= 0.85 && cur <= 1.5)) cur = 1;',
    '        var next = step === 0 ? 1 : Math.round((cur + step * 0.1) * 100) / 100;',
    '        next = Math.max(0.85, Math.min(1.5, next));',
    '        next = Math.round(next * 100) / 100;',
    '        try {',
    '          localStorage.setItem(\'qingyu.readingScale\', String(next));',
    '          document.documentElement.style.setProperty(\'--reading-scale\', String(next));',
    '        } catch (err) {}',
    '      }, true);'
  ].join(nl);
  html = html.replace(anchor, block);
  write('index.html', html);
  report.push('index.html -> 首屏阅读字号预设（避免接管时跳字号）');
}

function patchSwCacheStrategy() {
  let sw = read('sw.js');
  if (sw.includes('searchParams.has(\'v\')')) return;
  const nl = sw.includes('\r\n') ? '\r\n' : '\n';
  const oldFn = [
    'async function staleWhileRevalidate(request) {',
    '  var cached = await caches.match(request, { ignoreSearch: true });',
    '  var network = fetch(request).then(async function (response) {'
  ].join(nl);
  const newFn = [
    'async function staleWhileRevalidate(request) {',
    '  /* 静态资源带 ?v= 版本号：必须按完整 URL 精确命中，不能 ignoreSearch。',
    '   * 否则新版 ?v=X 会先匹配到旧版 ?v=Y 的缓存字节，表现为「CSS 已更新、JS 还是旧的」。',
    '   * 无版本号的 URL 才退回忽略参数匹配。 */',
    '  var versioned = new URL(request.url).searchParams.has(\'v\');',
    '  var cached = await caches.match(request);',
    '  if (!cached && !versioned) cached = await caches.match(request, { ignoreSearch: true });',
    '  var network = fetch(request).then(async function (response) {'
  ].join(nl);
  if (!sw.includes(oldFn)) throw new Error('sw.js 未找到 staleWhileRevalidate 锚点');
  sw = sw.replace(oldFn, newFn);
  write('sw.js', sw);
  report.push('sw.js 静态缓存改为按 ?v= 精确命中');
}
let app = read('app.js');
if (app.includes('function ensureLegacyAdmin()')) {
  if (!fs.existsSync(path.join(PUB, 'admin-legacy.js'))) {
    throw new Error('app.js 已拆分但 admin-legacy.js 缺失');
  }
  report.push('[skip] 旧后台分包已存在');
} else {
  app = splitLegacy(app);
  app = bumpCacheVersion(app);
  write('app.js', app);
  report.push('[ok]   旧后台拆分为 admin-legacy 分包');
}

if (!fs.existsSync(path.join(PUB, 'boot.js'))) write('boot.js', BOOT_SOURCE);
app = patchDisplayPolish(app);
write('app.js', app);
ensurePolishShell();
patchCriticalCss();
patchReadingScalePreset();
patchImageWatchdog();
patchSwCacheStrategy();
patchShellReferences();
checkAdminIncrements();

console.log(report.join('\n'));

/* ------------------------------------------------------------
 * 原生后台的自有增量自检
 * ------------------------------------------------------------
 * 上游 `cp -a public` 会整文件覆盖 admin.js / admin.css，把本项目补进去的
 * 「Vue 版增量能力」一起冲掉。这里只做**可见的告警**，不抛错 —— 抛错会让
 * 「同步上游」这条标准流程直接失败，而丢功能本身也应先被看见、再决定怎么补。
 * 每个标记都对应一项功能，缺失时按提示重贴即可。
 * ------------------------------------------------------------ */
function checkAdminIncrements() {
  const guards = [
    { file: 'admin.js', needle: 'WELCOME_DISMISS_KEY', what: '新站上手引导' },
    { file: 'admin.js', needle: 'abAccentToggle', what: '顶栏主题色选择器' },
    { file: 'admin.js', needle: 'data-abai="tags"', what: '编辑器 AI「标签建议」' },
    { file: 'admin.js', needle: 'ab-link-drag', what: '页脚 / 友链拖拽排序' },
    { file: 'admin.js', needle: 'data-sjson', what: '高级设置 JSON 模式' },
    { file: 'admin.js', needle: 'admin.settings.linkDragHint', what: '拖拽提示文案' },
    { file: 'admin.js', needle: 'admin.settings.jsonApply', what: 'JSON 模式文案' },
    { file: 'admin.js', needle: 'admin.settings.aiTab', what: 'AI 助手配置页 tab' },
    { file: 'admin.js', needle: '#abAiFetchModels', what: 'AI 拉取模型按钮' },
    { file: 'admin.js', needle: '#abAiClearKey', what: 'AI 清除密钥选项' },
    { file: 'admin.js', needle: 'ab-ai-model', what: 'AI 模型可点选列表' },
    { file: 'admin.js', needle: 'admin.login.fail', what: '操作日志动作筛选齐全' },
    { file: 'admin.js', needle: 'navScrollTop', what: '侧边栏切页保留滚动位置' },
    { file: 'admin.js', needle: 'function absUrl', what: '媒体复制链接补全为完整地址' },
    { file: 'admin.js', needle: 'bindStorageSettings', what: '存储（媒体/音乐）配置页' },
    { file: 'admin.js', needle: 'storage.migrate', what: '存储迁移审计动作' },
    { file: 'admin.css', needle: '.ab-welcome-card', what: '上手引导样式' },
    { file: 'admin.css', needle: '.ab-link-drag', what: '拖拽手柄样式' },
    { file: 'admin.css', needle: '.ab-ai-model', what: 'AI 模型列表样式' }
  ];
  const missing = [];
  for (const g of guards) {
    const text = fs.readFileSync(path.join(PUB, g.file), 'utf8');
    if (!text.includes(g.needle)) missing.push(`${g.file} → ${g.what}`);
  }
  if (missing.length) {
    report.push('[warn] 原生后台的自有增量疑似被上游覆盖，以下功能需要重新补：');
    for (const m of missing) report.push('       · ' + m);
    report.push('       参考 README 的「后台」一节与 docs/UPSTREAM.md 的增量清单。');
  } else {
    report.push('[ok]   原生后台自有增量齐全（引导 / 主题色 / AI 标签 / 拖拽 / JSON 模式 / AI 配置页）');
  }

  /* 后端 AI 配置增量：迁移 / 路由 / 动态绑定。上游同步不覆盖 src 与 migrations，
     但保留这道自检可以在产物被误删或手工回滚时第一时间发现。 */
  const backend = [
    { file: 'app/migrations/0036_ai_config.sql', needle: 'ai_config', what: 'ai_config 表迁移' },
    { file: 'src/bindings/ai-config.ts', needle: 'aiRuntime', what: 'AI 运行时单例' },
    { file: 'src/api/routes/admin-ai.ts', needle: '/api/admin/ai', what: 'AI 配置路由' },
    { file: 'src/bindings/worker-env.ts', needle: "define('AI'", what: 'env.AI 动态绑定' },
    { file: 'src/bindings/worker-env.ts', needle: "define('LOCAL_STORAGE'", what: 'env.LOCAL_STORAGE 动态绑定' },
    { file: 'src/bindings/worker-env.ts', needle: 'storageEnvBindings(config.siteUrl)', what: 'env.R2_* 动态绑定' },
    { file: 'app/migrations/0037_storage_config.sql', needle: 'storage_config', what: 'storage_config 表迁移' },
    { file: 'src/bindings/storage-config.ts', needle: 'storageRuntime', what: '存储运行时单例' },
    { file: 'src/api/routes/admin-storage.ts', needle: '/api/admin/storage', what: '存储配置路由' },
    { file: 'src/api/admin-auth.ts', needle: 'adminGuard', what: '后台本地接口共用鉴权' },
    { file: 'src/bindings/object-migrate.ts', needle: 'migrateLocalObjects', what: '本地文件迁移到对象存储' }
  ];
  const missingBackend = [];
  for (const g of backend) {
    const abs = path.join(ROOT, g.file);
    if (!fs.existsSync(abs) || !fs.readFileSync(abs, 'utf8').includes(g.needle)) {
      missingBackend.push(`${g.file} → ${g.what}`);
    }
  }
  if (missingBackend.length) {
    report.push('[warn] 后端存储 / AI 配置增量缺失，对应后台页将不可用：');
    for (const m of missingBackend) report.push('       · ' + m);
  } else {
    report.push('[ok]   后端存储 / AI 配置增量齐全（迁移 / 路由 / 运行时单例 / 动态绑定 / 共用鉴权）');
  }
}
