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
      '/** 本地模式返回同源相对公开地址，避免绑定某个访问域名。 */',
      'export function publicUrlForKey(env, key, base, request) {',
      "  const cleanKey = String(key || '').replace(/^\\/+/, '');",
      "  if (env && env.LOCAL_STORAGE) {",
      "    if (request && request.url) {",
      "      try { return new URL('/' + cleanKey, request.url).toString(); } catch (e) {}",
      '    }',
      "    return '/' + cleanKey;",
      '  }',
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

for (const line of log) console.log(line);
console.log('\n完成：新应用 ' + applied + ' 个文件，已是最新 ' + skipped + ' 个文件。');