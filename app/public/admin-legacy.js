/* ============================================================
 * 旧版后台回退分包（仅在新版 /admin 包缺失或加载失败时按需加载）
 * ------------------------------------------------------------
 * 由 app.js 的 ensureLegacyAdmin() 动态注入；本文件是经典脚本，
 * 顶层函数会挂到全局，与 app.js 共享同一套工具函数。
 * ============================================================ */
/* ---------- 管理后台辅助函数 ---------- */
function adminRoute() {
  var path = currentRoute().path;
  if (path === '/write' || path === '/admin' || path === '/admin/write') return 'write';
  if (path === '/admin/posts') return 'posts';
  if (/^\/admin\/posts\/[^\/]+\/edit$/.test(path)) return 'edit';
  return 'write';
}

function getEditIdFromRoute() {
  var path = currentRoute().path;
  var match = path.match(/^\/admin\/posts\/([^\/]+)\/edit$/);
  if (!match) return null;
  // location.pathname 对中文/特殊字符 id 是百分号编码形式，必须解码后
  // 才能与 window.BLOG_POSTS 里的原始 id 匹配、并避免 apiFetch 二次编码 404
  try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
}

function renderAdminSidebar(active) {
  var postCount = (getStaticPosts() || []).length;
  var isEdit = active === 'edit';
  return '<aside class="admin-sidebar">'
    + '<div class="admin-sidebar-brand">'
    + '<span class="admin-brand-badge">' + svgIcon('pen', 15) + '</span>'
    + '<span class="admin-brand-text">' + t('admin.brand') + '<span class="admin-sidebar-ver">v' + esc(BLOG_VERSION) + '</span></span>'
    + '</div>'
    + '<nav class="admin-sidebar-nav">'
    + '<div class="admin-nav-group">' + svgIcon('doc', 12) + ' ' + t('admin.nav.content') + '</div>'
    + '<a href="' + esc(href('/admin/posts')) + '" class="admin-nav-item' + (active === 'posts' || isEdit ? ' active' : '') + '">' + svgIcon('doc', 15) + '<span>' + t('admin.sidebar.allPosts') + '</span><span class="admin-nav-count">' + postCount + '</span></a>'
    + '<div class="admin-nav-group">' + svgIcon('pen', 12) + ' ' + t('admin.nav.write') + '</div>'
    + '<a href="' + esc(href('/admin/write')) + '" class="admin-nav-item' + (active === 'write' ? ' active' : '') + '">' + svgIcon('pen', 15) + '<span>' + t('editor.title') + '</span></a>'
    + '</nav>'
    + '<div class="admin-sidebar-footer">'
    + '<div class="admin-sidebar-mode">' + (_cloudOn() ? svgIcon('cloud', 12) + ' ' + t('editor.cloudMode') : svgIcon('file', 12) + ' ' + t('editor.localMode')) + '</div>'
    + '<button class="btn btn-ghost btn-logout" id="btnLogoutSidebar">' + svgIcon('logout', 14) + ' ' + t('admin.sidebar.logout') + '</button>'
    + '</div>'
    + '</aside>';
}

