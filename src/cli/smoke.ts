/* ============================================================
 * 端到端冒烟测试
 * ------------------------------------------------------------
 * 对运行中的实例做真实 HTTP 调用，覆盖关键业务闭环：
 *   健康检查 → 管理员初始化 → 登录 → 权限拦截 → 文章 CRUD
 *   → 全文搜索(FTS5) → 评论 → RSS/Sitemap → 媒体直传 → 站点备份
 *
 * 用法：BASE_URL=http://localhost:8787 SETUP_KEY=xxx node dist/cli/smoke.js
 * ============================================================ */

const BASE = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SETUP_KEY = process.env.SETUP_KEY || '';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  data: T;
  headers: Headers;
}

async function api<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${BASE}${path}`, { method: options.method ?? 'GET', headers, body });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text.slice(0, 200) };
  }
  return { status: response.status, data: data as T, headers: response.headers };
}

const MARKER = `smoke${Date.now().toString(36)}`;
const POST_ID = `post-${MARKER}`;
const KEYWORD = `通用云部署验证词${MARKER.slice(-4)}`;

console.log('\n轻语博客自托管版 · 冒烟测试');
console.log(`目标：${BASE}\n`);

/* ---------- 1. 健康检查 ---------- */
const health = await api<{ ok?: boolean; database?: string; storage?: string }>('/healthz');
ok('健康检查返回 200', health.status === 200, `status=${health.status}`);
ok('数据库为 SQLite', health.data.database === 'sqlite');
ok('存储模式已上报', health.data.storage === 'local' || health.data.storage === 's3', String(health.data.storage));

/* ---------- 2. 管理员初始化 ---------- */
const setupHeaders: Record<string, string> = SETUP_KEY ? { 'X-Setup-Key': SETUP_KEY } : {};
const setup = await api('/api/admin/setup', {
  method: 'POST',
  headers: setupHeaders,
  body: { password: 'Smoke-Test-Password-123' }
});
ok('管理员初始化（已初始化则跳过）', setup.status === 201 || setup.status === 409, `status=${setup.status}`);

/* ---------- 3. 登录 ---------- */
const login = await api<{ token?: string }>('/api/admin/login', {
  method: 'POST',
  headers: setupHeaders,
  body: { password: 'Smoke-Test-Password-123' }
});
ok('管理员登录成功', login.status === 200 && Boolean(login.data.token), `status=${login.status}`);
const auth = { Authorization: `Bearer ${login.data.token ?? ''}` };

/* ---------- 4. 未授权写入被拒绝 ---------- */
const anonymous = await api('/api/posts', { method: 'POST', body: { id: 'x', title: 'x' } });
ok('匿名写入被拒绝', anonymous.status === 401 || anonymous.status === 403, `status=${anonymous.status}`);

/* ---------- 5. 新建文章 ---------- */
const created = await api('/api/posts', {
  method: 'POST',
  headers: auth,
  body: {
    id: POST_ID,
    title: `冒烟测试文章 ${MARKER}`,
    excerpt: '自托管验证',
    content: `# 标题\n\n这是自托管通用版的端到端验证。\n\n${KEYWORD}\n`,
    tags: ['测试', '自托管'],
    date: new Date().toISOString(),
    status: 'published',
    author: 'smoke'
  }
});
ok('新建文章返回 201', created.status === 201, `status=${created.status}`);

/* ---------- 6. 列表与详情 ---------- */
const list = await api<{ posts?: Array<{ id: string }> }>('/api/posts');
ok('文章出现在公开列表', list.status === 200 && Boolean(list.data.posts?.some((p) => p.id === POST_ID)));

const detail = await api<{ post?: { content?: string } }>(`/api/posts/${encodeURIComponent(POST_ID)}`);
ok('文章详情可读取', detail.status === 200 && Boolean(detail.data.post?.content?.includes(KEYWORD)), `status=${detail.status}`);

/* ---------- 7. 全文搜索（FTS5 trigram） ---------- */
const search = await api<{ results?: Array<{ id: string }> }>(`/api/search?q=${encodeURIComponent(KEYWORD)}`);
ok('FTS5 全文搜索命中新文章', search.status === 200 && Boolean(search.data.results?.some((r) => r.id === POST_ID)), `status=${search.status}`);

/* ---------- 8. 评论 ---------- */
const comment = await api(`/api/posts/${encodeURIComponent(POST_ID)}/comments`, {
  method: 'POST',
  body: { author: '冒烟测试', content: `评论验证 ${MARKER}` }
});
ok('发表评论成功', comment.status === 200 || comment.status === 201, `status=${comment.status}`);

const comments = await api(`/api/posts/${encodeURIComponent(POST_ID)}/comments`);
ok('评论可读回', comments.status === 200 && JSON.stringify(comments.data).includes(MARKER), `status=${comments.status}`);

/* ---------- 9. Feed / Sitemap ---------- */
const feed = await fetch(`${BASE}/api/feed.xml`);
ok('RSS 订阅可生成', feed.status === 200 && (await feed.text()).includes('<rss'), `status=${feed.status}`);

const sitemap = await fetch(`${BASE}/api/sitemap.xml`);
ok('Sitemap 可生成', sitemap.status === 200 && (await sitemap.text()).includes('<urlset'), `status=${sitemap.status}`);

/* ---------- 10. 媒体上传（本地磁盘或 S3 直传） ---------- */
const signed = await api<{ uploadUrl?: string; publicUrl?: string; key?: string }>('/api/media/upload-url', {
  method: 'POST',
  headers: auth,
  body: { filename: 'smoke.png', size: 1024 }
});

if (signed.status === 200 && signed.data.uploadUrl) {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex'
  );
  const put = await fetch(signed.data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: png
  });
  ok('媒体直传上传成功', put.status === 200 || put.status === 204, `status=${put.status}`);

  const fetched = await fetch(signed.data.publicUrl ?? '');
  ok(
    '上传后的媒体可公开访问',
    fetched.status === 200 && Number(fetched.headers.get('content-length') ?? 0) === png.length,
    `status=${fetched.status}`
  );

  await api(`/api/media/${encodeURIComponent(signed.data.key ?? '')}`, { method: 'DELETE', headers: auth });
} else {
  ok('媒体上传地址签发', false, `status=${signed.status}`);
}

/* ---------- 11. 备份（本地磁盘模式亦可用） ---------- */
const backup = await api('/api/admin/backups', { method: 'POST', headers: auth });
ok('站点备份可创建', backup.status === 200 || backup.status === 201, `status=${backup.status}`);

/* ---------- 12. 清理 ---------- */
const removed = await api(`/api/posts/${encodeURIComponent(POST_ID)}`, { method: 'DELETE', headers: auth });
ok('删除文章成功', removed.status === 200 || removed.status === 204, `status=${removed.status}`);

console.log(`\n结果：${passed} 项通过，${failed} 项失败`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const item of failures) console.log(`  · ${item}`);
  process.exit(1);
}
console.log('全部通过 ✓\n');