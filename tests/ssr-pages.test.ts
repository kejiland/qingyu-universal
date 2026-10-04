import { describe, expect, it } from 'vitest';
import {
  filterPosts,
  renderArchiveContent,
  renderCategoriesContent,
  renderTagsContent
} from '../src/ssr/pages.js';
import type { PostRow, SiteIdentity } from '../src/seo/meta.js';

const SITE: SiteIdentity = { name: '测试博客', description: '', author: '', avatar: '' };

function post(over: Partial<PostRow> & { id: string }): PostRow {
  return { title: '标题', date: '2026-08-15T00:00:00.000Z', status: 'published', ...over };
}

describe('公开站 SSR · 归档/标签/分类', () => {
  const posts = [
    post({ id: 'a', title: '八月文章', date: '2026-08-15T00:00:00.000Z', tags: '["SSR","归档"]', category: '教程' }),
    post({ id: 'b', title: '三月文章', date: '2025-03-02T00:00:00.000Z', tags: '["归档"]', category: '随笔' }),
    post({ id: 'c', title: '无日期文章', date: '' })
  ];

  it('归档按年与月分组，年倒序', () => {
    const html = renderArchiveContent(posts, SITE);
    expect(html).toContain('<h2 class="page-title">归档</h2>');
    expect(html).toContain('2026 年');
    expect(html).toContain('2025 年');
    expect(html.indexOf('2026 年')).toBeLessThan(html.indexOf('2025 年'));
    expect(html).toContain('8 月');
    expect(html).toContain('3 月');
    expect(html).toContain('<span class="count">1 篇</span>');
  });

  it('归档链接指向文章页，并忽略无日期文章', () => {
    const html = renderArchiveContent(posts, SITE);
    expect(html).toContain('href="/posts/a/"');
    expect(html).toContain('href="/posts/b/"');
    expect(html).not.toContain('无日期文章');
  });

  it('归档在没有任何文章时给出空态', () => {
    expect(renderArchiveContent([], SITE)).toContain('还没有文章');
  });

  it('标签云按名称排序并统计计数', () => {
    const html = renderTagsContent(posts, SITE);
    expect(html).toContain('<h2 class="page-title">标签</h2>');
    expect(html).toContain('class="tag-cloud"');
    expect(html).toContain('href="/?tag=SSR"');
    expect(html).toContain('href="/?tag=%E5%BD%92%E6%A1%A3"'); // 归档 的 URL 编码
    expect(html).toContain('<span class="cloud-count">2</span>'); // 「归档」出现两次
  });

  it('分类云使用 category 参数', () => {
    const html = renderCategoriesContent(posts, SITE);
    expect(html).toContain('<h2 class="page-title">分类</h2>');
    expect(html).toContain('href="/?category=%E6%95%99%E7%A8%8B"'); // 教程
    expect(html).toContain('href="/?category=%E9%9A%8F%E7%AC%94"'); // 随笔
  });

  it('标签与分类名经过 HTML 转义', () => {
    const evil = [post({ id: 'x', tags: '["<img src=x onerror=alert(1)>"]', category: '<b>粗</b>' })];
    const tags = renderTagsContent(evil, SITE);
    const cats = renderCategoriesContent(evil, SITE);
    expect(tags).not.toContain('<img src=x');
    expect(tags).toContain('&lt;img');
    expect(cats).not.toContain('<b>粗</b>');
  });

  it('filterPosts 按标签与分类过滤', () => {
    expect(filterPosts(posts, { tag: 'SSR' }).map((p) => p.id)).toEqual(['a']);
    expect(filterPosts(posts, { tag: '归档' }).map((p) => p.id)).toEqual(['a', 'b']);
    expect(filterPosts(posts, { category: '随笔' }).map((p) => p.id)).toEqual(['b']);
    expect(filterPosts(posts, {})).toHaveLength(3);
    expect(filterPosts(posts, { tag: '不存在' })).toEqual([]);
  });
});