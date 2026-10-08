/* ============================================================
 * 护栏：/admin 导航不被 Service Worker 拦截
 * ------------------------------------------------------------
 * 背景（2026-10-08 真实事故）：SW 的导航策略是「网络优先、失败回退
 * 公开站外壳」。用户打开 /admin/posts/new 时恰逢容器重启，fetch 失败，
 * SW 用缓存的公开站外壳顶上 —— boot.js 检测到 /admin 路径就加载
 * admin-legacy 旧后台，于是同一个地址「第一次打开是旧后台、刷新后
 * 变新后台」，看起来像「有旧数据没清」。
 *
 * 修复：/admin 开头的导航直接放行（return，不 respondWith），
 * 让浏览器走网络 —— 后台是在线应用，离线回退对它只有坏处。
 *
 * 本测试钉住三件事：
 *   1. 放行规则存在且作用于 navigate 分支；
 *   2. 放行判断在 networkFirstNavigation 之前（顺序错了等于没修）；
 *   3. networkFirstNavigation 的回退仍只面向公开站（壳可以离线，后台不可以）。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('app/public');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('SW 对 /admin 导航放行', () => {
  const sw = read('sw.js');

  it('navigate 分支里有 /admin 放行规则', () => {
    const navigateBranch = sw.slice(sw.indexOf("request.mode === 'navigate'"));
    expect(navigateBranch).toContain("url.pathname === '/admin'");
    expect(navigateBranch).toContain("url.pathname.indexOf('/admin/') === 0");
  });

  it('放行判断必须先于 respondWith（否则回退仍会发生）', () => {
    // 注意：networkFirstApi 的函数定义在 fetch handler 之前，
    // 起点/终点都要从 handler 内部找，否则切片为空、断言空转。
    const handlerStart = sw.indexOf("self.addEventListener('fetch'");
    const branchStart = sw.indexOf("request.mode === 'navigate'", handlerStart);
    const branchEnd = sw.indexOf('networkFirstApi', branchStart);
    const branch = sw.slice(branchStart, branchEnd);
    const bypass = branch.indexOf("/admin/");
    const respond = branch.indexOf('respondWith');
    expect(bypass).toBeGreaterThan(-1);
    expect(respond).toBeGreaterThan(-1);
    expect(bypass).toBeLessThan(respond);
  });

  it('公开站的离线回退保留（只限制后台，不误伤正常离线能力）', () => {
    expect(sw).toContain('function networkFirstNavigation');
    expect(sw).toContain("shell.match('./index.html'");
  });

  it('缓存版本与 BLOG_VERSION 一致（升级缓存时不能只改一处）', () => {
    const version = read('app.js').match(/BLOG_VERSION\s*=\s*'([^']+)'/)?.[1];
    expect(version).toBeTruthy();
    expect(sw).toContain(`CACHE_VERSION = '${version}'`);
  });
});
