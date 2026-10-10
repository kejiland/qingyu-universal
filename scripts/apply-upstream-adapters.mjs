/* ============================================================
 * 上游代码适配补丁（幂等 · 单行锚点）
 * ------------------------------------------------------------
 * 上游 qingyu-blog 是纯 Cloudflare 形态。为让同一份业务代码跑在自托管
 * 环境，这里只做最小必要的「接缝」改动，集中在对象存储与邮件两处；
 * 业务逻辑（文章/评论/统计/AI/搜索/备份/Webmention…）一行未改。
 *
 * 上游版本：kejiland/qingyu-blog @ ad3bfb95bdb5bf5783c66db67bbd108c6f33d71c
 * 重新同步上游：覆盖 app/ 后执行 node scripts/apply-upstream-adapters.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let applied = 0, skipped = 0;
const log = [];

function edit(file, fn) {
  const target = path.join(ROOT, file);
  const lines = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const before = lines.join('\n');
  fn(lines);
  const after = lines.join('\n');
  if (after === before) { skipped++; log.push('[skip] ' + file); return; }
  fs.writeFileSync(target, after, 'utf8');
  applied++; log.push('[ok]   ' + file);
}
function insertAfter(lines, match, ...added) {
  const i = lines.findIndex((l) => l.includes(match));
  if (i < 0) throw new Error('锚点缺失: ' + match);
  if (added.some((a) => lines.includes(a))) return;
  lines.splice(i + 1, 0, ...added);
}
function replaceLine(lines, match, ...replacement) {
  // 先判断补丁是否已经存在，再找锚点。
  // 顺序反了会导致脚本不幂等：已打过补丁的文件里锚点已被替换掉，
  // 第二次执行就会误报「锚点缺失」。
  if (replacement.some((r) => lines.includes(r))) return;
  const i = lines.findIndex((l) => l.includes(match));
  if (i < 0) throw new Error('锚点缺失: ' + match);
  lines.splice(i, 1, ...replacement);
}

/* ---------- 对象存储：本地磁盘适配器 ---------- */
edit('app/functions/_lib/music.js', (l) => {
  const putHook = '  if (env && env.LOCAL_STORAGE) return env.LOCAL_STORAGE.presignPut(env, key, expiresSec, bucket, contentType, relative);';
  if (!l.includes(putHook)) {
    const oldHook = '  if (env && env.LOCAL_STORAGE) return env.LOCAL_STORAGE.presignPut(env, key, expiresSec, bucket, contentType);';
    const oldIndex = l.indexOf(oldHook);
    if (oldIndex >= 0) {
      l.splice(oldIndex, 1,
        '  // [self-host] 本地模式返回相对上传地址，避免 SITE_URL 与浏览器来源不一致',
        putHook);
    } else {
      const sigIndex = l.findIndex((line) => line.includes('export async function presignPut(env, key, expiresSec, bucket, contentType'));
      if (sigIndex < 0) throw new Error('锚点缺失: music.js presignPut');
      l.splice(sigIndex + 1, 0,
        '  // [self-host] 本地模式返回相对上传地址，避免 SITE_URL 与浏览器来源不一致',
        putHook);
    }
  }
  replaceLine(l, 'export async function presignPut(env, key, expiresSec, bucket, contentType) {',
    'export async function presignPut(env, key, expiresSec, bucket, contentType, relative) {');
  insertAfter(l, 'export async function presignGet(env, key, expiresSec, bucket) {',
    '  // [self-host] 备份对象读取同样支持本地磁盘',
    '  if (env && env.LOCAL_STORAGE) return env.LOCAL_STORAGE.presignGet(env, key, expiresSec, bucket);');
  insertAfter(l, 'export async function r2DeleteObject(env, key, bucket) {',
    '  // [self-host] 本地磁盘模式直接删除文件',
    '  if (env && env.LOCAL_STORAGE) return env.LOCAL_STORAGE.deleteObject(env, key, bucket);');
  replaceLine(l, "const scope = dateStamp + '/auto/s3/aws4_request';",
    '  // [self-host] 区域可配置：Cloudflare R2 固定 auto，MinIO / AWS S3 需真实 region',
    "  const region = String(env.R2_REGION || 'auto');",
    "  const scope = dateStamp + '/' + region + '/s3/aws4_request';");
  replaceLine(l, 'return { endpoint, host, amzDate, dateStamp, scope };',
    '  return { endpoint, host, amzDate, dateStamp, scope, region };');
  replaceLine(l, "'auto', 's3');", "  const keyBytes = await signingKey(env.R2_SECRET_ACCESS_KEY, p.dateStamp, p.region || 'auto', 's3');");

  if (!l.some((line) => line.includes('export function publicUrlForKey'))) {
    const i = l.findIndex((line) => line.includes('function originOf(value) {'));
    if (i < 0) throw new Error('锚点缺失: music.js originOf');
    l.splice(i, 0,
      '/** 本地模式返回同源相对公开地址，不绑定访问域名或 WSL 网关。 */',
      'export function publicUrlForKey(env, key, base, request) {',
      "  const cleanKey = String(key || '').replace(/^\\/+/, '');",
      "  if (env && env.LOCAL_STORAGE) return '/' + cleanKey;",
      '  const trimmed = trimBase(base);',
      "  return trimmed ? trimmed + '/' + cleanKey : '';",
      '}',
      '');
  }
  const localMusicKeyMarker = '    // [self-host] 本地模式从相对公开地址解析音乐对象';
  if (!l.includes(localMusicKeyMarker)) {
    const i = l.findIndex((line) => line.includes("const u = new URL(String(publicUrl || ''));"));
    if (i < 0) throw new Error('锚点缺失: music.js resolveR2Object');
    l.splice(i, 1,
      localMusicKeyMarker,
      "    const raw = String(publicUrl || '');",
      '    const u = env && env.LOCAL_STORAGE',
      "      ? new URL(raw, 'http://local-storage.invalid')",
      '      : new URL(raw);',
      '    if (env && env.LOCAL_STORAGE) {',
      "      if (u.pathname.indexOf('/music/') !== 0) return null;",
      "      return { key: u.pathname.slice(1), bucket: musicStorage(env).bucket };",
      '    }');
  }
  replaceLine(l, '  const uploadUrl = await presignPut(env, key, 3600, storage.bucket, contentType);',
    '  const uploadUrl = await presignPut(env, key, 3600, storage.bucket, contentType, true);');
  replaceLine(l, "  const publicUrl = storage.publicBase ? storage.publicBase + '/' + key : '';",
    '  const publicUrl = publicUrlForKey(env, key, storage.publicBase, request);');
});

