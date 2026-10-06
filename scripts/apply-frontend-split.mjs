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
patchShellReferences();

console.log(report.join('\n'));