function renderPostList() {
  var posts = getStaticPosts();
  if (!posts || !posts.length) {
    return '<div class="admin-posts-header">'
      + '<div class="admin-head-titles"><h2>' + svgIcon('doc', 20) + ' ' + t('admin.postList.title') + '</h2><p class="admin-head-sub">' + t('admin.postList.emptyHint') + ' <a href="' + esc(href('/admin/write')) + '">' + t('editor.newPost') + '</a></p></div>'
      + '</div>';
  }
  var pinnedCount = posts.filter(function (p) { return p.pinned; }).length;
  var html = '<div class="admin-posts-header">'
    + '<div class="admin-head-titles"><h2>' + svgIcon('doc', 20) + ' ' + t('admin.postList.title') + '</h2><p class="admin-head-sub">' + t('admin.postList.desc') + '</p></div>'
    + '<a class="btn btn-primary btn-new-post" href="' + esc(href('/admin/write')) + '">' + svgIcon('pen', 14) + ' ' + t('editor.newPost') + '</a>'
    + '</div>';
  html += aiCommentsSlotHTML();
  html += '<div class="admin-stats">'
    + '<div class="admin-stat"><span class="admin-stat-num">' + posts.length + '</span><span class="admin-stat-label">' + t('admin.postList.allStatus') + '</span></div>'
    + '<div class="admin-stat"><span class="admin-stat-num">' + pinnedCount + '</span><span class="admin-stat-label">' + t('admin.postList.pin') + '</span></div>'
    + '</div>';
  html += '<table class="admin-posts-table"><thead><tr><th>' + t('admin.postList.colTitle') + '</th><th>' + t('admin.postList.colDate') + '</th><th>' + t('admin.postList.colStatus') + '</th><th>' + t('admin.postList.colActions') + '</th></tr></thead><tbody>';
  posts.forEach(function (p) {
    var status = p.pinned ? svgIcon('pin', 12) + ' ' + t('admin.postList.pin') : t('post.published');
    var title = p.title || t('admin.postList.noTitle');
    html += '<tr>'
      + '<td class="post-title-cell"><a class="post-title-link" href="' + esc(href('/admin/posts/' + encodeURIComponent(p.id) + '/edit')) + '">' + esc(title) + svgIcon('external', 12) + '</a></td>'
      + '<td class="post-date-cell">' + esc(p.date || '') + '</td>'
      + '<td><span class="status-badge' + (p.pinned ? ' pinned' : '') + '">' + status + '</span></td>'
      + '<td><div class="post-actions">'
      + '<a href="' + esc(href('/admin/posts/' + encodeURIComponent(p.id) + '/edit')) + '" class="btn btn-sm">' + svgIcon('pen', 13) + ' ' + t('admin.postList.edit') + '</a>'
      + '<button class="btn btn-sm' + (p.pinned ? ' btn-on' : '') + '" data-pin-id="' + esc(p.id) + '" title="' + (p.pinned ? t('admin.postList.unpin') : t('admin.postList.pin')) + '">' + svgIcon('pin', 13) + ' ' + (p.pinned ? t('admin.postList.unpin') : t('admin.postList.pin')) + '</button>'
      + '<button class="btn btn-sm btn-danger" data-post-id="' + esc(p.id) + '" data-post-title="' + esc(title) + '">' + svgIcon('trash', 13) + ' ' + t('post.delete') + '</button>'
      + '</div></td>'
      + '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

/* ---------- 文章列表：置顶 ---------- */

/** 从本地列表取文章对象（含完整数据） */
function findPostForUpdate(id) {
  var arr = Array.isArray(window.BLOG_POSTS) ? window.BLOG_POSTS : [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] && arr[i].id === id) return arr[i];
  }
  return null;
}

/** 云端：拉取文章详情（列表摘要不含 content/enc） */
async function fetchPostDetail(id) {
  var data = await apiFetch('api/posts/' + encodeURIComponent(id));
  return (data && data.post) ? data.post : null;
}

/** 云端：PUT 更新单篇。必须带全字段，否则 PUT 会以缺省值覆盖内容/密文/标签 */
async function savePostToCloud(post) {
  var body = {
    id: post.id,
    title: post.title || '',
    date: post.date || '',
    excerpt: post.excerpt || '',
    cover: post.cover || '',
    tags: Array.isArray(post.tags) ? post.tags : [],
    pinned: !!post.pinned,
    content: post.content || ''
  };
  await apiFetch('api/posts/' + encodeURIComponent(post.id), { method: 'PUT', body: JSON.stringify(body) });
}

/** 更新本地列表项；静态模式导出新 posts.js 供覆盖发布 */
function upsertLocalPost(post, exportStatic) {
  var arr = (Array.isArray(window.BLOG_POSTS) ? window.BLOG_POSTS : []).slice();
  var idx = arr.findIndex(function (p) { return p && p.id === post.id; });
  if (idx >= 0) arr[idx] = post; else arr.push(post);
  window.BLOG_POSTS = arr;
  if (exportStatic) {
    var blob = new Blob(['window.BLOG_POSTS=' + JSON.stringify(arr, null, 2) + ';'], { type: 'application/javascript' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'posts.js';
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 3000);
  }
}

/** 列表页：切换置顶（云端 PUT / 静态改本地并导出） */
async function togglePinFromList(id) {
  var post = findPostForUpdate(id);
  if (!post) { alert(t('toast.notFound')); return; }
  var target = !post.pinned;
  try {
    if (_cloudOn()) {
      var full = await fetchPostDetail(id);   // 以云端详情为准（含最新内容/密文）
      if (full) post = full;
    }
  } catch (e) {
    alert(t('toast.networkError'));
    return;
  }
  post.pinned = target;
  if (_cloudOn()) {
    try {
      await savePostToCloud(post);
      upsertLocalPost(post, false);
      alert(target ? t('toast.pinnedCloud') : t('toast.unpinnedCloud'));
    } catch (e) {
      alert(t('toast.networkError'));
      return;
    }
  } else {
    upsertLocalPost(post, true);
    alert(target ? t('toast.pinnedLocal') : t('toast.unpinnedLocal'));
  }
  route();
}




function renderEditorBody() {
  var _editId = currentEditId();
  var _editPost = _editId ? getStaticPosts().find(function (p) { return p.id === _editId; }) : null;
  // 如果路由是编辑模式，使用路由中的 ID 覆盖
  if (adminRoute() === 'edit') {
    var routeId = getEditIdFromRoute();
    if (routeId) {
      _editId = routeId;
      _editPost = getStaticPosts().find(function (p) { return p.id === _editId; });
    }
  }
  var body = '';
  body += '<div class="write-head">'
    + '<h2 class="page-title wh-title">' + svgIcon('pen', 20) + ' ' + t('editor.title') + '</h2>'
    + (_cloudOn()
        ? '<span class="mode-chip cloud">' + svgIcon('cloud', 12) + ' ' + t('editor.cloudMode') + '</span>'
        : '<span class="mode-chip local">' + svgIcon('file', 12) + ' ' + t('editor.localMode') + '</span>')
    + (_editId ? '<span class="mode-chip editing" id="writeTitleHint">' + (_editPost ? esc(t('editor.editing') + '：' + (_editPost.title || '')) : t('editor.newPost')) + '</span>' : '')
    + '</div>';
  body += '<div class="card editor-meta"><div class="editor-grid">'
    + '<div class="field field-full"><label>' + t('editor.titlePlaceholder') + '</label><input type="text" id="titleInput" placeholder="' + t('editor.titlePlaceholder') + '"></div>'
    + '<div class="field"><label>' + t('editor.datePlaceholder') + '</label><div style="display:flex;gap:8px;align-items:center;"><input type="datetime-local" id="dateInput" style="flex:1;"><button class="btn btn-sm btn-ghost" id="btnToday" title="' + t('editor.setNow') + '" style="flex-shrink:0;padding:5px 10px;font-size:12px;">' + t('editor.today') + '</button></div></div>'
    + '<div class="field"><label>' + t('editor.tagsPlaceholder') + '</label><input type="text" id="tagInput" placeholder="' + t('editor.tagsExample') + '"></div>'
    + '<div class="field field-full"><label>' + t('editor.excerptPlaceholder') + '</label><input type="text" id="excerptInput" placeholder="' + t('editor.excerptHint') + '"></div>'
    + '<div class="field field-full"><label>' + t('editor.coverPlaceholder') + '</label><input type="text" id="coverInput" placeholder="' + t('editor.coverHint') + '"></div>'
    + '<div class="field check-label"><label><input type="checkbox" id="pinnedInput"> ' + svgIcon('pin', 13) + ' ' + t('editor.pin') + '</label></div>'
    + '</div></div>';
  body += aiAssistSlotHTML();
  body += '<div class="editor-wrap">'
    + '<section class="editor-pane"><div class="pane-head">' + svgIcon('pen', 13) + ' ' + t('editor.editing') + '<span class="pane-note">Markdown</span></div><div id="toolbar" class="toolbar">' + toolbarHtml() + '</div><textarea id="mdInput" class="md-input" rows="18" placeholder="' + t('editor.writeHint') + '"></textarea></section>'
    + '<section class="editor-pane preview-pane"><div class="pane-head">' + svgIcon('eye', 13) + ' ' + t('editor.preview') + '<span class="pane-note">' + t('editor.realtimeRender') + '</span></div><div class="write-preview article preview-body" id="previewPane"></div></section>'
    + '</div>';
  body += '<div class="editor-actions actions-bar">'
    + (_cloudOn() ? '<button class="btn btn-primary" id="btnCloud">' + svgIcon('cloud', 15) + ' ' + t('editor.cloudPublish') + '</button>' : '')
    + '<button class="btn btn-primary" id="btnSave">' + svgIcon('save', 15) + ' ' + t('editor.savePost') + '</button>'
    + '<span class="action-sep"></span>'
    + '<button class="btn" id="btnSaveDraft">' + svgIcon('upload', 15) + ' ' + t('editor.saveDraft') + '</button>'
    + '<button class="btn" id="btnImport">' + svgIcon('file', 15) + ' ' + t('editor.importMd') + '</button>'
    + '<input type="file" id="mdFileInput" accept=".md,.markdown" hidden>'
    + '<button class="btn" id="btnOpenMdEditor">' + svgIcon('external', 15) + ' ' + t('editor.officialEditor') + '</button>'
    + '<span class="action-sep"></span>'
    + '<button class="btn" id="btnExport">' + svgIcon('download', 15) + ' ' + t('editor.exportPosts') + '</button>'
    + '<button class="btn" id="btnExportAll" title="' + t('editor.exportAllTitle') + '">' + svgIcon('save', 15) + ' ' + t('editor.exportAll') + '</button>'
    + '<button class="btn" id="btnRss">' + svgIcon('rss', 15) + ' RSS</button>'
    + '<button class="btn" id="btnSitemap">' + svgIcon('sitemap', 15) + ' Sitemap</button>'
    + '<span class="actions-right"><span class="word-count" id="wordCount"></span><span class="save-status" id="saveStatus"></span>'
    + '<button class="btn btn-outline-danger btn-logout" id="btnClearData" title="' + t('editor.clearDataTitle') + '">' + svgIcon('trash', 14) + ' ' + t('editor.cleanData') + '</button>'
    + '<button class="btn btn-ghost btn-logout" id="btnLogout">' + svgIcon('logout', 15) + ' ' + t('editor.exitLogin') + '</button></span>'
    + '</div>';
  body += '<p class="keys-hint"><kbd>Ctrl</kbd>+<kbd>S</kbd> ' + t('editor.saveDraft') + ' · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ' + t('editor.savePost') + '</p>';
  body += '<h3 class="draft-hint"><b>' + t('editor.exportAll') + ':</b> ' + t('editor.exportHint') + '</h3>';
  return body;
}

function renderWrite() {
  var html = renderNav(currentRoute().path);
  html += '<main class="container page-fade write-page">';
  if (!adminOk()) {
    if (_cloudOn()) {
      // 云端模式：密码校验于 Cloudflare D1 后端，此页只做登录（token 已存则直接进入编辑）。
      // 首次部署：登录框下方提供「安装密钥初始化」入口（后端 BLOG_ADMIN_SETUP_KEY 必填）。
      html += '<div class="card gate-card">'
        + '<div class="gate-badge">' + svgIcon('lock', 26) + '</div>'
        + '<h3 class="gate-title">' + t('admin.login') + '</h3>'
        + '<p class="gate-sub">' + t('admin.loginHint') + '</p>'
        + '<div class="gate-form"><input type="password" id="gatePwd" placeholder="' + t('admin.pwdLabel') + '" autocomplete="current-password"><button class="btn btn-primary" id="btnGate">' + svgIcon('logout', 15) + ' ' + t('admin.loginBtn') + '</button></div>'
        + '<div class="gate-msg alert-strip" id="gateMsg"></div>'
        + '<button type="button" class="gate-link" id="btnCloudSetup">' + t('admin.gotoCloudSetup') + '</button>'
        + '<div class="gate-form" id="gateSetupForm" style="display:none">'
        + '<input type="password" id="setupKey" placeholder="' + t('admin.setupKeyLabel') + '" autocomplete="off">'
        + '<input type="password" id="setupPwd2" placeholder="' + t('admin.pwdLabel') + '" autocomplete="new-password">'
        + '<button class="btn btn-primary" id="btnCloudSetupGo">' + t('admin.setupBtn') + '</button>'
        + '<button type="button" class="gate-link" id="btnCloudSetupBack">' + t('admin.backToLogin') + '</button>'
        + '</div>'
        + '<div class="gate-foot"><a href="' + esc(href('/')) + '">' + t('admin.backHome') + '</a></div>'
        + '</div>';
    } else if (needAdminSetup()) {
      html += '<div class="card gate-card">'
        + '<div class="gate-badge">' + svgIcon('lock', 26) + '</div>'
        + '<h3 class="gate-title">' + t('admin.setupPwd') + '</h3>'
        + '<p class="gate-sub">' + t('admin.setupHint') + '</p>'
        + '<div class="gate-form"><input type="password" id="setupPwd" placeholder="' + t('admin.pwdLabel') + '" autocomplete="new-password"><button class="btn btn-primary" id="btnSetup">' + t('admin.setupBtn') + '</button></div>'
        + '<div class="gate-msg alert-strip" id="gateMsg"></div>'
        + '</div>';
    } else {
      html += '<div class="card gate-card">'
        + '<div class="gate-badge">' + svgIcon('lock', 26) + '</div>'
        + '<h3 class="gate-title">' + t('admin.loginTitle') + '</h3>'
        + '<p class="gate-sub">' + t('admin.loginDesc') + '</p>'
        + '<div class="gate-form"><input type="password" id="gatePwd" placeholder="' + t('admin.pwdLabel') + '" autocomplete="current-password"><button class="btn btn-primary" id="btnGate">' + t('admin.enterBtn') + '</button></div>'
        + '<div class="gate-msg alert-strip" id="gateMsg"></div>'
        + '<div class="gate-foot"><a href="' + esc(href('/')) + '">' + t('admin.backHome') + '</a></div>'
        + '<p class="gate-hint">' + t('admin.hint') + '</p>'
        + '</div>';
    }
    html += '</main>' + renderFooter();
    app().innerHTML = html;
    var btnSetup = document.querySelector('#btnSetup');
    if (btnSetup) btnSetup.addEventListener('click', async function () {
      var inp = document.querySelector('#setupPwd');
      var msg = document.querySelector('#gateMsg');
      if (!inp) return;
      if (await setupAdmin(inp.value)) { route(); }
      else if (msg) msg.textContent = t('admin.pwdTooShort');
    });
    var btnGate = document.querySelector('#btnGate');
    if (btnGate) btnGate.addEventListener('click', async function () {
      var inp = document.querySelector('#gatePwd');
      var msg = document.querySelector('#gateMsg');
      if (!inp || !inp.value) { if (msg) msg.textContent = t('admin.pwdRequired'); return; }
      if (_cloudOn()) {
        // 加载态：防重复提交，spinner 反馈
        var orig = btnGate.innerHTML;
        btnGate.disabled = true;
        btnGate.innerHTML = svgIcon('spinner', 14) + ' ' + t('admin.logging');
        cloudLogin(inp.value).then(function (r) {
          btnGate.disabled = false;
          btnGate.innerHTML = orig;
          if (r.ok) {
            if (r.mustChange) {
              // 首次部署自动初始化：弹出清晰的默认密码提示框，供查看/复制后改密（不再一闪而过）
              window.showFirstLoginPwd(r.defaultPassword || '');
            } else {
              route();
            }
          }
          else {
            if (msg) msg.textContent = r.message || t('admin.wrongPwd');
            try { inp.focus(); inp.select(); } catch (e2) {}
          }
        });
      } else if (await tryAdmin(inp.value)) { route(); }
      else if (msg) msg.textContent = t('admin.wrongPwd');
    });
    // 回车即提交 + 自动聚焦密码框
    [['#setupPwd', '#btnSetup'], ['#gatePwd', '#btnGate'], ['#setupPwd2', '#btnCloudSetupGo'], ['#setupKey', '#btnCloudSetupGo']].forEach(function (pair) {
      var inp = document.querySelector(pair[0]);
      var btn = document.querySelector(pair[1]);
      if (inp && btn) {
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); btn.click(); }
        });
        try { inp.focus(); } catch (e) {}
      }
    });
    // 云端首次部署：登录 ↔ 安装密钥初始化 切换
    var cloudSetupBtn = document.querySelector('#btnCloudSetup');
    var cloudSetupForm = document.querySelector('#gateSetupForm');
    var cloudSetupBack = document.querySelector('#btnCloudSetupBack');
    var gateMsg = document.querySelector('#gateMsg');
    function cloudToggleSetup(show) {
      if (!cloudSetupForm) return;
      cloudSetupForm.style.display = show ? 'block' : 'none';
      var loginForm = cloudSetupForm.parentNode && cloudSetupForm.parentNode.querySelector('#gatePwd');
      if (show) {
        if (cloudSetupBtn) cloudSetupBtn.style.display = 'none';
        var k = document.querySelector('#setupKey');
        if (k) { try { k.focus(); } catch (e) {} }
      } else {
        if (cloudSetupBtn) cloudSetupBtn.style.display = '';
        if (loginForm) { try { loginForm.focus(); } catch (e) {} }
      }
      if (gateMsg) gateMsg.textContent = '';
    }
    if (cloudSetupBtn) cloudSetupBtn.addEventListener('click', function () { cloudToggleSetup(true); });
    if (cloudSetupBack) cloudSetupBack.addEventListener('click', function () { cloudToggleSetup(false); });
    var cloudSetupGo = document.querySelector('#btnCloudSetupGo');
    if (cloudSetupGo) cloudSetupGo.addEventListener('click', async function () {
      var k = document.querySelector('#setupKey');
      var p = document.querySelector('#setupPwd2');
      var m = document.querySelector('#gateMsg');
      var pwd = p ? p.value : '';
      var key = k ? k.value : '';
      if (!pwd) { if (m) m.textContent = t('admin.pwdRequired'); return; }
      if (!key) { if (m) m.textContent = t('admin.pwdRequired'); return; }  // 复用：提示必填
      var orig = cloudSetupGo.innerHTML;
      cloudSetupGo.disabled = true;
      cloudSetupGo.innerHTML = svgIcon('spinner', 14) + ' ' + t('admin.logging');
      var r = await cloudSetupAdmin(pwd, key);
      cloudSetupGo.disabled = false;
      cloudSetupGo.innerHTML = orig;
      if (r && r.ok) { route(); }
      else if (m) m.textContent = (r && r.message) || t('admin.wrongPwd');
    });
    return;
  }
  var _editId = currentEditId();
  var _editPost = _editId ? getStaticPosts().find(function (p) { return p.id === _editId; }) : null;
  // 顶栏：页面标题 + 模式徽章 + 编辑状态，层次一目了然
  // 复用 renderEditorBody（与 /admin 后台编辑器同源，避免两份模板漂移）
  html += renderEditorBody();
  html += '</main>' + renderFooter();
  app().innerHTML = html;

  var editId = currentEditId();
  if (editId) {
    var post = getStaticPosts().find(function (p) { return p.id === editId; });
    if (post) {
      var title = document.querySelector('#titleInput'); if (title) title.value = post.title || '';
      var date = document.querySelector('#dateInput'); if (date) date.value = toDateTimeLocal(post.date || '');
      var tags = document.querySelector('#tagInput'); if (tags) tags.value = (post.tags || []).join(', ');
      var excerpt = document.querySelector('#excerptInput'); if (excerpt) excerpt.value = post.excerpt || '';
      var cover = document.querySelector('#coverInput'); if (cover) cover.value = post.cover || '';
      var pin = document.querySelector('#pinnedInput'); if (pin) pin.checked = !!post.pinned;
      var md = document.querySelector('#mdInput');
      if (md) {
        if (_cloudOn()) {
          // 云端模式：始终以云端最新正文为准（本地静态旧正文不算数），先占位再由 loadEditContent 拉取覆盖
          md.value = '';
          md.placeholder = t('editor.loadingCloud');
        } else {
          md.value = post.content || '';
        }
      }
      var st = document.querySelector('#saveStatus'); if (st) st.textContent = t('editor.editingStatus') + (post.title || '');
      // also update page title for tests
      var hTitle = document.querySelector('#writeTitleHint'); if (hTitle) hTitle.textContent = t('editor.editingStatus') + (post.title || '');
      // 云端正文拉取由 loadEditContent 内部触发预览；本地内容由下方统一 updatePreview() 渲染
      loadEditContent(post, editId);
    }
  }
  // else：新建文章 —— 保持干净的空白页，不自动恢复历史草稿/上次发布内容
  updatePreview();
  bindWriteEvents();
}
function toolbarHtml() {
  var html = ['bold', 'italic', 'code', 'h2', 'link', 'img', 'quote', 'ul', 'ol', 'fence'].map(function (cmd) {
    var icons = { bold: 'B', italic: 'I', code: '<>', h2: 'H2', link: svgIcon('link', 13), img: svgIcon('image', 13), quote: svgIcon('quote', 13), ul: '•', ol: '1.', fence: '```' };
    return '<button type="button" class="tb-btn" data-cmd="' + cmd + '" title="' + cmd + '">' + (icons[cmd] || cmd) + '</button>';
  }).join('');
  return html + '<button type="button" class="tb-btn" id="tbSmoji" title="' + t('admin.editor.emoji') + '" aria-label="' + t('admin.editor.emoji') + '">😊</button>';
}