/* ---------- 媒体：本地模式使用同源相对地址 ---------- */
edit('app/functions/_lib/media.js', (l) => {
  replaceLine(l, "import { presignPut, r2DeleteObject } from './music.js';",
    "import { presignPut, publicUrlForKey, r2DeleteObject } from './music.js';");
  const localMediaKeyMarker = '    // [self-host] 本地模式从相对公开地址提取对象 key';
  if (!l.includes(localMediaKeyMarker)) {
    const i = l.findIndex((line) => line.includes("const u = new URL(String(publicUrl || ''));"));
    if (i < 0) throw new Error('锚点缺失: media.js extractMediaR2Key');
    l.splice(i, 1,
      localMediaKeyMarker,
      "    const raw = String(publicUrl || '');",
      '    const u = env && env.LOCAL_STORAGE',
      "      ? new URL(raw, 'http://local-storage.invalid')",
      '      : new URL(raw);',
      '    if (env && env.LOCAL_STORAGE) {',
      "      return u.pathname.indexOf('/media/') === 0 ? u.pathname.slice(1) : '';",
      '    }');
  }
  replaceLine(l, '  const uploadUrl = await presignPut(env, key, 3600, env.R2_MEDIA_BUCKET, contentType);',
    '  const uploadUrl = await presignPut(env, key, 3600, env.R2_MEDIA_BUCKET, contentType, true);');
  replaceLine(l, "  const publicUrl = publicBase ? publicBase + '/' + key : '';",
    '  const publicUrl = publicUrlForKey(env, key, env.R2_MEDIA_PUBLIC_BASE, request);');
  replaceLine(l, "    thumbUploadUrl = await presignPut(env, thumbKey, 3600, env.R2_MEDIA_BUCKET, 'image/webp');",
    "    thumbUploadUrl = await presignPut(env, thumbKey, 3600, env.R2_MEDIA_BUCKET, 'image/webp', true);");
  replaceLine(l, "    thumbPublicUrl = publicBase ? publicBase + '/' + thumbKey : '';",
    '    thumbPublicUrl = publicUrlForKey(env, thumbKey, env.R2_MEDIA_PUBLIC_BASE, request);');
});

