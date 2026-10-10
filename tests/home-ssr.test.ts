/* ============================================================
 * 首页 SSR 与上游 app.js 的结构一致性
 * ------------------------------------------------------------
 * SSR 只是「首屏占位」，app.js 启动后会整块重绘 #app。
 * 两边结构一旦不同构：SSR 的优化全部作废，用户还会看到一次
 * 肉眼可见的布局跳变（卡片数、缩略图、标签行位置都会变）。
 * 这里把 app.js 里对应的类名钉住，上游改结构时本测试会先报警。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { renderHomeContent, type HomeOptions } from '../src/ssr/list.js';
import type { PostRow, SiteIdentity } from '../src/seo/meta.js';

const site = {} as SiteIdentity;

function post(over: Partial<PostRow> = {}): PostRow {
  return {
    id: 'p1',
    title: '第一篇',
    date: '2026-10-05T04:15:28.502Z',
    content: '正文内容',
    excerpt: '',
    tags: JSON.stringify(['生活', '随笔', '技术', '多余']),
    category: '随笔',
    pinned: 0,
    protected: 0,
    ...over
  } as PostRow;
}

describe('首页卡片：与 app.js renderCard() 同构', () => {
  it('置顶徽章用 .pin + 图标，而不是自定义的 .badge-pin', () => {
    const html = renderHomeContent([post({ pinned: 1 })], site, { pageSize: 0 });
    expect(html).toContain('<span class="pin">');
    expect(html).not.toContain('badge-pin');
  });

  it('标签是 .mini-tags 下的裸 span（CSS 只写了 .mini-tags span）', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0 });
    expect(html).toContain('<div class="mini-tags"><span>生活</span>');
    expect(html).not.toContain('mini-tag"');
  });

  it('卡片上最多 3 个标签', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0 });
    const mini = /<div class="mini-tags">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(mini.match(/<span>/g) ?? []).toHaveLength(3);
    expect(mini).not.toContain('多余');
  });

  it('有封面：span.post-thumb.has-img + alt + 淡入类', () => {
    const html = renderHomeContent([post({ cover: '/media/a.png' })], site, { pageSize: 0 });
    expect(html).toContain('<span class="post-thumb has-img">');
    expect(html).toContain('alt="第一篇"');
    expect(html).toContain("this.classList.add('thumb-in')");
    expect(html).not.toContain('<div class="post-thumb">');
  });

  it('无封面：给主题渐变占位（post-thumb ph），不靠图片加载撑高度', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0 });
    expect(html).toContain('<span class="post-thumb ph">');
    expect(html).toContain('post-thumb-ph');
  });

  it('正文首张图兜底当封面', () => {
    const html = renderHomeContent(
      [post({ content: '![a](https://cdn.example.com/1.png)' })],
      site,
      { pageSize: 0 }
    );
    expect(html).toContain('post-thumb has-img');
  });

  it('日期格式化为 YYYY-MM-DD，摘要兜底 100 字', () => {
    const long = '字'.repeat(300);
    const html = renderHomeContent([post({ content: long })], site, { pageSize: 0 });
    expect(html).toContain('<span class="date">2026-10-05</span>');
    const excerpt = /<div class="excerpt">([^<]*)<\/div>/.exec(html)?.[1] ?? '';
    expect(excerpt.length).toBe(100);
  });
});

describe('首页骨架：与 app.js renderHome() 同构', () => {
  it('列表容器 + 翻页器都由 SSR 给出', () => {
    const posts = Array.from({ length: 5 }, (_, i) => post({ id: 'p' + i, title: 'T' + i }));
    const html = renderHomeContent(posts, site, { pageSize: 2 });
    expect(html).toContain('<div id="listContainer">');
    expect(html).toContain('<div class="pager">');
    expect(html).toContain('第 1 / 3 页');
    expect(html).toContain('href="/?page=2"');
    expect(html).toContain('下一页');
  });

  it('不分页（pageSize=0）时用 list-nopager 补齐底部间距，且不渲染翻页器', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0 });
    expect(html).toContain('id="listContainer" class="list-nopager"');
    expect(html).not.toContain('class="pager"');
  });

  it('翻页链接保留当前标签/分类筛选', () => {
    const posts = Array.from({ length: 4 }, (_, i) => post({ id: 'p' + i }));
    const html = renderHomeContent(posts, site, { pageSize: 2, tag: '生活' });
    expect(html).toContain('tag=%E7%94%9F%E6%B4%BB&amp;page=2');
  });

  it('页码越界时收敛到最后一页，不渲染空白', () => {
    const posts = Array.from({ length: 3 }, (_, i) => post({ id: 'p' + i }));
    const html = renderHomeContent(posts, site, { pageSize: 2, page: 99 });
    expect(html).toContain('第 2 / 2 页');
  });

  it('标签行：标签 + 计数 + 白名单过滤', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0, homeTags: ['技术'] });
    expect(html).toContain('<div class="home-tags">');
    expect(html).toContain('<span class="home-tag-count">1</span>');
    expect(html).toContain('技术');
    // 白名单外的标签不出现在标签行里（卡片自身的 mini-tags 不受影响）
    const track = /<div class="home-tags-track">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(track).not.toContain('生活');
  });

  it('筛选条：?tag= / ?category= 显示当前筛选并可清除', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0, tag: '生活', category: '随笔' });
    expect(html).toContain('<div class="current-tag">');
    expect(html).toContain('<a class="tag-clear" href="/">✕</a>');
  });

  it('筛选后为空 → 筛选专属空态，不出现「本站还没有文章」', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0, tag: '不存在的标签' });
    expect(html).toContain('这里暂时还没有文章');
    expect(html).toContain('class="empty"');
  });

  it('广告位按后台配置原样插入', () => {
    const html = renderHomeContent([post()], site, { pageSize: 0, adsHtml: '<a href="#x">广告</a>' });
    expect(html).toContain('<div class="ad-slot">');
    expect(html).toContain('<a href="#x">广告</a>');
  });

  it('标题用上游的「最新发布」', () => {
    expect(renderHomeContent([post()], site, { pageSize: 0 })).toContain('最新发布');
  });
});

describe('与 app.js 的一致性由源码层面守住', () => {
  const app = fs.readFileSync('app/public/app.js', 'utf8');

  it('app.js 仍在用同一批类名（SSR 侧没跟上游脱节）', () => {
    for (const cls of [
      'class="pin"',
      'class="mini-tags"',
      'class="post-thumb has-img"',
      'class="post-thumb ph"',
      'id="listContainer"',
      'class="home-tags"',
      'class="home-tag-count"',
      'class="current-tag"',
      'class="pager-btn"',
      'list-nopager',
      'thumb-in'
    ]) {
      expect(app, `app.js 里找不到 ${cls}`).toContain(cls);
    }
  });

  it('上游结构函数名仍在（改名了本测试就该重写 SSR）', () => {
    for (const fn of ['function renderCard(', 'function renderHome(', 'function renderHomeTagRow(', 'function pagerHtml(']) {
      expect(app, `app.js 里找不到 ${fn}`).toContain(fn);
    }
  });
});