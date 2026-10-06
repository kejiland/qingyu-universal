import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pub = path.resolve('app/public');
const read = (name: string) => fs.readFileSync(path.join(pub, name), 'utf8');
const size = (name: string) => fs.statSync(path.join(pub, name)).size;

describe('公开站前端拆分（v0.7-b）', () => {
  it('index.html 通过轻量启动器加载，不再首屏直连整包 app.min.js', () => {
    const html = read('index.html');
    expect(html).toContain('boot.min.js?v=');
    expect(html).not.toContain('<script defer src="app.min.js');
  });

  it('启动器对 SSR 页面空闲加载，对无内容/后台路由立即加载', () => {
    const boot = read('boot.js');
    expect(boot).toContain('requestIdleCallback');
    expect(boot).toContain('.boot-load');
    expect(boot).toContain("'/write'");
    expect(boot).toContain("'/preview/'");
    expect(boot).toContain('/edit');
  });

  it('旧后台代码已从主包移出，只保留按需加载入口', () => {
    const app = read('app.js');
    const legacy = read('admin-legacy.js');
    expect(app).toContain('function ensureLegacyAdmin()');
    expect(app).toContain('admin-legacy.min.js');
    expect(app).not.toMatch(/function renderAdmin\s*\(/);
    expect(legacy).toMatch(/function renderAdmin\s*\(/);
    expect(legacy).toMatch(/function renderWrite\s*\(/);
  });

  it('压缩产物已生成：主包瘦身，回退包独立按需下载', () => {
    // 旧主包约 184 KB；拆出旧后台后应明显小于这个值。
    expect(size('app.min.js')).toBeLessThan(170 * 1024);
    expect(size('admin-legacy.min.js')).toBeGreaterThan(20 * 1024);
    expect(size('boot.min.js')).toBeLessThan(4 * 1024);
    expect(read('app.min.js')).toContain('admin-legacy.min.js');
    expect(read('admin-legacy.min.js')).toContain('function renderAdmin');
  });

  it('缓存清单包含新分包，版本号保持一致', () => {
    const app = read('app.js');
    const sw = read('sw.js');
    const version = app.match(/BLOG_VERSION\s*=\s*'([^']+)'/)?.[1];
    expect(version).toBeTruthy();
    expect(sw).toContain(`CACHE_VERSION = '${version}'`);
    expect(sw).toContain('./boot.min.js');
    expect(sw).toContain('./admin-legacy.min.js');
  });
});

describe('公开站视觉打磨（v0.8）', () => {
  it('index.html 在主样式之后加载独立叠加样式 polish.min.css', () => {
    const html = read('index.html');
    const main = html.indexOf('style.min.css?v=');
    const polish = html.indexOf('polish.min.css?v=');
    expect(main).toBeGreaterThan(-1);
    expect(polish).toBeGreaterThan(main);
    const app = read('app.js');
    const version = app.match(/BLOG_VERSION\s*=\s*'([^']+)'/)?.[1];
    expect(html).toContain('polish.min.css?v=' + version);
  });

  it('Service Worker 与缓存头都登记了 polish.min.css', () => {
    const sw = read('sw.js');
    const headers = read('_headers');
    expect(sw).toContain('./polish.min.css');
    expect(headers).toContain('/polish.min.css*');
    expect(headers).toMatch(/\/polish\.min\.css\*[\s\S]{0,120}immutable/);
  });

  it('叠加样式由构建脚本压缩产出', () => {
    expect(read('polish.css')).toContain('--accent');
    expect(read('polish.css')).toContain('prefers-reduced-motion');
    // 未压缩约 11 KB，压缩后必须显著变小
    expect(size('polish.min.css')).toBeLessThan(size('polish.css'));
    expect(read('polish.min.css')).toContain('--accent');
  });

  it('日期展示统一走 fmtDate，收敛成 YYYY-MM-DD', () => {
    const app = read('app.js');
    expect(app).toContain('function fmtDate(');
    expect(app).toContain('esc(fmtDate(p.date) || ');
    expect(app).toContain('esc(fmtDate(post.date) || ');
    expect(app).toContain('esc(fmtDate(c.date) || ');
    // 机器可读字段不能被动过
    expect(app).toContain("'datePublished': p.date || ''");
    expect(app).toContain('function rfc822(dateStr)');
  });

  it('SSR 与前端共用同一套日期规整规则', () => {
    expect(read('../../src/ssr/format.ts')).toContain('export function formatDate');
    const list = read('../../src/ssr/list.ts');
    const post = read('../../src/ssr/post.ts');
    expect(list).toContain('formatDate(post.date)');
    expect(post).toContain('formatDate(post.date)');
  });


  it('Service Worker 对带 ?v= 的静态资源按完整 URL 精确命中', () => {
    const sw = read('sw.js');
    expect(sw).toContain("searchParams.has('v')");
    expect(sw).toMatch(/var cached = await caches\.match\(request\);/);
    // 精确命中失败、且带版本号时，不允许退回 ignoreSearch（会吃到旧字节）
    expect(sw).toMatch(/if \(!cached && !versioned\) cached = await caches\.match\(request, \{ ignoreSearch: true \}\);/);
  });

  it('卡片摘要在 content 为空时回退到 search 全文', () => {
    expect(read('app.js')).toContain("stripMd(p.content || p.search || '')");
  });
});