/* ---------- OG 图片：本地模式使用同源相对地址 ---------- */
edit('app/functions/_lib/og.js', (l) => {
  replaceLine(l, "import { presignPut } from './music.js';",
    "import { presignPut, publicUrlForKey } from './music.js';");
  replaceLine(l, "  const uploadUrl = await presignPut(env, key, 900, s.bucket, 'image/png');",
    "  const uploadUrl = await presignPut(env, key, 900, s.bucket, 'image/png', true);");
  replaceLine(l, "  return json({ ok: true, uploadUrl, publicUrl: s.publicBase + '/' + key, key, expiresIn: 900 }, 200, request, env, { 'Cache-Control': 'no-store' });",
    "  return json({ ok: true, uploadUrl, publicUrl: publicUrlForKey(env, key, s.publicBase, request), key, expiresIn: 900 }, 200, request, env, { 'Cache-Control': 'no-store' });");
});

/* ---------- 评论目标：文章或内置留言板 ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  const targets = "const SYNTHETIC_COMMENT_TARGETS = ['gb-note', 'gb-idea'];";
  if (!l.includes(targets)) {
    const i = l.findIndex((line) => line.includes('const COMMENT_CAPS ='));
    if (i < 0) throw new Error('锚点缺失: api-core.js COMMENT_CAPS');
    l.splice(i, 0, targets, '');
  }
  const checkMarker = '    // [self-host] 评论目标是文章或内置留言板；避免不存在文章触发外键 500';
  const commentStart = l.findIndex((line) => line.includes('export async function handleComments(request, env, postId)'));
  const checkIndex = l.findIndex((line, index) => index > commentStart && line.includes(checkMarker));
  if (checkIndex < 0) {
    if (commentStart < 0) throw new Error('锚点缺失: api-core.js handleComments');
    const i = l.findIndex((line, index) => index > commentStart && line.includes('const body = await request.json().catch(() => null);'));
    if (i < 0) throw new Error('锚点缺失: api-core.js 评论请求体');
    l.splice(i + 1, 0,
      checkMarker,
      '    if (SYNTHETIC_COMMENT_TARGETS.indexOf(postId) < 0) {',
      "      const target = await dbFirst(env.DB, 'SELECT id FROM posts WHERE id = ?', postId);",
      "      if (!target) return json({ error: '文章不存在或已删除' }, 404, request, env);",
      '    }');
  }
});

/* ---------- PostgreSQL：ON CONFLICT 中限定目标表列名 ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  const replaceInLine = (from, to) => {
    const i = l.findIndex((line) => line.includes(from));
    if (i >= 0) { l[i] = l[i].replace(from, to); return; }
    if (!l.some((line) => line.includes(to))) throw new Error('锚点缺失: ' + from);
  };
  replaceInLine('ON CONFLICT(post_id) DO UPDATE SET likes = MIN(likes + 1, 9999999)', 'ON CONFLICT(post_id) DO UPDATE SET likes = MIN(stats.likes + 1, 9999999)');
  replaceInLine('ON CONFLICT(post_id,date) DO UPDATE SET likes = likes + 1', 'ON CONFLICT(post_id,date) DO UPDATE SET likes = stats_daily.likes + 1');
  replaceInLine('ON CONFLICT(post_id) DO UPDATE SET views = MIN(views + 1, 9999999)', 'ON CONFLICT(post_id) DO UPDATE SET views = MIN(stats.views + 1, 9999999)');
  replaceInLine('ON CONFLICT(post_id,date) DO UPDATE SET views = views + 1', 'ON CONFLICT(post_id,date) DO UPDATE SET views = stats_daily.views + 1');
  replaceInLine('ON CONFLICT(post_id,date,kind,name) DO UPDATE SET views = views + 1', 'ON CONFLICT(post_id,date,kind,name) DO UPDATE SET views = stats_sources.views + 1');
  replaceInLine('ON CONFLICT(fingerprint) DO UPDATE SET hits = hits + 1', 'ON CONFLICT(fingerprint) DO UPDATE SET hits = error_logs.hits + 1');
});
/* ---------- 媒体登记：允许本地存储的根相对地址 ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  const marker = '    // [self-host] 本地存储上传返回根相对 /media/...，允许作为站内对象登记';
  if (!l.includes(marker)) {
    const i = l.findIndex((line) => line.includes("if (!/^https?:\\/\\//i.test(url)) {"));
    if (i < 0) throw new Error('锚点缺失: api-core.js media url 校验');
    l.splice(i, 3,
      marker,
      '    const isHttpUrl = /^https?:\\/\\//i.test(url);',
      '    const isLocalObjectUrl = /^\\/(?:media|music|og)\\//i.test(url);',
      '    if (!isHttpUrl && !isLocalObjectUrl) {',
      "      return json({ error: '仅支持 http/https 或站内 /media、/music、/og 链接' }, 400, request, env);",
      '    }');
  }
});
/* ---------- 邮件：SMTP 适配器（保留 Resend） ---------- */
edit('app/functions/_lib/subscribe.js', (l) => {
  replaceLine(l, 'return !!(env && env.RESEND_API_KEY && env.BLOG_MAIL_FROM && env.SITE_URL);',
    '  // [self-host] SMTP（env.MAIL_SEND）与 Resend 二选一',
    '  if (!env || !env.BLOG_MAIL_FROM || !env.SITE_URL) return false;',
    '  return !!(env.MAIL_SEND || env.RESEND_API_KEY);');
  insertAfter(l, 'async function sendEmail(env, to, subject, html) {',
    '  // [self-host] 优先使用注入的 SMTP 发信器，未配置时回退 Resend',
    '  if (env.MAIL_SEND) return env.MAIL_SEND(to, subject, html);');
  replaceLine(l, "'邮件服务未配置（RESEND_API_KEY / BLOG_MAIL_FROM / SITE_URL）'",
    "  if (!mailConfigured(env)) throw new Error('邮件服务未配置（SMTP / RESEND_API_KEY / BLOG_MAIL_FROM / SITE_URL）');");
});


