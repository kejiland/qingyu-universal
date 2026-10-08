/* ============================================================
 * 护栏：评论管理「全部 ↔ 待审核」必须双向同步
 * ------------------------------------------------------------
 * 事故（2026-10-08 真机复现）：/comments 与 /comments/pending 共用
 * CommentsView.vue，Vue Router 复用同一实例、onMounted 不再触发，
 * 而 watch 只写了「进入 pending 时置 pending」这一个方向。
 * 结果点侧栏「全部评论」后：URL 变成 /admin/comments、页头变成「全部评论」，
 * 但列表筛选仍停在「待审核」—— 用户看到的就是「回不到全部评论」。
 *
 * 钉住四件事：
 *   1. watch 双向：既认 comments-pending，也认 comments（反向能拉回 all）；
 *   2. 反向只在当前是 pending 时拉回，不覆盖「已通过」（它没有独立路由）；
 *   3. 页签点击走 selectTab，而不是直接改 status（否则 URL 与页签会脱节）；
 *   4. selectTab 会把 pending 推到 /comments/pending、其余推到 /comments。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('admin/src/views/CommentsView.vue'), 'utf8');

/** 取 watch(() => route.name, ...) 的回调体，避免断言命中别处的同名字符串 */
function routeWatchBody(): string {
  const start = src.indexOf("() => route.name");
  expect(start).toBeGreaterThan(-1);
  const tail = src.indexOf('{ immediate: true }', start);
  expect(tail).toBeGreaterThan(-1);
  return src.slice(start, tail);
}

describe('评论管理 全部/待审核 双向同步', () => {
  it('watch 认得两个方向（不是只进不回）', () => {
    const body = routeWatchBody();
    expect(body).toContain("'comments-pending'");
    expect(body).toContain("'comments'");
    expect(body).toContain("'pending'");
    expect(body).toContain("'all'");
  });

  it('反向拉回只在当前是 pending 时发生（不覆盖「已通过」）', () => {
    const body = routeWatchBody();
    // 形如：else if (name === 'comments' && status.value === 'pending')
    expect(body).toMatch(/name === 'comments'\s*&&\s*status\.value === 'pending'/);
  });

  it('页签点击走 selectTab（URL 与页签一起走）', () => {
    expect(src).toContain('async function selectTab');
    expect(src).toContain('@click="selectTab(tab[0])"');
    expect(src).not.toMatch(/@click="status\s*=\s*tab\[0\]"/);
  });

  it('selectTab 的路由映射：pending → comments-pending，其余 → comments', () => {
    const fn = src.slice(src.indexOf('async function selectTab'));
    expect(fn).toMatch(/next === 'pending'\s*\?\s*'comments-pending'\s*:\s*'comments'/);
    expect(fn).toContain('router.push');
  });

  it('不再只在 onMounted 里单向置 pending（onMounted 复用实例时不触发）', () => {
    const mounted = src.slice(src.indexOf('onMounted('));
    expect(mounted).not.toContain("status.value = 'pending'");
  });
});