/** 当前编辑的文章别名：来自路由 /posts/<别名>/edit 或 ?edit= */
function currentEditId() {
  var r = currentRoute();
  if (r.path.indexOf('/posts/') === 0) {
    var seg = r.path.slice('/posts/'.length).split('/');
    if (seg[1] === 'edit' && seg[0]) {
      try { return decodeURIComponent(seg[0]); } catch (e) { return seg[0]; }
    }
  }
  var q = r.query;
  return (q && q.edit) || '';
}

function autoGrowMd() {
  var md = document.querySelector('#mdInput');
  if (!md) return;
  try {
    md.style.height = 'auto';
    var max = Math.max(window.innerHeight ? Math.floor(window.innerHeight * 0.7) : 600, 360);
    md.style.height = Math.min(md.scrollHeight, max) + 'px';
  } catch (e) {}
}

function updatePreview() {
  var md = document.querySelector('#mdInput');
  var pv = document.querySelector('#previewPane');
  if (!md || !pv) return;
  pv.innerHTML = renderMarkdown(md.value || '');
  var wc = document.querySelector('#wordCount');
  if (wc) wc.textContent = stripMd(md.value || '').length + ' ' + t('editor.wordUnit');
  autoGrowMd();
}

/** 云端模式编辑：/api/posts 列表只返回摘要（无 content），编辑时须按 id 拉取云端全文。
 *  云端是权威数据源：即使本地静态 posts.js 有旧正文，也一律用云端最新内容覆盖（拉取失败才保留本地）。 */
