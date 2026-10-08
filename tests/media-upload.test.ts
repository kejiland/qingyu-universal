/* ============================================================
 * 护栏：媒体上传的两条链不能断（缩略图真上传 / 复制有降级）
 * ------------------------------------------------------------
 * 背景（本文件就是为了不再犯）：Vue 后台的媒体页出过两个 bug。
 *
 * bug 1「能上传，刷新后预览没了」
 *   上传流程是：签发 ticket（含 thumbUploadUrl / thumbPublicUrl）→ PUT 原图
 *   → 登记元数据。当时只登记了 thumbPublicUrl，**从来没有 PUT 缩略图字节**，
 *   于是 thumb_url 指向一个空对象：上传当次列表用原图还能显示，
 *   刷新后列表改读 thumb_url 就 404。
 *   上游 app/public/admin.js 的 uploadImageAsset 是两步都 PUT 的：
 *     `if (packed.thumb && u.thumbUploadUrl) await put(u.thumbUploadUrl, ...)`
 *
 * bug 2「复制失败，请手动选择」
 *   复制只用了 `navigator.clipboard.writeText`。自托管站点常常是
 *   http://IP 或 http://域名，**不是安全上下文**，navigator.clipboard 整个不存在，
 *   直接抛 TypeError → 落入 catch → 弹「复制失败」。
 *   上游 admin.js 的 copyText() 是「Clipboard API → execCommand」两段式降级。
 *
 * 这里钉四件事：
 *   1. 压缩参数与上游逐条一致（2200/0.82 主图、640/0.76 缩略图、gif/svg/ico 不压）
 *   2. 缩略图必须真的 PUT 上去，且只有 PUT 成功才登记 thumbUrl
 *   3. 复制必须有 execCommand 降级，且不再裸用 navigator.clipboard
 *   4. 预览对历史坏 thumb_url 有回退（老数据不至于空白）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const IMAGE_TS = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'lib', 'image.ts'), 'utf8');
const MEDIA_VUE = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'views', 'MediaView.vue'), 'utf8');
const UPSTREAM_ADMIN = fs.readFileSync(path.join(ROOT, 'app', 'public', 'admin.js'), 'utf8');

/** 抓上游 compressImageFile 的函数体，用来对齐参数 */
function upstreamCompress(): string {
  const at = UPSTREAM_ADMIN.indexOf('async function compressImageFile');
  expect(at, '上游 admin.js 里找不到 compressImageFile——同步后位置可能变了').toBeGreaterThan(-1);
  const end = UPSTREAM_ADMIN.indexOf('\n  }\n', at);
  return UPSTREAM_ADMIN.slice(at, end < 0 ? at + 2000 : end);
}

describe('图片压缩 · 与上游参数一致', () => {
  const up = upstreamCompress();

  it('确实抓到了上游函数体（防止正则失效导致测试空转）', () => {
    expect(up).toContain('2200');
    expect(up).toContain('640');
  });

  it('主图 2200 / 0.82、缩略图 640 / 0.76，与上游一致', () => {
    expect(IMAGE_TS).toContain('resize(file, 2200, 0.82');
    expect(IMAGE_TS).toContain('resize(file, 640, 0.76');
    expect(up).toContain("resizeImageFile(file, 2200, 0.82, 'image/webp')");
    expect(up).toContain("resizeImageFile(file, 640, 0.76, 'image/webp')");
  });

  it('gif / svg / ico 不压缩也不生成缩略图（动图与矢量图压缩会丢信息）', () => {
    expect(IMAGE_TS).toMatch(/gif\|svg\|ico/);
    expect(up).toMatch(/gif\|svg\|ico/);
  });

  it('压缩后反而更大就保留原图（避免越压越大）', () => {
    expect(IMAGE_TS).toMatch(/main\.blob\.size >= file\.size/);
    expect(up).toMatch(/main\.blob\.size >= file\.size/);
  });

  it('缩略图命名与上游一致：<base>-thumb.webp', () => {
    expect(IMAGE_TS).toContain('-thumb.webp');
    expect(up).toContain("'-thumb.webp'");
  });
});

describe('媒体上传 · 缩略图必须真的把字节传上去', () => {
  it('有 PUT 缩略图的调用（不再只是一句注释）', () => {
    expect(
      MEDIA_VUE,
      'MediaView 里没有 PUT 缩略图的调用——又会变回「刷新后预览没了」'
    ).toMatch(/uploadTo\(\s*ticket\.thumbUploadUrl/);
  });

  it('只有缩略图上传成功才登记 thumbUrl（否则回退原图）', () => {
    expect(MEDIA_VUE).toContain('thumbOk');
    // 登记处必须是条件展开：thumbOk && ticket.thumbPublicUrl
    expect(MEDIA_VUE).toMatch(/thumbOk\s*&&\s*ticket\.thumbPublicUrl/);
  });

  it('签发 ticket 时用压缩后的文件名与 makeThumb 标记（与上游一致）', () => {
    expect(MEDIA_VUE).toMatch(/api\.uploadTicket\(\s*mainFile\.name,\s*mainFile\.size,\s*!!packed\.thumb/);
    expect(UPSTREAM_ADMIN).toContain('makeThumb: !!packed.thumb');
  });

  it('上传完重新拉列表（拿到的才是服务端真实记录）', () => {
    expect(MEDIA_VUE).toMatch(/await load\(\);\s*\n\s*toast\.success/);
  });

  it('预览对取不到的缩略图回退原图（老数据不至于空白）', () => {
    expect(MEDIA_VUE).toContain('brokenThumbs');
    expect(MEDIA_VUE).toMatch(/previewUrl\(item\)/);
    expect(MEDIA_VUE).toMatch(/@error="onThumbError\(item\)"/);
  });
});

describe('复制 · 必须有 execCommand 降级', () => {
  it('有 copyText() 两段式降级函数', () => {
    expect(
      MEDIA_VUE,
      '没有 execCommand 降级——http 非安全上下文下 navigator.clipboard 不存在，会一直提示复制失败'
    ).toMatch(/execCommand\(\s*'copy'\s*\)/);
  });

  it('优先走 Clipboard API，且调用点必须先做存在性判断', () => {
    // http 非安全上下文下 navigator.clipboard 整个不存在，
    // 裸写 `await navigator.clipboard.writeText(...)` 会抛 TypeError。
    // 所以顺序必须是：先 `if (navigator.clipboard?.writeText)` 判断，再调用。
    const guard = MEDIA_VUE.indexOf('navigator.clipboard?.writeText');
    const call = MEDIA_VUE.indexOf('navigator.clipboard.writeText(');
    expect(guard, '缺少 navigator.clipboard?.writeText 存在性判断').toBeGreaterThan(-1);
    expect(call, '缺少真正的 writeText 调用').toBeGreaterThan(-1);
    expect(guard, 'writeText 调用跑到了存在性判断之前').toBeLessThan(call);
  });

  it('复制 MD 与复制链接都走 copyText()', () => {
    const md = /async function copyMarkdown[\s\S]*?await copyText\(/;
    const link = /async function copy\([\s\S]*?await copyText\(/;
    expect(MEDIA_VUE, 'copyMarkdown 没走 copyText()').toMatch(md);
    expect(MEDIA_VUE, 'copy() 没走 copyText()').toMatch(link);
  });

  it('上游同样是两段式降级（口径一致）', () => {
    expect(UPSTREAM_ADMIN).toMatch(/execCommand\(\s*'copy'\s*\)/);
  });
});