/* ---------- 4. 响应头消毒：非 ASCII 头值会让 Headers 构造直接抛错 ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  // 用显式标记判断是否已打过补丁。原先依赖 replacement.some(r => lines.includes(r))
  // 判断，实测在部分情况下会误判成「已存在」而静默跳过，不可靠。
  if (l.some((line) => line.includes('safeHeaders'))) return;

  const i = l.findIndex((line) =>
    line.includes('return new Response(JSON.stringify(data), { status, headers });')
  );
  if (i < 0) throw new Error('锚点缺失: api-core.js json() 的 return');

  l.splice(
    i,
    1,
    '  // [self-host] HTTP 头值必须是 ByteString（每个字符 <= 0xFF）。',
    "  // 上游把文章 ID 直接拼进 Cache-Tag（'posts,post:' + id），中文 ID 会让",
    '  // new Headers() 抛 ByteString 错误，导致整个接口 500。这里逐字符检查，',
    '  // 把非 ASCII 百分号编码 —— 保留信息同时保证是合法头值。',
    '  const safeHeaders = {};',
    '  for (const hk of Object.keys(headers)) {',
    '    const hv = headers[hk];',
    "    if (typeof hv !== 'string') { safeHeaders[hk] = hv; continue; }",
    "    let acc = '';",
    '    for (const ch of hv) {',
    '      const code = ch.codePointAt(0);',
    '      acc += (code >= 32 && code <= 126) || code === 9 ? ch : encodeURIComponent(ch);',
    '    }',
    '    safeHeaders[hk] = acc;',
    '  }',
    '  return new Response(JSON.stringify(data), { status, headers: safeHeaders });'
  );
});

/* ---------- 5. 文章时间戳写入：created_at / updated_at 从未赋值 ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  if (l.some((line) => line.includes('function nowIso()'))) return;

  // 1) postToParams 末尾补两个时间戳参数
  const paramsIdx = l.findIndex((line) => line.trim() === 'JSON.stringify(normalizeSeo(p.seo))');
  if (paramsIdx < 0) throw new Error('锚点缺失: api-core.js postToParams 的 seo 参数');
  if (!l[paramsIdx + 1].includes('nowIso()')) {
    if (!l[paramsIdx].trimEnd().endsWith(',')) l[paramsIdx] = l[paramsIdx].trimEnd() + ',';
    l.splice(
      paramsIdx + 1,
      0,
      '    // created_at / updated_at 此前**从未被写入**，两列恒为空串。后果：sitemap 的',
      '    // <lastmod>、文章页的 dateModified / article:modified_time 全部退化成「发布日期」',
      '    // —— 改过的文章在搜索引擎眼里仍是旧内容，各种缓存指纹也失去可靠依据。',
      '    nowIso(),',
      '    nowIso()'
    );
  }

  // 2) 统一的 ISO 时间戳（秒精度，与 posts.date 的写法一致）
  const fnIdx = l.findIndex((line) => line.startsWith('function postToParams('));
  if (fnIdx < 0) throw new Error('锚点缺失: api-core.js postToParams');
  const afterParams = l.findIndex(
    (line, i) => i > fnIdx && line === '}'
  );
  l.splice(
    afterParams + 1,
    0,
    '',
    '/** 统一的 ISO 时间戳（秒精度，与 posts.date 的写法一致）。 */',
    'function nowIso() {',
    "  return new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');",
    '}'
  );

  // 3) 三处 INSERT 列表补 created_at / updated_at 两列
  const cols = 'id,title,date,excerpt,content,cover,og_image,pinned,protected,enc,tags,category,series,author,series_order,status,publish_at,seo';
  l.forEach((line, i) => {
    if (!line.includes('INSERT INTO posts (' + cols + ') VALUES')) return;
    if (l[i].includes('created_at,updated_at')) return;
    l[i] = l[i].replace(cols + ')', cols + ',created_at,updated_at)');
    // 占位符 18 -> 20
    const m = l[i].match(/VALUES \((\?[^)]*)\)/);
    if (m) {
      const marks = m[1].split(',');
      while (marks.length < 20) marks.push('?');
      l[i] = l[i].replace(/VALUES \([^)]*\)/, 'VALUES (' + marks.slice(0, 20).join(',') + ')');
    }
  });

  // 4) 两处 UPSERT 的 DO UPDATE 补 updated_at / created_at
  l.forEach((line, i) => {
    if (!line.includes('ON CONFLICT(id) DO UPDATE SET')) return;
    if (line.includes('updated_at=excluded.updated_at')) return;
    l[i] = line.replace(
      /(\bseo=excluded\.seo)/,
      "$1,updated_at=excluded.updated_at,created_at=COALESCE(NULLIF(posts.created_at, \'\'), excluded.created_at)"
    );
  });

  // 5) 定时发布转正也是一次内容变更
  const pubIdx = l.findIndex((line) =>
    line.includes("UPDATE posts SET status = 'published', publish_at = NULL WHERE id = ?")
  );
  if (pubIdx >= 0 && !l[pubIdx].includes('updated_at')) {
    l.splice(
      pubIdx,
      1,
      '    // 转正也是一次内容变更：推进 updated_at，sitemap 与 dateModified 才不会停在草稿期。',
      "    sql: \"UPDATE posts SET status = 'published', publish_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'\",",
      '    params: [nowIso(), id],'
    );
  }
});

