import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createD1, type D1Database } from '../src/bindings/d1.js';
import {
  absolutize,
  buildArticleMeta,
  buildHomeMeta,
  escapeHtml,
  escapeJsonForScript,
  injectHead,
  readSiteIdentity,
  renderHeadBlock,
  stripMarkdown,
  type PostRow,
  type SiteIdentity
} from '../src/seo/meta.js';

const SITE: SiteIdentity = {
  name: '测试博客',
  description: '一个用于测试的站点',
  author: '张三',
  avatar: 'https://cdn.example.com/avatar.png'
};
const SITE_URL = 'https://blog.example.com';

describe('SEO · 文本处理', () => {
  it('stripMarkdown 与前端实现保持一致', () => {
    const md = '# 标题\n\n这是**加粗**的文字，还有 `代码` 与 [链接](https://x.com)。\n\n```\n代码块\n```\n\n> 引用\n- 列表项';
    const text = stripMarkdown(md);
    expect(text).toContain('标题');
    expect(text).toContain('加粗');
    expect(text).not.toContain('**');
    expect(text).not.toContain('#');
    expect(text).not.toContain('代码块');
    expect(text).not.toContain('https://x.com');
  });

  it('escapeHtml 阻断属性逃逸', () => {
    expect(escapeHtml('a"b<c>d&e\'f')).toBe('a&quot;b&lt;c&gt;d&amp;e&#39;f');
  });

  it('escapeJsonForScript 阻断 </script> 逃逸', () => {
    const out = escapeJsonForScript({ title: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c');
  });

  it('absolutize 补全相对地址', () => {
    expect(absolutize('/media/a.png', SITE_URL)).toBe('https://blog.example.com/media/a.png');
    expect(absolutize('media/a.png', SITE_URL)).toBe('https://blog.example.com/media/a.png');
    expect(absolutize('//cdn.example.com/a.png', SITE_URL)).toBe('https://cdn.example.com/a.png');
    expect(absolutize('https://other.com/a.png', SITE_URL)).toBe('https://other.com/a.png');
    expect(absolutize('', SITE_URL)).toBe('');
  });
});

describe('SEO · 文章元数据', () => {
  const basePost: PostRow = {
    id: 'hello-world',
    title: '你好，世界',
    date: '2026-01-02T03:04:05.000Z',
    excerpt: '这是一段摘要',
    content: '# 正文标题\n\n这里是很长的正文内容。',
    cover: '/media/cover.png',
    og_image: '',
    tags: '["技术","随笔"]',
    seo: '',
    status: 'published',
    protected: 0,
    updated_at: '2026-02-03T00:00:00.000Z'
  };

  it('默认使用 标题 · 站点名，并生成绝对 canonical', () => {
    const meta = buildArticleMeta(basePost, SITE, SITE_URL);
    expect(meta.title).toBe('你好，世界 · 测试博客');
    expect(meta.canonical).toBe('https://blog.example.com/posts/hello-world/');
    expect(meta.ogType).toBe('article');
    expect(meta.ogImage).toBe('https://blog.example.com/media/cover.png');
    expect(meta.tags).toEqual(['技术', '随笔']);
  });

  it('文章级 SEO 覆盖优先于自动生成', () => {
    const meta = buildArticleMeta(
      { ...basePost, seo: JSON.stringify({ title: '自定义标题', desc: '自定义描述', canonical: 'https://short.example.com/x', noindex: true }) },
      SITE,
      SITE_URL
    );
    expect(meta.title).toBe('自定义标题');
    expect(meta.description).toBe('自定义描述');
    expect(meta.canonical).toBe('https://short.example.com/x');
    expect(meta.robots).toBe('noindex, nofollow');
  });

  it('描述回退顺序：摘要 → 正文纯文本 → 站点简介', () => {
    expect(buildArticleMeta(basePost, SITE, SITE_URL).description).toBe('这是一段摘要');

    const noExcerpt = buildArticleMeta({ ...basePost, excerpt: '' }, SITE, SITE_URL);
    expect(noExcerpt.description).toContain('正文标题');

    const empty = buildArticleMeta({ ...basePost, excerpt: '', content: '' }, SITE, SITE_URL);
    expect(empty.description).toBe('一个用于测试的站点');
  });

  it('受保护文章：不泄露正文且强制 noindex', () => {
    const meta = buildArticleMeta(
      { ...basePost, protected: 1, content: '', excerpt: '公开摘要' },
      SITE,
      SITE_URL
    );
    expect(meta.robots).toBe('noindex, nofollow');
    expect(meta.description).toBe('公开摘要');
    expect(meta.canonical).toBe('https://blog.example.com/posts/hello-world/');
  });

  it('JSON-LD 为 BlogPosting 且含必需字段', () => {
    const meta = buildArticleMeta(basePost, SITE, SITE_URL);
    expect(meta.jsonLd['@type']).toBe('BlogPosting');
    expect(meta.jsonLd.headline).toBe('你好，世界');
    expect(meta.jsonLd.datePublished).toBe(basePost.date);
    expect(meta.jsonLd.dateModified).toBe(basePost.updated_at);
    expect((meta.jsonLd.author as { name: string }).name).toBe('张三');
    expect(meta.jsonLd.image).toBe('https://blog.example.com/media/cover.png');
  });

  it('设置 og_image 时优先于 cover', () => {
    const meta = buildArticleMeta({ ...basePost, og_image: 'https://cdn.example.com/og.png' }, SITE, SITE_URL);
    expect(meta.ogImage).toBe('https://cdn.example.com/og.png');
  });
});

describe('SEO · 首页元数据', () => {
  it('canonical 与 og:url 都是绝对地址', () => {
    const meta = buildHomeMeta(SITE, SITE_URL);
    expect(meta.canonical).toBe('https://blog.example.com/');
    expect(meta.ogUrl).toBe('https://blog.example.com/');
    expect(meta.ogType).toBe('website');
    expect(meta.jsonLd['@type']).toBe('WebSite');
  });
});

describe('SEO · HTML 注入', () => {
  const shell = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<meta name="description" content="旧的写死描述">
<meta name="robots" content="index, follow">
<meta name="author" content="Qingyu">
<title>Qingyu'Blog · 轻量博客</title>
<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:title" content="旧标题">
<meta property="og:url" content="/">
<!-- Canonical -->
<link rel="canonical" href="/">
<script type="application/ld+json">
{"@type":"WebSite","name":"旧站点"}
</script>
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
</head><body><div id="app"></div></body></html>`;

  it('替换写死的标签，保留 charset / viewport / RSS', () => {
    const meta = buildArticleMeta(
      { id: 'p1', title: '新文章', excerpt: '新摘要', status: 'published', tags: '["x"]' },
      SITE,
      SITE_URL
    );
    const html = injectHead(shell, meta, renderHeadBlock(meta));

    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('rss+xml');

    expect(html).not.toContain('旧的写死描述');
    expect(html).not.toContain('旧标题');
    expect(html).not.toContain('旧站点');
    expect(html).toContain('<title>新文章 · 测试博客</title>');
    expect(html).toContain('content="https://blog.example.com/posts/p1/"');
    expect(html).toContain('"@type":"BlogPosting"');

    // head 里只应有一份 canonical 与一份 description
    expect((html.match(/rel="canonical"/g) ?? []).length).toBe(1);
    expect((html.match(/name="description"/g) ?? []).length).toBe(1);
    expect((html.match(/application\/ld\+json/g) ?? []).length).toBe(1);
  });

  it('恶意标题无法逃逸出属性或 script 标签', () => {
    const meta = buildArticleMeta(
      { id: 'x', title: '"><script>alert(1)</script>', excerpt: '"><img src=x onerror=alert(1)>', status: 'published' },
      SITE,
      SITE_URL
    );
    const html = injectHead(shell, meta, renderHeadBlock(meta));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('SEO · 站点身份', () => {
  let dir: string;
  let db: D1Database;
  let tmp: string;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-seo-'));
    db = createD1(path.join(tmp, 'seo.db'));
    db.native.exec('CREATE TABLE site_settings (k TEXT PRIMARY KEY, v TEXT)');
    dir = tmp;
  });

  afterEach(() => {
    db.close();
  });

  it('无设置时回退到默认站点名', async () => {
    // 传空 publicDir：本组只验证 site_settings 侧，不受仓库里 config.min.js 影响
    const site = await readSiteIdentity(db, tmp);
    expect(site.name).toBe("Qingyu'Blog");
    expect(site.author).toBe("Qingyu'Blog");
  });

  it('site_info.name 优先于版权署名', async () => {
    // 键名必须是 `site_info`：前台 app.js:1026 读的就是 s.site_info，
    // 后台保存的也是这个键。早先测试用 `site` 断言，等于把读错键的 bug 锁死了。
    db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('site_info', JSON.stringify({ name: '我的博客', desc: '我的简介' }));
    const site = await readSiteIdentity(db, tmp);
    expect(site.name).toBe('我的博客');
    expect(site.description).toBe('我的简介');
  });

  it('站点名缺失时用 site_info.copyright 顶替（app.js getSiteName 的第二级回退）', async () => {
    db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('site_info', JSON.stringify({ copyright: '版权署名' }));
    const site = await readSiteIdentity(db, tmp);
    expect(site.name).toBe('版权署名');
  });

  it('写成 `site` / `footer` 键时不被采用（防止再退回旧键名）', async () => {
    // `site` 不是合法键（应为 site_info）；
    // `footer` 也不是 site_settings 的键——app.js 的 cfg.footer 取自静态 config.js，
    // 后台只把 site_info.copyright / site_info.footerText 叠加进去。
    db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('site', JSON.stringify({ name: '错误的键', desc: '不该被读到' }));
    db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('footer', JSON.stringify({ copyrightName: '页脚名' }));
    const site = await readSiteIdentity(db, tmp);
    expect(site.name).toBe("Qingyu'Blog");
    expect(site.description).not.toBe('不该被读到');
  });

  it('profile.name 作为作者名', async () => {
    db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('profile', JSON.stringify({ name: '李四' }));
    expect((await readSiteIdentity(db, tmp)).author).toBe('李四');
  });

  it('损坏的 JSON 不会抛错', async () => {
    db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('site_info', '{坏掉的 json');
    await expect(readSiteIdentity(db, tmp)).resolves.toBeDefined();
    expect((await readSiteIdentity(db, tmp)).name).toBe("Qingyu'Blog");
  });
});

describe('SEO · 草稿/未找到回退', () => {
  it('站点级回退标记 noindex（草稿不会被索引）', () => {
    const meta = buildHomeMeta(SITE, SITE_URL, { noindex: true });
    expect(meta.robots).toBe('noindex, nofollow');
    // 仍然是站点级信息，不含任何文章内容
    expect(meta.title).toBe('测试博客');
    expect(meta.canonical).toBe('https://blog.example.com/');
  });

  it('默认（首页）仍然是可索引的', () => {
    expect(buildHomeMeta(SITE, SITE_URL).robots).toContain('index, follow');
  });

  it('文章页 seo.title 是完整替换，不追加站点名（与前端一致）', () => {
    const meta = buildArticleMeta(
      { id: 'p', title: '原标题', status: 'published', seo: JSON.stringify({ title: '完全自定义' }) },
      SITE,
      SITE_URL
    );
    expect(meta.title).toBe('完全自定义');
  });

  it('未设置 seo.title 时追加站点名（与前端一致）', () => {
    const meta = buildArticleMeta({ id: 'p', title: '原标题', status: 'published' }, SITE, SITE_URL);
    expect(meta.title).toBe('原标题 · 测试博客');
  });
});
