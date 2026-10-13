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

/* 版本号统一：上游 index.html 的 ?v= 与 app.js 的 BLOG_VERSION 本身就不一致
 * （上游发布 tag 与资源版本号分开维护），而后台产物由 app.js 以
 * admin.min.js?v=BLOG_VERSION 注入，版本号必须全局唯一，否则浏览器会混用
 * 两套缓存。这里以 app.js 的 BLOG_VERSION 为准，把 index.html 里所有
 * ?v=x.y.z 统一改写（幂等）。 */
function normalizeIndexVersions() {
  const version = (read('app.js').match(/BLOG_VERSION\s*=\s*'([^']+)'/) || [])[1];
  if (!version) throw new Error('app.js 未找到 BLOG_VERSION');
  let html = read('index.html');
  const before = html;
  html = html.replace(/\?v=\d+\.\d+\.\d+/g, '?v=' + version);
  if (html !== before) {
    write('index.html', html);
    report.push('index.html -> 资源版本号统一为 ' + version);
  } else {
    report.push('[skip] index.html 版本号已统一');
  }
}function ensurePolishShell() {
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

/* 外链图片本地反代：把跨域图片地址改写成同源的 /api/img?url=…
 * （服务端抓取一次 + 落盘缓存，见 src/routes/image-proxy.ts）。
 * 原先首屏封面 / 头像由浏览器直连境外图床，实测仅 TLS 握手就要 0.4~0.5s，
 * load 事件被拖到 2s 级。改走本站后首次也是同源请求，之后 immutable 命中。
 *
 * ⚠️ 必须与 src/lib/image-url.ts 的 imageProxyUrl() 保持同样的判定规则：
 *    相对地址 / data: / 同源绝对地址原样返回，其余跨域 http(s) 才改写。
 *    两边不一致会让 SSR 与前端接管后渲染出两个不同的 URL，
 *    浏览器把同一张图各下一遍。tests/image-proxy.test.ts 有交叉断言。
 * 幂等：已有 proxiedImg() 就跳过。 */
function patchImageProxy(app) {
  if (app.includes('function proxiedImg(')) {
    report.push('[skip] 外链图片本地反代已存在');
    return app;
  }

  const helper = [
    '/** 外链图片本地反代：把跨域图片改写成 /api/img?url=…（服务端抓取 + 落盘缓存）。',
    ' *  首屏封面 / 头像原先要浏览器直连境外图床（实测建连 0.4s+），改走本站后',
    ' *  首次也是同源请求，命中缓存后带 immutable 强缓存。',
    ' *  相对地址 / data: / 同源地址原样返回；服务端关闭反代时会 302 回原始地址。 */',
    'function proxiedImg(u) {',
    "  var s = String(u || '').trim();",
    "  if (!/^https?:\\/\\//i.test(s)) return s;",
    '  try {',
    '    if (new URL(s, location.href).host === location.host) return s;',
    '  } catch (e) {}',
    "  return '/api/img?url=' + encodeURIComponent(s);",
    '}',
    ''
  ].join('\n');

  const anchor = 'function renderPostThumb(p, idx) {';
  if (!app.includes(anchor)) throw new Error('未找到 renderPostThumb()，上游结构可能已变化');
  let out = app.replace(anchor, helper + anchor);

  const swaps = [
    // 卡片 / 列表封面（含从正文提取的第一张图）
    [
      "var url = String((p && p.cover) || '').trim() || firstImageFrom(p && p.content);",
      "var url = proxiedImg(String((p && p.cover) || '').trim() || firstImageFrom(p && p.content));",
      '列表封面'
    ],
    // 正文 Markdown 图片
    [
      'return \'<img src="\' + src + \'" alt="\' + alt + \'" loading="lazy" decoding="async" referrerpolicy="no-referrer">\';',
      'return \'<img src="\' + proxiedImg(src) + \'" alt="\' + alt + \'" loading="lazy" decoding="async" referrerpolicy="no-referrer">\';',
      '正文图片'
    ],
    // 关于页博主头像
    [
      'if (profAvatar) html += \'<img class="about-author-avatar" src="\' + esc(profAvatar) + \'"',
      'if (profAvatar) html += \'<img class="about-author-avatar" src="\' + esc(proxiedImg(profAvatar)) + \'"',
      '博主头像'
    ],
    // 站点头像（后台 / 前台 favicon）
    [
      'if (_fl) _fl.setAttribute(\'href\', _fv); }',
      'if (_fl) _fl.setAttribute(\'href\', proxiedImg(_fv)); }',
      '后台 favicon'
    ],
    [
      "if (faviconLink) faviconLink.setAttribute('href', siteAvatar);",
      "if (faviconLink) faviconLink.setAttribute('href', proxiedImg(siteAvatar));",
      '前台 favicon'
    ]
  ];

  const applied = [];
  for (const [from, to, what] of swaps) {
    if (!out.includes(from)) throw new Error('外链图片反代：未找到改写点 —— ' + what);
    out = out.split(from).join(to);
    applied.push(what);
  }

  report.push('[ok]   外链图片本地反代 /api/img（' + applied.join('、') + '）');
  return out;
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
/* 旧正文 HTML 归一化：WordPress 等旧平台导入的老文章里混着原始 HTML
 *（&nbsp; 实体、<!--more--> 注释、早已失效的 Flash <embed>/<object> 播放器）。
 * app.js 的 inlineMd() 会对全文做 HTML 转义，这些标记会变成字面文字直接显示给读者；
 * 服务端 SSR 用 marked 透传同一段内容，两边规则必须一致，否则首屏与接管后会分叉。
 *
 * ⚠️ 必须与 src/lib/legacy-html.ts 的 normalizeLegacyHtml() 保持同样的规则：
 *    tests/legacy-html.test.ts 有交叉断言。
 * 幂等：已有 normalizeLegacyHtml() 就跳过。 */
function patchLegacyHtmlNormalization(app) {
  if (app.includes('function normalizeLegacyHtml(')) {
    report.push('[skip] 旧正文 HTML 归一化已存在');
    return app;
  }

  const nl = app.includes('\r\n') ? '\r\n' : '\n';
  const helper = [
    '/* ---------- 旧正文 HTML 归一化（与服务端 src/lib/legacy-html.ts 同规则） ----------',
    ' * WordPress 等旧平台导入的老文章，正文里混着原始 HTML：排版用的 &nbsp; 实体、',
    ' * <!--more--> 摘要分隔注释、以及早就无法播放的 Flash <embed>/<object> 播放器。',
    ' * app.js 的 inlineMd() 会先对全文做 HTML 转义，这些标记就会变成 "&nbsp;"、',
    ' * "<!--more-->"、"<embed src=…>" 这样的字面文字直接显示给读者。',
    ' * 这里在正文进渲染器之前先归一化一次，规则与服务端 src/lib/legacy-html.ts 完全一致，',
    ' * 两侧必须同步修改，否则 SSR 与接管后渲染会分叉。',
    ' *   1) 代码块与行内代码整体保护，其中的尖括号是正文，不当 HTML 处理；',
    ' *   2) 去掉 HTML 注释（<!--more--> 等）；',
    ' *   3) 去掉已死的 Flash / Applet 元素与无意义标签；',
    ' *   4) 排版实体先还原（&nbsp; &hellip; …），正文里不再露出 "&nbsp;" 字样；',
    ' *   5) 剩余标签抽成占位符，渲染完原样放回（属性已消毒）；',
    ' *   6) 核心实体最后还原：此时文本里的 &lt;script&gt; 只会作为文字展示，',
    ' *      不会被当成真标签处理（&amp;nbsp; 这种双重编码也因此保持字面量）。 */',
    'var LEGACY_COMMENT = /<!--[\\s\\S]*?-->/g;',
    'var LEGACY_DROP_BLOCK = /<\\s*(script|style|applet|object)\\b[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>/gi;',
    'var LEGACY_DROP_BLOCK_SELF = /<\\s*(script|style|applet|object)\\b[^>]*\\/>/gi;',
    'var LEGACY_DROP_TAG = /<\\s*\\/?\\s*(embed|param|base|meta|link)\\b[^>]*>/gi;',
    'var LEGACY_TAG = /<\\/?[a-zA-Z][a-zA-Z0-9-]*(?:\\s[^<>]*?)?\\/?>/g;',
    'var LEGACY_UNCLOSED_DANGEROUS = /^<\\s*\\/?\\s*(script|style|applet|object)\\b/i;',
    'var LEGACY_EVENT_ATTR = /\\son[a-z]+\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)/gi;',
    'var LEGACY_SRCDOC_ATTR = /\\ssrcdoc\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)/gi;',
    'var LEGACY_BAD_URL_ATTR =',
    '  /((?:href|src|xlink:href|action|formaction|poster|background|data)\\s*=\\s*)(["\'])\\s*(?:javascript|vbscript|livescript|mocha|data\\s*:\\s*text\\/html)[^"\']*\\2/gi;',
    'var LEGACY_ENTITY = /&(#[xX][0-9a-fA-F]+|#\\d+|[a-zA-Z][a-zA-Z0-9]{1,9});/g;',
    'var LEGACY_ENTITIES = {',
    '  quot: \'"\', amp: \'&\', apos: "\'", lt: \'<\', gt: \'>\', nbsp: \' \', ensp: \' \', emsp: \' \', thinsp: \' \', shy: \'\',',
    '  zwnj: \'\', zwj: \'\', iexcl: \'!\', cent: \'¢\', pound: \'£\', curren: \'¤\', yen: \'¥\', brvbar: \'¦\', sect: \'§\',',
    '  uml: \'¨\', copy: \'©\', ordf: \'ª\', laquo: \'«\', not: \'¬\', reg: \'®\', macr: \'¯\', deg: \'°\', plusmn: \'±\',',
    '  sup2: \'²\', sup3: \'³\', acute: \'´\', micro: \'µ\', para: \'¶\', middot: \'·\', cedil: \'¸\', sup1: \'¹\',',
    '  ordm: \'º\', raquo: \'»\', frac14: \'¼\', frac12: \'½\', frac34: \'¾\', iquest: \'¿\', times: \'×\', divide: \'÷\',',
    '  ndash: \'–\', mdash: \'—\', lsquo: \'‘\', rsquo: \'’\', sbquo: \'‚\', ldquo: \'“\', rdquo: \'”\', bdquo: \'„\',',
    '  dagger: \'†\', Dagger: \'‡\', bull: \'•\', hellip: \'…\', permil: \'‰\', prime: \'′\', Prime: \'″\',',
    '  lsaquo: \'‹\', rsaquo: \'›\', oline: \'‾\', frasl: \'⁄\', euro: \'€\', trade: \'™\',',
    '  larr: \'←\', uarr: \'↑\', rarr: \'→\', darr: \'↓\', harr: \'↔\', infin: \'∞\', ne: \'≠\', le: \'≤\', ge: \'≥\',',
    '  asymp: \'≈\', equiv: \'≡\', sum: \'∑\', prod: \'∏\', part: \'∂\', nabla: \'∇\', isin: \'∈\', notin: \'∉\',',
    '  cap: \'∩\', cup: \'∪\', int: \'∫\', cong: \'≅\', sim: \'∼\', sube: \'⊆\', supe: \'⊇\', sub: \'⊂\', sup: \'⊃\',',
    '  oplus: \'⊕\', otimes: \'⊗\', perp: \'⊥\', sdot: \'⋅\', lceil: \'⌈\', rceil: \'⌉\', lfloor: \'⌊\', rfloor: \'⌋\',',
    '  loz: \'◊\', spades: \'♠\', clubs: \'♣\', hearts: \'♥\', diams: \'♦\',',
    '  alpha: \'α\', beta: \'β\', gamma: \'γ\', delta: \'δ\', epsilon: \'ε\', zeta: \'ζ\', eta: \'η\', theta: \'θ\',',
    '  iota: \'ι\', kappa: \'κ\', lambda: \'λ\', mu: \'μ\', nu: \'ν\', xi: \'ξ\', omicron: \'ο\', pi: \'π\', rho: \'ρ\',',
    '  sigma: \'σ\', tau: \'τ\', upsilon: \'υ\', phi: \'φ\', chi: \'χ\', psi: \'ψ\', omega: \'ω\',',
    '  Alpha: \'Α\', Beta: \'Β\', Gamma: \'Γ\', Delta: \'Δ\', Epsilon: \'Ε\', Zeta: \'Ζ\', Eta: \'Η\', Theta: \'Θ\',',
    '  Iota: \'Ι\', Kappa: \'Κ\', Lambda: \'Λ\', Mu: \'Μ\', Nu: \'Ν\', Xi: \'Ξ\', Omicron: \'Ο\', Pi: \'Π\', Rho: \'Ρ\',',
    '  Sigma: \'Σ\', Tau: \'Τ\', Upsilon: \'Υ\', Phi: \'Φ\', Chi: \'Χ\', Psi: \'Ψ\', Omega: \'Ω\'',
    '};',
    'var LEGACY_CORE_ENTITY_NAMES = { lt: 1, gt: 1, amp: 1, quot: 1, apos: 1 };',
    'var LEGACY_CORE_ENTITY_CODES = { 38: 1, 60: 1, 62: 1, 34: 1, 39: 1 };',
    '',
    '/** 标签属性消毒：事件处理器 / srcdoc / 可执行协议。 */',
    'function sanitizeLegacyTag(tag) {',
    '  return String(tag)',
    '    .replace(LEGACY_EVENT_ATTR, \'\')',
    '    .replace(LEGACY_SRCDOC_ATTR, \'\')',
    '    .replace(LEGACY_BAD_URL_ATTR, \'$1$2$2\');',
    '}',
    '',
    '/** 还原常见命名与数字实体；未知实体原样保留（最终由上层按文本转义）。',
    ' *  includeCore=false 时跳过 &lt; &gt; &amp; &quot; &apos;（及对应数字实体）。 */',
    'function decodeLegacyEntities(text, includeCore) {',
    '  if (includeCore === undefined) includeCore = true;',
    '  return String(text).replace(LEGACY_ENTITY, function (match, name) {',
    '    if (name.charAt(0) === \'#\') {',
    '      var code = (name.charAt(1) === \'x\' || name.charAt(1) === \'X\')',
    '        ? parseInt(name.slice(2), 16)',
    '        : parseInt(name.slice(1), 10);',
    '      if (!isFinite(code) || code <= 0 || code > 0x10ffff) return match;',
    '      if (!includeCore && LEGACY_CORE_ENTITY_CODES[code]) return match;',
    '      try { return String.fromCodePoint(code); } catch (e) { return match; }',
    '    }',
    '    var lower = name.toLowerCase();',
    '    if (!includeCore && LEGACY_CORE_ENTITY_NAMES[lower]) return match;',
    '    var hit = Object.prototype.hasOwnProperty.call(LEGACY_ENTITIES, name)',
    '      ? LEGACY_ENTITIES[name]',
    '      : (Object.prototype.hasOwnProperty.call(LEGACY_ENTITIES, lower) ? LEGACY_ENTITIES[lower] : undefined);',
    '    return hit === undefined ? match : hit;',
    '  });',
    '}',
    '',
    '/** 归一化旧正文的原始 HTML：返回 { text, restore }。 */',
    'function normalizeLegacyHtml(markdown) {',
    '  var stash = [];',
    '  var text = String(markdown == null ? \'\' : markdown);',
    '',
    '  var protect = function (re, keep) {',
    '    text = text.replace(re, function (m) {',
    '      stash.push(keep ? keep(m) : m);',
    '      return \'\\u0002\' + (stash.length - 1) + \'\\u0002\';',
    '    });',
    '  };',
    '',
    '  // 1) 代码块与行内代码：整段保护，渲染后原样放回',
    '  protect(/```[\\s\\S]*?(?:```|$)/g);',
    '  protect(/`[^`\\n]*`/g);',
    '  // 2) 注释',
    '  text = text.replace(LEGACY_COMMENT, \'\');',
    '  // 3) 死元素',
    '  text = text.replace(LEGACY_DROP_BLOCK, \'\')',
    '    .replace(LEGACY_DROP_BLOCK_SELF, \'\')',
    '    .replace(LEGACY_DROP_TAG, \'\');',
    '  // 4) 排版实体先还原（&nbsp; &hellip; …）',
    '  text = decodeLegacyEntities(text, false);',
    '  // 5) 剩余标签抽成占位符（属性消毒后保存）',
    '  protect(LEGACY_TAG, function (tag) {',
    '    return LEGACY_UNCLOSED_DANGEROUS.test(tag) ? \'\' : sanitizeLegacyTag(tag);',
    '  });',
    '  // 6) 核心实体最后还原',
    '  text = decodeLegacyEntities(text, true);',
    '',
    '  return {',
    '    text: text,',
    '    restore: function (html) {',
    '      return String(html == null ? \'\' : html).replace(/\\u0002(\\d+)\\u0002/g, function (m, idx) {',
    '        var hit = stash[Number(idx)];',
    '        return hit === undefined ? \'\' : hit;',
    '      });',
    '    }',
    '  };',
    '}',
  ].join(nl) + nl;

  const head = 'function renderMarkdown(md) {' + nl + "  var src = String(md || '');";
  const tail = '  return html;' + nl + '}' + nl + nl + 'function escSmoji(';
  if (!app.includes(head)) throw new Error('旧正文 HTML 归一化：未找到 renderMarkdown() 头部锚点');
  if (!app.includes(tail)) throw new Error('旧正文 HTML 归一化：未找到 renderMarkdown() 尾部锚点');

  let out = app.replace(head, () => helper +
    'function renderMarkdown(md) {' + nl +
    '  var legacy = normalizeLegacyHtml(md);' + nl +
    '  var src = legacy.text;');
  out = out.replace(tail, () =>
    '  return legacy.restore(html);' + nl + '}' + nl + nl + 'function escSmoji(');

  report.push('[ok]   旧正文 HTML 归一化（&nbsp; 实体 / <!--more--> / 失效 Flash 播放器，前后端同规则）');
  return out;
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
app = patchImageProxy(app);
app = patchLegacyHtmlNormalization(app);
app = patchThumbPlaceholder(app);
patchThumbPlaceholderCss();
write('app.js', app);
normalizeIndexVersions();
ensurePolishShell();
patchCriticalCss();
patchReadingScalePreset();
patchImageWatchdog();
patchSwCacheStrategy();
patchMusicPlayerToggle();
patchMusicToggleCss();
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
/* 无封面时的占位缩略图：不再是一个灰色图片图标，而是一张「渐变 + 标题 + 摘要」的
 * 彩色卡片（同一篇文章颜色固定，由 id 派生），卡片右侧不会留空白。
 * ⚠️ 必须与 src/ssr/list.ts 的 postThumbPlaceholder() 保持同样的规则：
 *    两边不一致会让 SSR 与接管后渲染出两个不同的缩略图。tests/frontend-split.test.ts 有断言。
 * 幂等：已有 postThumbPlaceholder() 就跳过。 */
function patchThumbPlaceholder(app) {
  if (app.includes('function postThumbPlaceholder(')) {
    report.push('[skip] 渐变文字缩略图已存在');
    return app;
  }

  const nl = app.includes('\r\n') ? '\r\n' : '\n';
  const helper = [
    "/** 无封面时的占位缩略图：按文章 id 派生的双色渐变 + 标题 + 首标签/摘要。",
    " *  与服务端 src/ssr/list.ts 的 postThumbPlaceholder() 同构，两侧必须同步。 */",
    "function postThumbPlaceholder(p) {",
    "  var title = String((p && p.title) || '');",
    "  var seed = String((p && (p.id || p.slug)) || title);",
    "  var h = 0, i;",
    "  for (i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;",
    "  var h2 = (h + 34) % 360;",
    "  var sub = '', tags = p && p.tags;",
    "  if (Object.prototype.toString.call(tags) === '[object Array]' && tags.length) sub = String(tags[0] || '');",
    "  else if (typeof tags === 'string') sub = tags.split(',')[0] || '';",
    "  if (!sub) sub = String((p && p.excerpt) || '');",
    "  sub = sub.replace(/<[^>]*>/g, '').replace(/\\s+/g, ' ').trim();",
    "  if (sub.length > 40) sub = sub.slice(0, 40) + '\\u2026';",
    "  var style = '--ph-a:hsl(' + h + ',58%,46%);--ph-b:hsl(' + h2 + ',54%,36%)';",
    "  return '<span class=\"post-thumb ph\" style=\"' + style + '\">' +",
    "    '<span class=\"post-thumb-ph-orb\" aria-hidden=\"true\"></span>' +",
    "    '<span class=\"post-thumb-ph-txt\"><b>' + esc(title) + '</b>' +",
    "    (sub ? '<i>' + esc(sub) + '</i>' : '') +",
    "    '</span></span>';",
    "}",
  ].join(nl) + nl;

  const anchor = 'function renderPostThumb(p, idx) {';
  if (!app.includes(anchor)) throw new Error('渐变文字缩略图：未找到 renderPostThumb()');
  let out = app.replace(anchor, () => helper + anchor);

  const oldPh = "return '<span class=\"post-thumb ph\"><span class=\"post-thumb-ph\">' + svgIcon('image', 26) + '</span></span>';";
  if (!out.includes(oldPh)) throw new Error('渐变文字缩略图：未找到旧占位分支');
  out = out.split(oldPh).join("return postThumbPlaceholder(p);");

  report.push('[ok]   无封面时的渐变文字缩略图（标题 + 摘要，前后端同规则）');
  return out;
}

/* polish.css 追加渐变缩略图样式（幂等：按标记注释整块替换） */
function patchThumbPlaceholderCss() {
  const marker = 'qingyu:thumb-placeholder';
  let css = read('polish.css');
  if (css.includes(marker)) {
    report.push('[skip] 渐变缩略图样式已存在');
    return;
  }
  const nl = css.includes('\r\n') ? '\r\n' : '\n';
  const block = [
    "/* ---------- qingyu:thumb-placeholder 无封面占位缩略图 ---------- */",
    ".post-thumb.ph{display:flex;align-items:flex-end;position:relative;overflow:hidden;background:linear-gradient(140deg,var(--ph-a,#5b7cfa),var(--ph-b,#33407a))}",
    ".post-thumb-ph-orb{position:absolute;right:-16%;top:-26%;width:76%;padding-top:76%;border-radius:50%;background:rgba(255,255,255,.14);pointer-events:none}",
    ".post-thumb-ph-txt{position:relative;z-index:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:16px 18px}",
    ".post-thumb-ph-txt b{color:#fff;font-size:15.5px;font-weight:600;line-height:1.38;letter-spacing:.01em;text-shadow:0 1px 2px rgba(0,0,0,.2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".post-thumb-ph-txt i{color:rgba(255,255,255,.82);font-size:11.5px;font-style:normal;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    "@media (max-width:768px){.post-thumb-ph-txt{padding:12px 14px}}",
  ].join(nl);
  write('polish.css', css.replace(/\s*$/, '') + nl + nl + block + nl);
  report.push('polish.css -> 无封面占位缩略图样式');
}

/* 音乐播放器开关：读者可以在面板里一键关闭悬浮播放器（默认开启）。
 * 偏好记在 localStorage（qy.music.enabled）；关掉后悬浮按钮不再出现、正在播放的
 * 音频立即暂停，但播放列表与音量设置都保留，随时可以再打开。
 * 幂等：已有 qy.music.enabled 就跳过。 */
function patchMusicPlayerToggle() {
  let mp = read('music-player.js');
  if (mp.includes('qy.music.enabled')) {
    report.push('[skip] 音乐播放器开关已存在');
    return;
  }

  const nl = mp.includes('\r\n') ? '\r\n' : '\n';
  const helper = [
    "  var ENABLED_KEY = 'qy.music.enabled';",
    "  function playerEnabled() {",
    "    try { return localStorage.getItem(ENABLED_KEY) !== '0'; } catch (e) { return true; }",
    "  }",
    "  function setPlayerEnabled(on) {",
    "    try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch (e) {}",
    "    var btn = document.getElementById('mpPower');",
    "    if (btn) {",
    "      btn.classList.toggle('mp-power-off', !on);",
    "      btn.setAttribute('aria-pressed', on ? 'true' : 'false');",
    "      btn.title = on ? tt('player.disable') : tt('player.enable');",
    "    }",
    "    if (on) {",
    "      show();",
    "    } else {",
    "      closePanel();",
    "      try { audio.pause(); } catch (e) {}",
    "      playing = false;",
    "    }",
    "  }",
  ].join(nl);

  const varAnchor = '  var retractTimer = null;';
  if (!mp.includes(varAnchor)) throw new Error('音乐播放器开关：未找到 retractTimer 锚点');
  mp = mp.replace(varAnchor, () => varAnchor + nl + helper);

  const iconSvg = "<svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 4v8\"/><path d=\"M6.5 7.5a8 8 0 1 0 11 0\"/></svg>";
  const btnAnchor = '<button type="button" class="mp-btn mp-close" id="mpPanelClose"';
  if (!mp.includes(btnAnchor)) throw new Error('音乐播放器开关：未找到面板关闭按钮锚点');
  const btnHtml = '<button type="button" class="mp-btn mp-power" id="mpPower" aria-pressed="true" title="\' + esc(tt("player.disable")) + \'">' + iconSvg + '</button>' + btnAnchor;
  mp = mp.split(btnAnchor).join(btnHtml);

  const bindAnchor = "document.getElementById('mpPanelClose').addEventListener('click', closePanel);";
  if (!mp.includes(bindAnchor)) throw new Error('音乐播放器开关：未找到事件绑定锚点');
  mp = mp.replace(bindAnchor, () => bindAnchor + nl + "document.getElementById('mpPower').addEventListener('click', function () { setPlayerEnabled(!playerEnabled()); });");

  const showAnchor = "  function show() {" + nl + "    if (visible) return;";
  if (!mp.includes(showAnchor)) throw new Error('音乐播放器开关：未找到 show() 锚点');
  mp = mp.replace(showAnchor, () => showAnchor + nl + "    if (!playerEnabled()) return;");

  write('music-player.js', mp);
  report.push('[ok]   音乐播放器开关（面板内一键关闭，记忆到本地）');
}
/* polish.css 追加播放器开关按钮样式（幂等：按标记注释整块替换） */
function patchMusicToggleCss() {
  const marker = 'qingyu:music-toggle';
  let css = read('polish.css');
  if (css.includes(marker)) {
    report.push('[skip] 播放器开关样式已存在');
    return;
  }
  const nl = css.includes('\r\n') ? '\r\n' : '\n';
  const block = [
    "/* ---------- qingyu:music-toggle 播放器开关按钮 ---------- */",
    ".mp-power{color:var(--muted)}",
    ".mp-power:hover{color:var(--accent)}",
    ".mp-power-off{color:var(--accent)}",
    ".mp-power-off .mp-power-ring{opacity:.35}",
  ].join(nl);
  write('polish.css', css.replace(/\s*$/, '') + nl + nl + block + nl);
  report.push('polish.css -> 播放器开关按钮样式');
}

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