function loadEditContent(post, editId) {
  if (!post || !_cloudOn()) return;
  var st = document.querySelector('#saveStatus');
  if (st) st.textContent = t('editor.loadingCloud');
  apiFetch('api/posts/' + encodeURIComponent(editId))
    .then(function (data) {
      var full = (data && data.post) || null;
      if (full) {
        if (full.content !== undefined) post.content = full.content;
      }
      var md = document.querySelector('#mdInput');
      if (md) { md.value = post.content || ''; md.placeholder = ''; }
      updatePreview();
      if (st) st.textContent = t('editor.editingStatus') + (post.title || '');
    })
    .catch(function () {
      // 拉取失败：回退到本地静态内容（如有），避免编辑器空白
      var md = document.querySelector('#mdInput');
      if (md && !md.value) { md.value = post.content || ''; md.placeholder = ''; }
      updatePreview();
      if (st) st.textContent = t('editor.loadFailLocal');
    });
}

function bindWriteEvents() {
  var md = document.querySelector('#mdInput');
  if (md) md.addEventListener('input', function () {
    updatePreview();
    autoGrowMd();
    var st = document.querySelector('#saveStatus');
    if (st) st.textContent = t('editor.unsaved');
  });

  // “用官方编辑器”辅助按钮：新标签打开 markdown.com.cn 编辑器（跨域无法内嵌同步）
  var btnMd = document.querySelector('#btnOpenMdEditor');
  if (btnMd) btnMd.addEventListener('click', function () {
    try {
      var mdInput = document.querySelector('#mdInput');
      var u = 'https://markdown.com.cn/editor/';
      var q = encodeURIComponent((mdInput && mdInput.value) || '');
      if (q) u += '?md=' + q;
      window.open(u, '_blank');
    } catch (e) {}
  });

  var tbSmoji = document.querySelector('#tbSmoji');
  var tbSmojiArea = document.querySelector('#mdInput');
  if (tbSmoji && tbSmojiArea && window.initSmojiPicker) window.initSmojiPicker(tbSmoji, tbSmojiArea);

  document.querySelectorAll('#toolbar [data-cmd]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var cmd = btn.getAttribute('data-cmd');
      var ta = document.querySelector('#mdInput');
      if (!ta) return;
      var selStart = ta.selectionStart || 0;
      var selEnd = ta.selectionEnd || 0;
      var val = ta.value;
      var selected = val.slice(selStart, selEnd) || t('editor.textBtn');
      var insert = '';
      var offset = 0;
      switch (cmd) {
        case 'bold': insert = '**' + selected + '**'; offset = 2; break;
        case 'italic': insert = '*' + selected + '*'; offset = 1; break;
        case 'code': insert = '`' + selected + '`'; offset = 1; break;
        case 'h2': insert = '## ' + selected; offset = 3; break;
        case 'link': insert = '[' + selected + '](https://)'; offset = selected.length + 1; break;
        case 'img': insert = '![' + selected + '](https://)'; offset = selected.length + 2; break;
        case 'quote': insert = '> ' + selected; offset = 2; break;
        case 'ul': insert = '- ' + selected; offset = 2; break;
        case 'ol': insert = '1. ' + selected; offset = 3; break;
        case 'fence': insert = '\n```\n' + selected + '\n```\n'; offset = 4; break;
        default: insert = selected;
      }
      var newVal = val.slice(0, selStart) + insert + val.slice(selEnd);
      ta.value = newVal;
      ta.focus();
      var pos = selStart + offset;
      ta.setSelectionRange(pos, pos + selected.length);
      updatePreview();
      var st = document.querySelector('#saveStatus');
      if (st) st.textContent = t('editor.unsaved');
    });
  });

  var btnSave = document.querySelector('#btnSave');
  if (btnSave) btnSave.addEventListener('click', function () { saveStaticArticle(); });

  var btnCloud = document.querySelector('#btnCloud');
  if (btnCloud) btnCloud.addEventListener('click', function () { cloudPublish(); });

  var btnExport = document.querySelector('#btnExport');
  if (btnExport) btnExport.addEventListener('click', function () {
    saveFileFriendly('posts.js', buildPostsJs(), t('export.exported') + ' posts.js', t('export.downloaded') + ' posts.js');
  });

  var btnRss = document.querySelector('#btnRss');
  if (btnRss) btnRss.addEventListener('click', function () {
    saveFileFriendly('feed.xml', buildFeedXmlClient(getPublishedPosts(), 20), t('export.exported') + ' feed.xml', t('export.downloaded') + ' feed.xml');
  });

  var btnSitemap = document.querySelector('#btnSitemap');
  if (btnSitemap) btnSitemap.addEventListener('click', function () {
    saveFileFriendly('sitemap.xml', buildSitemapClient(), t('export.exported') + ' sitemap.xml', t('export.downloaded') + ' sitemap.xml');
  });

  // 一键导出全部：posts.js + feed.xml + sitemap.xml 三件套一次导出（静态发布只需覆盖这三个文件）
  var btnExportAll = document.querySelector('#btnExportAll');
  if (btnExportAll) btnExportAll.addEventListener('click', function () {
    saveFileFriendly('posts.js', buildPostsJs(), t('export.exported') + ' posts.js', t('export.downloaded') + ' posts.js');
    saveFileFriendly('feed.xml', buildFeedXmlClient(getPublishedPosts(), 20), t('export.exported') + ' feed.xml', t('export.downloaded') + ' feed.xml');
    saveFileFriendly('sitemap.xml', buildSitemapClient(), t('export.exported') + ' sitemap.xml', t('export.downloaded') + ' sitemap.xml');
  });

  // 退出登录：清除本地会话（云端同时撤销服务端 token），回到登录门
  var btnLogout = document.querySelector('#btnLogout');
  if (btnLogout) btnLogout.addEventListener('click', async function () {
    await adminLogout();
    route();
  });

  var btnClearData = document.querySelector('#btnClearData');
  if (btnClearData) btnClearData.addEventListener('click', function () {
    if (!confirm(t('editor.clearConfirm'))) return;
    // 仅清空编辑器表单，保留登录态和所有存储数据
    var title = document.querySelector('#titleInput');
    var date = document.querySelector('#dateInput');
    var tags = document.querySelector('#tagInput');
    var excerpt = document.querySelector('#excerptInput');
    var md = document.querySelector('#mdInput');
    var preview = document.querySelector('#previewPane');
    var wordCount = document.querySelector('#wordCount');
    var hint = document.querySelector('#writeTitleHint');
    if (title) title.value = '';
    if (date) date.value = '';
    if (tags) tags.value = '';
    if (excerpt) excerpt.value = '';
    if (md) { md.value = ''; md.dispatchEvent(new Event('input')); }
    if (preview) preview.innerHTML = '';
    if (wordCount) wordCount.textContent = '0 ' + t('editor.wordUnit');
    if (hint) hint.textContent = t('editor.newPost');
    // 清除当前编辑 id（如有），重置为新文章状态
    localStorage.removeItem('qingyu.edit.id');
  });

  var btnToday = document.querySelector('#btnToday');
  if (btnToday) {
    btnToday.addEventListener('click', function () {
      var input = document.querySelector('#dateInput');
      if (!input) return;
      var now = new Date();
      var year = now.getFullYear();
      var month = String(now.getMonth() + 1).padStart(2, '0');
      var day = String(now.getDate()).padStart(2, '0');
      var hours = String(now.getHours()).padStart(2, '0');
      var minutes = String(now.getMinutes()).padStart(2, '0');
      input.value = year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
      // 同步触发预览更新（如果有）
      if (typeof previewContent === 'function') previewContent();
    });
  }

  var btnDraft = document.querySelector('#btnSaveDraft');
  if (btnDraft) btnDraft.addEventListener('click', function () { saveDraft(); });

  var btnImport = document.querySelector('#btnImport');
  var fileInput = document.querySelector('#mdFileInput');
  if (btnImport && fileInput) {
    btnImport.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        var parsed = parseMdFile(String(e.target.result || ''), file.name);
        var title = document.querySelector('#titleInput'); if (title) title.value = parsed.title;
        var date = document.querySelector('#dateInput'); if (date) date.value = parsed.date;
        var tags = document.querySelector('#tagInput'); if (tags) tags.value = parsed.tags.join(', ');
        var excerpt = document.querySelector('#excerptInput'); if (excerpt) excerpt.value = parsed.excerpt || '';
        var md2 = document.querySelector('#mdInput'); if (md2) md2.value = parsed.content;
        updatePreview();
      };
      reader.readAsText(file);
    });
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDraft(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveStaticArticle(); }
  });
}

