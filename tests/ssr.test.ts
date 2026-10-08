import { describe, expect, it } from 'vitest';
import { injectAppContent, renderMarkdown, renderPostContent } from '../src/ssr/post.js';
import type { PostRow, SiteIdentity } from '../src/seo/meta.js';

const SITE: SiteIdentity = { name: '测试博客', description: '简介', author: '作者', avatar: '' };
const SHELL = `<!doctype html><html><head></head><body>
<div id="app">
    <div class="boot-load" id="bootLoad">
      <div class="boot-ring"></div>
      <div class="boot-dot"></div>
      <div class="boot-name">加载中</div>
    </div>
  </div>
</body></html>`;

const POST: PostRow = {
  id: 'hello',
  title: '你好世界',
  date: '2026-01-02',
  excerpt: '摘要',
  content: '# 一级标题\n\n这是**正文**段落。\n\n```js\nconst a = 1;\n```',
  tags: '["技术","随笔"]',
  series: '入门系列',
  category: '教程',
  status: 'published',
  protected: 0
};

describe('公开站 SSR', () => {
  it('renderMarkdown 输出真实 HTML', () => {
    const html = renderMarkdown('# 标题\n\n**加粗**');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>加粗</strong>');
  });

  it('injectAppContent 替换启动动画、保留 #app 容器', () => {
    const out = injectAppContent(SHELL, '<p>SSR</p>');
    expect(out).not.toContain('boot-load');
    expect(out).toContain('<div id="app">');
    expect(out).toContain('<p>SSR</p>');
    // #app 仍只有一层闭合
    expect(out).toContain('</div>\n</body>');
  });

  it('renderPostContent 产出与 SPA 同构的标记', () => {
    const html = renderPostContent(POST, SITE)!;
    expect(html).toContain('<main class="container page-fade">');
    expect(html).toContain('<div class="post-body">');
    expect(html).toContain('<div class="post-header">');
    expect(html).toContain('<h1>你好世界</h1>');
    expect(html).toContain('<span class="meta-date">2026-01-02</span>');
    expect(html).toContain('<article class="article">');
    // 正文真的被渲染进去了（这是整个改动的意义）
    expect(html).toContain('<strong>正文</strong>');
    expect(html).toContain('入门系列');
  });

  // 与上游一致：受保护文章**同样渲染标题/meta/锁屏**，只是把正文换成密码解锁界面。
  // 早期这里 return null 让整页掉回外壳，反而与 app.js 的 renderPost 不同构——
  // 首屏没有任何标题，app.js 接管后又冒出一个标题 + 锁屏。
  it('受保护文章渲染锁屏、不注入任何明文正文', () => {
    const html = renderPostContent({ ...POST, protected: 1, content: '' }, SITE)!;
    expect(html).toBeTruthy();
    expect(html).toContain('<div class="post-lock" id="postLock">');
    expect(html).toContain('<article class="article" id="postArticle" style="display:none"></article>');
    // 明文绝不出库：既没有真正的 .article 正文节点，也没有 aipost 槽位
    expect(html).not.toContain('<strong>正文</strong>');
    expect(html).not.toContain('ai-post-slot');
    expect(html).not.toContain('<details class="toc">');
  });

  it('标题与标签经过 HTML 转义', () => {
    const html = renderPostContent(
      { ...POST, title: '<script>alert(1)</script>', tags: '["<img src=x>"]' },
      SITE
    )!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('完整链路：#app 里是正文而不是加载动画', () => {
    const out = injectAppContent(SHELL, renderPostContent(POST, SITE)!);
    expect(out).not.toContain('boot-load');
    expect(out).toContain('<strong>正文</strong>');
  });
});