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

  function schedule() {
    // 不再等首次交互 / 空闲回调：
    // SSR 页面已经画出内容，若把 app.min.js 拖到空闲期（实测 1~2.5s）才接管，
    // 用户会看到「先看到内容 → 页面又整体重渲染 / 重新拉一次数据」，
    // 手机端尤其明显（此时已经在读第一屏）。
    // 本脚本是 defer，不阻塞 HTML 解析与首屏绘制，因此立即加载是安全的。
    loadApp();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  } else {
    schedule();
  }
})();