/* ---------- 管理后台：侧边栏 + 文章列表 ---------- */
function renderAdmin() {
  var html = renderNav(currentRoute().path);
  html += '<main class="container page-fade write-page">';
  
  if (!adminOk()) {
    // 未登录：复用 renderWrite 的登录逻辑
    renderWrite();
    return;
  }
  
  var route = adminRoute();
  var sidebar = renderAdminSidebar(route);
  html += '<div class="admin-layout">' + sidebar + '<div class="admin-content">';
  
  if (route === 'posts') {
    html += renderPostList();
  } else {
    html += renderEditorBody();
  }
  
  html += '</div></div>';
  html += '</main>' + renderFooter();
  app().innerHTML = html;

  // 侧边栏退出按钮（唯一后台独有；其余编辑器按钮与快捷键统一由下方 bindWriteEvents() 绑定，
  // 避免与 renderWrite 重复 ~100 行绑定逻辑，也杜绝同一按钮被绑定两次导致点击触发双次）
  var btnLogoutSidebar = document.querySelector('#btnLogoutSidebar');
  if (btnLogoutSidebar) btnLogoutSidebar.addEventListener('click', async function () {
    await adminLogout();
    route();
  });

  // 文章列表操作按钮（事件委托）：置顶、删除
  var content = document.querySelector('.admin-content');
  if (content) {
    content.addEventListener('click', function (e) {
      var pinBtn = e.target.closest('[data-pin-id]');
      if (pinBtn) { togglePinFromList(pinBtn.dataset.pinId); return; }
      var btn = e.target.closest('.btn-danger[data-post-id]');
      if (!btn) return;
      var id = btn.dataset.postId;
      var title = btn.dataset.postTitle || t('admin.postList.noTitle');
      if (!confirm(t('admin.postList.deleteConfirm', { title: title }))) return;
      if (_cloudOn()) {
        // 删除走 /api/posts/:id 的 DELETE（携带会话 token；旧代码误用 /api/admin/posts/:id 返回 404）
        apiFetch('api/posts/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }).then(function (res) {
          if (res && res.ok) {
            // 同步移除本地列表项，删除后列表立即生效（无需刷新）
            clearPostCache(id);   // 已删除：清除详情缓存
            var arr = window.BLOG_POSTS;
            if (Array.isArray(arr)) {
              window.BLOG_POSTS = arr.filter(function (p) { return p && p.id !== id; });
            }
            alert(t('admin.postList.deletedOk'));
            route();
          } else {
            alert(t('admin.postList.deleteFailRetry'));
          }
        }).catch(function () {
          alert(t('admin.postList.deleteFailNetwork'));
        });
      } else {
        var posts = getStaticPosts();
        var idx = posts.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) {
          posts.splice(idx, 1);
          clearPostCache(id);   // 已删除：清除详情缓存
          var blob = new Blob(['window.BLOG_POSTS=' + JSON.stringify(posts, null, 2) + ';'], { type: 'application/javascript' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'posts.js';
          a.click();
          // 延迟释放 URL：立即 revoke 会让部分浏览器（尤其 file://）取消下载，导致「删了却导出不了」
          setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 3000);
          alert(t('admin.postList.deleteSuccessLocal'));
          route();
        } else {
          alert(t('toast.notFound'));
        }
      }
    });
  }

  // 加载编辑数据（/admin/posts/:id/edit 路由下 currentEditId() 解析不到，需用 getEditIdFromRoute 兜底）
  var editId = currentEditId() || getEditIdFromRoute();
  if (editId) {
    var post = getStaticPosts().find(function (p) { return p.id === editId; });
    if (post) {
      var title = document.querySelector('#titleInput'); if (title) title.value = post.title || '';
      var date = document.querySelector('#dateInput'); if (date) date.value = toDateTimeLocal(post.date || '');
      var tags = document.querySelector('#tagInput'); if (tags) tags.value = (post.tags || []).join(', ');
      var excerpt = document.querySelector('#excerptInput'); if (excerpt) excerpt.value = post.excerpt || '';
      var cover = document.querySelector('#coverInput'); if (cover) cover.value = post.cover || '';
      var pin = document.querySelector('#pinnedInput'); if (pin) pin.checked = !!post.pinned;
      var md = document.querySelector('#mdInput');
      if (md) {
        if (_cloudOn()) {
          // 云端模式：始终以云端最新正文为准，先占位再由 loadEditContent 拉取覆盖
          md.value = '';
          md.placeholder = t('editor.loadingCloud');
        } else {
          md.value = post.content || '';
        }
      }
      var st = document.querySelector('#saveStatus'); if (st) st.textContent = t('editor.editingStatus') + (post.title || '');
      var hTitle = document.querySelector('#writeTitleHint'); if (hTitle) hTitle.textContent = t('editor.editingStatus') + (post.title || '');
      updatePreview();
      loadEditContent(post, editId);
    }
  }
  // else：新建文章 —— 保持干净的空白页，不自动恢复历史草稿/上次发布内容
  // 绑定编辑器交互：正文实时预览、工具栏插入语法、官方编辑器按钮
  // （renderWrite 在内部调用，这里必须补上，否则后台编辑器无响应）
  bindWriteEvents();
}

