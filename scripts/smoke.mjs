/* ============================================================
 * 端到端冒烟测试
 * ------------------------------------------------------------
 * 对一个正在运行的实例做真实 HTTP 调用，覆盖最关键的业务闭环：
 *   健康检查 → 管理员初始化 → 登录 → 文章 CRUD → 全文搜索(FTS5)
 *   → 评论 → RSS/Sitemap → 媒体上传（本地磁盘或 S3）
 *
 * 用法：BASE_URL=http://localhost:8787 SETUP_KEY=xxx node scripts/smoke.mjs
 * ============================================================ */
const BASE = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SETUP_KEY = process.env.SETUP_KEY || '';

let pass = 0, fail = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \u2717 ' + name + (detail ? ' — ' + detail : '')); }
}

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data, headers: res.headers };
}

const MARKER = 'smoke' + Date.now().toString(36);
const POST_ID = 'post-' + MARKER;
const KEYWORD = '通用云部署验证词' + MARKER.slice(-4);

console.log('\n轻语博客自托管版 · 冒烟测试');
console.log('目标：' + BASE + '\n');

/* ---------- 1. 健康检查 ---------- */
const health = await api('/healthz');
ok('健康检查返回 200', health.status === 200, 'status=' + health.status);
ok('数据库为 SQLite', health.data && health.data.database === 'sqlite');
ok('存储模式已上报', health.data && (health.data.storage === 'local' || health.data.storage === 's3'), health.data && health.data.storage);

/* ---------- 2. 管理员初始化 ---------- */
const setupHeaders = SETUP_KEY ? { 'X-Setup-Key': SETUP_KEY } : {};
const setup = await api('/api/admin/setup', {
  method: 'POST', headers: setupHeaders, body: { password: 'Smoke-Test-Password-123' }
});
ok('管理员初始化（已初始化则跳过）', setup.status === 201 || setup.status === 409, 'status=' + setup.status + ' ' + JSON.stringify(setup.data));

/* ---------- 3. 登录 ---------- */
const login = await api('/api/admin/login', {
  method: 'POST', headers: setupHeaders, body: { password: 'Smoke-Test-Password-123' }
});
ok('管理员登录成功', login.status === 200 && login.data && login.data.token, 'status=' + login.status + ' ' + JSON.stringify(login.data));
const token = (login.data && login.data.token) || '';
const auth = { Authorization: 'Bearer ' + token };

/* ---------- 4. 未授权写入被拒绝 ---------- */
const anon = await api('/api/posts', { method: 'POST', body: { id: 'x', title: 'x' } });
ok('匿名写入被拒绝', anon.status === 401 || anon.status === 403, 'status=' + anon.status);

/* ---------- 5. 新建文章 ---------- */
const created = await api('/api/posts', {
  method: 'POST', headers: auth,
  body: {
    id: POST_ID,
    title: '冒烟测试文章 ' + MARKER,
    excerpt: '自托管验证',
    content: '# 标题\n\n这是自托管通用版的端到端验证。\n\n' + KEYWORD + '\n',
    tags: ['测试', '自托管'],
    date: new Date().toISOString(),
    status: 'published',
    author: 'smoke'
  }
});
ok('新建文章返回 201', created.status === 201, 'status=' + created.status + ' ' + JSON.stringify(created.data).slice(0, 200));

/* ---------- 6. 列表与详情 ---------- */
const list = await api('/api/posts');
ok('文章出现在公开列表', list.status === 200 && list.data.posts.some((p) => p.id === POST_ID));
const detail = await api('/api/posts/' + encodeURIComponent(POST_ID));
ok('文章详情可读取', detail.status === 200 && detail.data.post && detail.data.post.content.includes(KEYWORD), 'status=' + detail.status);

/* ---------- 7. 全文搜索（FTS5 trigram） ---------- */
const search = await api('/api/search?q=' + encodeURIComponent(KEYWORD));
ok('FTS5 全文搜索命中新文章', search.status === 200 && search.data && Array.isArray(search.data.results) && search.data.results.some((r) => r.id === POST_ID),
  'status=' + search.status + ' ' + JSON.stringify(search.data).slice(0, 200));

/* ---------- 8. 评论 ---------- */
const comment = await api('/api/posts/' + encodeURIComponent(POST_ID) + '/comments', {
  method: 'POST', body: { author: '冒烟测试', content: '评论验证 ' + MARKER }
});
ok('发表评论成功', comment.status === 200 || comment.status === 201, 'status=' + comment.status + ' ' + JSON.stringify(comment.data).slice(0, 200));
const comments = await api('/api/posts/' + encodeURIComponent(POST_ID) + '/comments');
ok('评论可读回', comments.status === 200 && JSON.stringify(comments.data).includes(MARKER), 'status=' + comments.status);

/* ---------- 9. Feed / Sitemap ---------- */
const feed = await fetch(BASE + '/api/feed.xml');
const feedText = await feed.text();
ok('RSS 订阅可生成', feed.status === 200 && feedText.includes('<rss'), 'status=' + feed.status);
const sitemap = await fetch(BASE + '/api/sitemap.xml');
const sitemapText = await sitemap.text();
ok('Sitemap 可生成', sitemap.status === 200 && sitemapText.includes('<urlset'), 'status=' + sitemap.status);

/* ---------- 10. 媒体上传（本地磁盘或 S3 直传） ---------- */
const signed = await api('/api/media/upload-url', {
  method: 'POST', headers: auth, body: { filename: 'smoke.png', size: 1024 }
});
if (signed.status === 200 && signed.data && signed.data.uploadUrl) {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
  const put = await fetch(signed.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
  ok('媒体直传上传成功', put.status === 200 || put.status === 204, 'status=' + put.status);
  const got = await fetch(signed.data.publicUrl);
  ok('上传后的媒体可公开访问', got.status === 200 && Number(got.headers.get('content-length') || 0) === png.length,
    'status=' + got.status + ' len=' + got.headers.get('content-length'));
  await api('/api/media/' + encodeURIComponent(signed.data.key || ''), { method: 'DELETE', headers: auth });
} else {
  ok('媒体上传地址签发', false, 'status=' + signed.status + ' ' + JSON.stringify(signed.data).slice(0, 200));
}

/* ---------- 11. 备份（本地磁盘模式亦可用） ---------- */
const backup = await api('/api/admin/backups', { method: 'POST', headers: auth });
ok('站点备份可创建', backup.status === 200 || backup.status === 201, 'status=' + backup.status + ' ' + JSON.stringify(backup.data).slice(0, 200));

/* ---------- 12. 清理 ---------- */
const removed = await api('/api/posts/' + encodeURIComponent(POST_ID), { method: 'DELETE', headers: auth });
ok('删除文章成功', removed.status === 200 || removed.status === 204, 'status=' + removed.status);

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) {
  console.log('\n失败项：');
  for (const item of failures) console.log('  · ' + item);
  process.exit(1);
}
console.log('全部通过 ✓\n');