/* ---------- 6. 审计日志保留策略 + 登录失败留痕（通用版自有增量） ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  if (!l.some((line) => line.includes('export async function trimAuditLog'))) {
    // 6.1 保留策略常量与裁剪函数，插在 recordAudit 之前
    const recIdx = l.findIndex((line) => line.includes('export async function recordAudit('));
    if (recIdx < 0) throw new Error('锚点缺失: api-core.js recordAudit');
    // recordAudit 上方紧挨着它的文档注释块，插到注释之前
    let at = recIdx;
    while (at > 0 && !l[at - 1].trim().endsWith('*/')) at -= 1;
    l.splice(
      at,
      0,
      '/* ---------- 保留策略：防止 audit_log 无限膨胀 ----------',
      ' * 两个上限任一超出即裁剪：最多留 AUDIT_MAX_ROWS 条，且只留最近 AUDIT_RETENTION_DAYS 天。',
      ' * 可用同名环境变量覆盖（后台不提供 UI，避免站长把自己锁在门外时查不到历史）。',
      ' * 裁剪时机：',
      ' *   ① 写入路径上按计数节流（每 AUDIT_TRIM_EVERY 条执行一次 DELETE），避免每条都扫表；',
      ' *   ② 每次读取日志时也裁一次 —— 这样即使写入停了，历史也不会无限留着。',
      ' * 两条 DELETE 都走 idx_audit_created 索引。 */',
      'const AUDIT_MAX_ROWS = 5000;',
      'const AUDIT_RETENTION_DAYS = 90;',
      'const AUDIT_TRIM_EVERY = 50;',
      'let auditWrites = 0;',
      '',
      'function auditLimits(env) {',
      '  const rows = Number(env && env.AUDIT_MAX_ROWS);',
      '  const days = Number(env && env.AUDIT_RETENTION_DAYS);',
      '  return {',
      '    rows: Number.isFinite(rows) && rows >= 100 ? Math.floor(rows) : AUDIT_MAX_ROWS,',
      '    days: Number.isFinite(days) && days >= 1 ? Math.floor(days) : AUDIT_RETENTION_DAYS',
      '  };',
      '}',
      '',
      '/** 按保留策略裁剪审计日志（永不抛出） */',
      'export async function trimAuditLog(env) {',
      '  try {',
      '    if (!env || !env.DB) return;',
      '    const lim = auditLimits(env);',
      '    await dbRun(env.DB, \'DELETE FROM audit_log WHERE created_at < ?\', Date.now() - lim.days * 86400000);',
      '    await dbRun(env.DB,',
      '      \'DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?)\',',
      '      lim.rows);',
      '  } catch (e) { /* 裁剪失败不影响业务 */ }',
      '}',
      ''
    );

    // 6.2 recordAudit 内按计数节流裁剪
    const bodyIdx = l.findIndex((line) => line.includes('export async function recordAudit('));
    const catchIdx = (() => {
      for (let i = bodyIdx; i < l.length; i += 1) {
        if (l[i].includes('} catch (e) { /* 审计失败不影响业务 */ }')) return i;
      }
      return -1;
    })();
    if (catchIdx > 0 && !l.some((line) => line.includes('auditWrites % AUDIT_TRIM_EVERY'))) {
      l.splice(
        catchIdx,
        0,
        '    auditWrites += 1;',
        '    if (auditWrites % AUDIT_TRIM_EVERY === 0) await trimAuditLog(env);'
      );
    }

    // 6.3 读取日志时也裁一次
    const getIdx = l.findIndex((line) => line.includes("if (request.method === 'GET') {") &&
      l.slice(l.indexOf(line), l.indexOf(line) + 12).some((x) => x.includes('audit_log')));
    const handlerIdx = l.findIndex((line) => line.includes('export async function handleAuditLog('));
    for (let i = handlerIdx; i < l.length; i += 1) {
      if (l[i].includes("if (request.method === 'GET') {")) {
        l.splice(
          i + 1,
          0,
          '    // 读取时顺带按保留策略裁剪：即使写入已停止，历史也不会无限留着',
          '    await trimAuditLog(env);'
        );
        break;
      }
    }
    void getIdx;
  }

  // 6.4 登录失败也留痕（安全审计最关键的一项）
  if (!l.some((line) => line.includes("'admin.login.fail'"))) {
    const failIdx = l.findIndex((line) => line.includes("return json({ error: '密码错误' }, 401, request, env);"));
    if (failIdx < 0) throw new Error('锚点缺失: api-core.js 登录失败返回');
    l.splice(
      failIdx,
      0,
      '    // 登录失败也留痕（安全审计最关键的一项）。写入量由三层限流天然兜住：',
      '    // 同一 IP 15 分钟内最多 ADMIN_MAX_FAILS 次，之后直接 429 不再落库。',
      "    await recordAudit(env, request, 'admin.login.fail', breakGlass ? 'breakGlass' : 'password');"
    );
  }
});