/** 把库内日期（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）转为 datetime-local 值（YYYY-MM-DDTHH:mm） */
function toDateTimeLocal(v) {
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return m[1] + 'T' + (m[2] ? (m[2].length === 1 ? '0' + m[2] : m[2]) + ':' + m[3] : '00:00');
  return s;
}

function collectEditor() {
  var title = document.querySelector('#titleInput'); if (!title) return null;
  var date = document.querySelector('#dateInput');
  var tags = document.querySelector('#tagInput');
  var excerpt = document.querySelector('#excerptInput');
  var cover = document.querySelector('#coverInput');
  var pin = document.querySelector('#pinnedInput');
  var md = document.querySelector('#mdInput');
  // 日期：datetime-local 值形如 "2025-01-01T08:30"；存库统一 "YYYY-MM-DD HH:mm"
  var dv = String((date && date.value) || '').replace('T', ' ');
  if (!dv) {
    // 未填写时用本地时间（toISOString 是 UTC，东八区凌晨会错到前一天）
    var now = new Date();
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    dv = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' '
      + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  }
  return {
    title: title.value || t('admin.postList.noTitle'),
    date: dv,
    tags: String((tags && tags.value) || '').split(/[,，]/).map(function (t) { return t.trim(); }).filter(Boolean),
    excerpt: (excerpt && excerpt.value) || '',
    cover: String((cover && cover.value) || '').trim(),
    pinned: !!(pin && pin.checked),
    content: md ? md.value : ''
  };
}




