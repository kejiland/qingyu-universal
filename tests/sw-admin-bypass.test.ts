/* ============================================================
 * 护栏：/admin 的任何请求都不被 Service Worker 拦截
 * ------------------------------------------------------------
 * 背景（2026-10-08 两次真实事故，同一个地址「换一副面孔」）：
 *
 *   第一次：SW 的导航策略是「网络优先、失败回退公开站外壳」。容器重启
 *   的瞬间 fetch 失败，SW 用缓存的公开站外壳顶上 —— boot.js 检测到
 *   /admin 就加载 admin-legacy 旧后台，于是「旧后台」凭空出现。
 *
 *   第二次：只放行 navigate 仍不够。/admin/assets/*.js 是脚本请求，
 *   会落到 staleWhileRevalidate ——「先喂缓存、后台再更新」天然就是
 *   「第一次打开旧版、刷新才新版」；再叠加旧版 SW 要等下一次导航才
 *   被新版本接管，整整差一拍，表现为「新打开旧后台、刷新后新后台」。
 *
 * 修复：把 /admin 放行提到 request.mode 分支之前，覆盖所有请求类型。
 *
 * 本测试钉住四件事：
 *   1. 放行规则存在，且在 navigate 分支之前（顶层，覆盖所有 mode）；
 *   2. 放行判断在静态资源分支之前（否则脚本请求仍会被 staleWhileRevalidate）；
 *   3. 网络回退仍只面向公开站（壳可以离线，后台不可以）；
 *   4. 缓存版本与 BLOG_VERSION 一致（抬版本清旧缓存时不能只改一处）。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('app/public');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('SW 对 /admin 全面放行', () => {
  const sw = read('sw.js');
  const handlerStart = sw.indexOf("self.addEventListener('fetch'");
  const handler = sw.slice(handlerStart);

  it('放行规则在 navigate 分支之前（顶层，覆盖所有 request.mode）', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    const navigateAt = handler.indexOf("request.mode === 'navigate'");
    const bypassAt = handler.indexOf("url.pathname.indexOf('/admin/') === 0");
    expect(navigateAt).toBeGreaterThan(-1);
    expect(bypassAt).toBeGreaterThan(-1);
    expect(bypassAt).toBeLessThan(navigateAt);
  });

  it('放行判断在静态资源分支之前（脚本请求不能走 staleWhileRevalidate）', () => {
    const staticAt = handler.indexOf('isStaticAsset');
    const bypassAt = handler.indexOf("url.pathname.indexOf('/admin/') === 0");
    expect(staticAt).toBeGreaterThan(-1);
    expect(bypassAt).toBeGreaterThan(-1);
    expect(bypassAt).toBeLessThan(staticAt);
  });

  it('放行用 return 直接退出，不 respondWith（后台没有离线副本）', () => {
    const bypassAt = handler.indexOf("url.pathname.indexOf('/admin/') === 0");
    const line = handler.slice(bypassAt, handler.indexOf('\n', bypassAt));
    expect(line).toContain('return');
    expect(line).not.toContain('respondWith');
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
