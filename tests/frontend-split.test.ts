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