function saveDraft() {
  var d = collectEditor();
  if (!d) return;
  var editId = currentEditId();
  var id = editId || (d.title ? slugify(d.title) : 'draft');
  saveDraftToStore(id, d);
  var st = document.querySelector('#saveStatus');
  if (st) st.textContent = t('editor.savedDraft');
}

function saveStaticArticle() {
  var d = collectEditor();
  if (!d) return;
  var editId = currentEditId();
  var id = editId || (d.title ? slugify(d.title) : 'draft');
  d.id = id;
  saveDraftToStore('__new', d);
  var st2 = document.querySelector('#saveStatus');
  if (st2) st2.textContent = t('editor.savedLocal');
}

/** 云端发布（新建 POST / 编辑 PUT），成功后同步本地列表（首页无需刷新即可见）。
 *  /write、/posts/:id/edit、/admin、/admin/posts/:id/edit 共用。 */
async function cloudPublish() {
  var d = collectEditor();
  if (!d) return;
  // /admin/posts/:id/edit 下 currentEditId() 解析不到，需 getEditIdFromRoute 兜底，否则误用 POST 报 409
  var editId = currentEditId() || getEditIdFromRoute();
  var id = editId || (d.title ? slugify(d.title) : 'draft');
  d.id = id;
  var st = document.querySelector('#saveStatus');
  if (st) st.textContent = t('editor.publishing');
  try {
    // 新建用 POST，编辑用 PUT（幂等）
    var method = editId ? 'PUT' : 'POST';
    await apiFetch('api/posts' + (editId ? '/' + encodeURIComponent(editId) : ''), {
      method: method,
      body: JSON.stringify(d)
    });
    // 发布成功后回填文章并同步本地列表（首页立即可见）
    clearPostCache(d.id);   // 内容已更新：清掉旧缓存，下次进入直接拉新
    saveDraftToStore('__new', d);
    var arr = (Array.isArray(window.BLOG_POSTS) ? window.BLOG_POSTS : []).slice();
    var idx = arr.findIndex(function (p) { return p && p.id === d.id; });
    if (idx >= 0) arr[idx] = d; else arr.push(d);
    window.BLOG_POSTS = arr;
    if (st) st.innerHTML = svgIcon('check', 14) + ' ' + t('editor.publishedCloud');
  } catch (e) {
    var em = (e && e.message) || t('editor.unknownError');
    // 会话过期/无效：清掉本地旧 token，跳回登录页重新拿新令牌
    if (/401/.test(em)) {
      _setSessionToken('');
      _setAdminSession(false);
      if (st) st.textContent = t('editor.loginExpired');
      setTimeout(function () { route(); }, 900);
      return;
    }
    if (st) st.textContent = t('editor.saveFail') + '：' + em;
  }
}

/* 注：云端 feed.xml / sitemap.xml 由 /api/feed.xml、/api/sitemap.xml 实时从 D1 生成，
 * 前端不再需要回传产物到 site_files（原 syncSiteFilesToCloud 已移除，避免无用的 D1 写入）。 */

function buildSitemapClient() {
  var cfg = getConfig();
  var base = cfg.siteUrl || (typeof location !== 'undefined' ? location.origin : '');
  base = String(base || '').replace(/\/+$/, '');
  var posts = sortPagePosts(getPublishedPosts());
  var lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  lines.push('  <url><loc>' + esc(base + '/') + '</loc></url>');
  lines.push('  <url><loc>' + esc(base + '/about') + '</loc></url>');
  lines.push('  <url><loc>' + esc(base + '/archive') + '</loc></url>');
  lines.push('  <url><loc>' + esc(base + '/popular') + '</loc></url>');
  lines.push('  <url><loc>' + esc(base + '/guestbook') + '</loc></url>');
  posts.forEach(function (p) {
    lines.push('  <url><loc>' + esc(base + postUrl(p.id)) + '</loc><lastmod>' + esc(p.date || '') + '</lastmod></url>');
  });
  lines.push('</urlset>', '');
  return lines.join('\n');
}
