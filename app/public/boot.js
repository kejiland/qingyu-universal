/* ============================================================
 * 公开站启动器（约 1 KB）
 * ------------------------------------------------------------
 * 之前 index.html 直接加载整包 app.min.js（约 180 KB），
 * 现在服务端已 SSR 的页面先展示内容，再在空闲时机增强；
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
    if (/^\/posts\/[^/]+\/edit\/?$/.test(p)) return true;
    var root = document.getElementById('app');
    // SSR 页面已经有正文；只有仍是启动动画时才需要立刻接管。
    return !root || !!root.querySelector('.boot-load');
  }

  function schedule() {
    if (isImmediate()) { loadApp(); return; }
    // 用户先交互时立刻增强，空闲时兜底加载；一次性监听避免重复注入。
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
