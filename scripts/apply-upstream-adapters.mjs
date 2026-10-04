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
  const i = lines.findIndex((l) => l.includes(match));
  if (i < 0) throw new Error('锚点缺失: ' + match);
  if (replacement.some((r) => lines.includes(r))) return;
  lines.splice(i, 1, ...replacement);
}

/* ---------- 对象存储：本地磁盘适配器 ---------- */
edit('app/functions/_lib/music.js', (l) => {
  insertAfter(l, 'export async function presignPut(env, key, expiresSec, bucket, contentType) {',
    '  // [self-host] 未配置 S3 时，改由本地磁盘签名上传端点承接',
    '  if (env && env.LOCAL_STORAGE) return env.LOCAL_STORAGE.presignPut(env, key, expiresSec, bucket, contentType);');
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

for (const line of log) console.log(line);
console.log('\n完成：新应用 ' + applied + ' 个文件，已是最新 ' + skipped + ' 个文件。');