/* ---------- 7. 文章新建 / 修改留痕（后台操作日志筛选里有这两项） ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  if (l.some((line) => line.includes("'post.create'"))) return;

  const createAnchor = l.findIndex((line) =>
    line.includes('return json({ ok: true, post: p }, 201, request, env);')
  );
  if (createAnchor >= 0) {
    l.splice(
      createAnchor,
      0,
      "    await recordAudit(env, request, 'post.create', p.id, p.status || 'published');"
    );
  }

  const updateAnchor = l.findIndex((line) =>
    line.includes('return json({ ok: true, post: p }, 200, request, env);')
  );
  if (updateAnchor >= 0) {
    l.splice(
      updateAnchor,
      0,
      '    const nextStatus = p.status || \'published\';',
      '    await recordAudit(env, request, \'post.update\', id,',
      "      oldStatus && oldStatus !== nextStatus ? oldStatus + ' → ' + nextStatus : nextStatus);"
    );
  }
});

/* ---------- 8. 登录 / 登出留痕 ---------- */
edit('app/functions/_lib/api-core.js', (l) => {
  if (l.some((line) => line.includes("'admin.login'"))) return;

  const firstLogin = l.findIndex((line) =>
    line.includes('return json({ ok: true, token, expiresIn: ADMIN_SESSION_TTL, mustChange: true, defaultPassword: defaultPwd }, 200, request, env);')
  );
  if (firstLogin >= 0) {
    l.splice(
      firstLogin,
      0,
      "    await recordAudit(env, request, 'admin.login', '', '首次部署 · 自动生成默认密码');"
    );
  }

  const normalLogin = l.findIndex((line) =>
    line.includes('return json({ ok: true, token, expiresIn: ADMIN_SESSION_TTL, mustChange: !!auth.mustChange }, 200, request, env);')
  );
  if (normalLogin >= 0) {
    l.splice(
      normalLogin,
      0,
      "    await recordAudit(env, request, 'admin.login', '', breakGlass ? 'breakGlass' : '');"
    );
  }

  const logout = l.findIndex((line) => line.includes('export async function handleAdminLogout('));
  if (logout >= 0) {
    for (let i = logout; i < l.length; i += 1) {
      if (l[i].includes('return json({ ok: true }, 200, request, env);')) {
        l.splice(i, 0, "  if (m) await recordAudit(env, request, 'admin.logout', '');");
        break;
      }
    }
  }
});

for (const line of log) console.log(line);