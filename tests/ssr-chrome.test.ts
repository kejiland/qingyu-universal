import { describe, expect, it } from 'vitest';
import { readChrome, renderFooter, renderTopbar, wrapWithChrome, type ChromeData } from '../src/ssr/chrome.js';
import { createD1 } from '../src/bindings/d1.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME: ChromeData = {
  siteName: '测试博客',
  nav: [
    { text: '首页', url: '/' },
    { text: '归档', url: '/archive' }
  ],
  navDefaultsVersion: 1,
  navExtras: true,
  footerNav: [],
  pageSize: 8,
  homeTags: [],
  footer: {
    copyrightName: '测试博客',
    startYear: '2020',
    icp: '京ICP备123号',
    text: '',
    decl: '',
    email: '',
    friends: []
  }
};

/** 后台「顶部导航」按内置 9 项 + 自定义分类保存时的形态（版本号已同步）。 */
const CONFIGURED: ChromeData = {
  ...CHROME,
  nav: [
    { text: '首页', url: '/' },
    { text: '标签', url: '/tags' },
    {
      text: '分类',
      url: '/categories',
      children: [
        { text: '后端', url: '' },
        { text: '设计', url: '' }
      ]
    },
    { text: '历史', url: '/history' },
    { text: '系列', url: '/series' },
    { text: '热门', url: '/popular' },
    { text: '归档', url: '/archive' },
    { text: '留言板', url: '/guestbook' },
    { text: '关于', url: '/about' }
  ]
};

describe('公开站 SSR · 站点框架', () => {
  it('顶栏结构与 app.js 对齐', async () => {
    const html = renderTopbar(CHROME, '/');
    expect(html).toContain('<header class="topbar">');
    expect(html).toContain('<div class="container topbar-inner">');
    expect(html).toContain('<div class="topbar-left">');
    expect(html).toContain('<a class="brand" href="/">测试博客</a>');
    expect(html).toContain('<nav class="main-nav">');
    expect(html).toContain('<div class="topbar-actions">');
    // 5 个占位图标按钮（搜索 / 语言 / 配色 / 背景动画 / 主题）：
    // CSS 给了 .icon-btn 固定尺寸，能占住空间；语言与配色各带一个定位容器
    expect((html.match(/<button class="icon-btn/g) ?? []).length).toBe(5);
    expect(html).toContain('<div class="lang-wrap" id="langWrap">');
    expect(html).toContain('<div class="accent-wrap" id="accentWrap">');
  });

  it('当前路径的导航项高亮', async () => {
    expect(renderTopbar(CHROME, '/archive')).toContain('href="/archive" class="nav-link active"');
    // 根路径只精确匹配 '/'，不会把 /archive 也点亮
    const home = renderTopbar(CHROME, '/');
    expect(home).toContain('href="/" class="nav-link active"');
    expect(home).not.toContain('href="/archive" class="nav-link active"');
  });

  it('一级导航只留首页/分类/归档等，内置四项收进「发现」下拉', async () => {
    const html = renderTopbar(CONFIGURED, '/');
    const nav = html.slice(html.indexOf('<nav class="main-nav">'), html.indexOf('</nav>'));

    // 「发现」是点击展开的下拉（button，不带跳转）
    expect(nav).toContain('class="nav-link nav-dropdown-trigger"');
    expect(nav).toContain('aria-controls="navExploreMenu">发现<');
    // 四个内置项按后台顺序进入下拉，且带 role="menuitem"
    for (const [text, url] of [
      ['标签', '/tags'],
      ['历史', '/history'],
      ['系列', '/series'],
      ['热门', '/popular']
    ]) {
      expect(nav).toContain(`href="${url}" class="nav-link" role="menuitem">${text}</a>`);
    }
    // 它们不再以一级导航项出现
    expect(nav).not.toContain('<div class="nav-item"><a href="/tags"');
    expect(nav).not.toContain('<div class="nav-item"><a href="/popular"');
    expect(nav).toContain('<div class="nav-item"><a href="/archive" class="nav-link">归档</a></div>');
  });

  it('「分类」是带二级菜单的一级入口，子项链接指向按分类筛选的列表', async () => {
    const html = renderTopbar(CONFIGURED, '/?category=设计');
    expect(html).toContain('href="/categories" class="nav-link" data-nav-dropdown-trigger="true"');
    expect(html).toContain('href="/?category=%E5%90%8E%E7%AB%AF"');
    // 当前分类高亮
    expect(html).toContain('href="/?category=%E8%AE%BE%E8%AE%A1" class="nav-link active"');
  });

  it('discover:false 的内置项留在一级导航（三态开关）', async () => {
    const chrome: ChromeData = {
      ...CHROME,
      nav: [
        { text: '首页', url: '/' },
        { text: '标签', url: '/tags', discover: false }
      ]
    };
    const html = renderTopbar(chrome, '/');
    expect(html).toContain('<div class="nav-item"><a href="/tags" class="nav-link">标签</a></div>');
    expect(html).not.toContain('navExploreMenu');
  });

  it('「显示新增导航项」关闭时隐藏历史/系列/热门', async () => {
    const html = renderTopbar({ ...CONFIGURED, navExtras: false }, '/');
    expect(html).not.toContain('href="/history"');
    expect(html).not.toContain('href="/series"');
    expect(html).not.toContain('href="/popular"');
  });

  it('页脚含导航、版权与备案号', async () => {
    const html = renderFooter(CHROME);
    expect(html).toContain('<footer><div class="container footer-inner">');
    expect(html).toContain('class="footer-nav"');
    expect(html).toContain('class="footer-copy"');
    expect(html).toContain('测试博客');
    expect(html).toContain(`2020-${new Date().getFullYear()}`); // 起始年份区间
    expect(html).toContain('京ICP备123号');
  });

  it('页脚优先使用后台「底部导航」配置', async () => {
    const chrome: ChromeData = {
      ...CHROME,
      footerNav: [
        { text: '关于我', url: '/about' },
        { text: '外链', url: 'https://example.com' }
      ]
    };
    const html = renderFooter(chrome);
    expect(html).toContain('<a href="/about">关于我</a>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">外链</a>');
    // 主菜单里的「归档」不应再出现在页脚
    expect(html).not.toContain('<a href="/archive">归档</a>');
  });

  it('wrapWithChrome 按 顶栏 → 正文 → 页脚 组装', async () => {
    const html = wrapWithChrome(CHROME, '<main>正文</main>', '/');
    const iHeader = html.indexOf('<header');
    const iMain = html.indexOf('<main>正文</main>');
    const iFooter = html.indexOf('<footer>');
    expect(iHeader).toBeGreaterThanOrEqual(0);
    expect(iHeader).toBeLessThan(iMain);
    expect(iMain).toBeLessThan(iFooter);
  });

  it('站点名与导航文案经过 HTML 转义', async () => {
    const evil: ChromeData = {
      ...CHROME,
      siteName: '<script>alert(1)</script>',
      nav: [{ text: '<img src=x>', url: '/"><b>' }]
    };
    const html = renderTopbar(evil, '/');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
  });

  it('未配置导航时回退到默认菜单', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome-'));
    // 空 publicDir：不读仓库里的 config.min.js，页脚署名应回退到传入的站点名
    const emptyPublic = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-pub-'));
    const db = createD1(path.join(dir, 'c.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const chrome = await readChrome(db, '站点名', emptyPublic);
      // 与 app.js 一致：配置为空时 nav 保持为空，默认菜单由导航解析逻辑补上
      expect(chrome.nav).toEqual([]);
      const html = renderTopbar(chrome, '/');
      for (const url of [
        '/', '/tags', '/categories', '/history', '/series', '/popular', '/archive', '/guestbook', '/about'
      ]) {
        expect(html).toContain(`href="${url}"`);
      }
      expect(html).toContain('navExploreMenu');
      expect(chrome.footer.copyrightName).toBe('站点名');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(emptyPublic, { recursive: true, force: true });
    }
  });

  it('页脚渲染站点声明 / 联系邮箱 / 友情链接（与 app.js 的 footer-extra 同构）', async () => {
    const chrome: ChromeData = {
      ...CHROME,
      footer: {
        ...CHROME.footer,
        text: '自定义文字',
        decl: '版权所有，转载请注明出处。',
        email: 'hi@example.com',
        friends: [{ text: '语幕', url: 'https://www.yumus.cn' }]
      }
    };
    const html = renderFooter(chrome);
    // 声明 / 邮箱 / 友链都在 .footer-extra 里，且带与词典一致的标签前缀
    expect(html).toContain('<div class="footer-extra">');
    expect(html).toContain('<p class="footer-text">自定义文字</p>');
    expect(html).toContain('<span class="footer-lbl">站点声明：</span>版权所有，转载请注明出处。');
    expect(html).toContain('<a href="mailto:hi@example.com">hi@example.com</a>');
    expect(html).toContain('<span class="footer-lbl">友情链接：</span>');
    expect(html).toContain('<a href="https://www.yumus.cn" target="_blank" rel="noopener">语幕</a>');
  });

  it('页脚没有可渲染内容时不输出 .footer-extra，并带上返回顶部按钮', async () => {
    const html = renderFooter(CHROME);
    expect(html).not.toContain('footer-extra');
    expect(html).toContain('<button class="btn-top" id="backTop"');
  });

  it('版权行文案与 app.js 逐字一致（Copyright ©区间 署名）', async () => {
    const html = renderFooter(CHROME);
    const year = new Date().getFullYear();
    // app.js: 'Copyright ©' + copyRange + ' ' + copyName —— 此前 SSR 漏掉了 "Copyright" 前缀
    expect(html).toContain(`Copyright ©2020-${year} 测试博客`);
    expect(html).not.toContain('© 2020-');
  });

  it('读取 site_settings 中的 nav_menu / site_info / features 配置', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome2-'));
    // 传入空的 publicDir：本用例只验证 site_settings 侧，不掺入真实 config.min.js
    const emptyPublic = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-pub-'));
    const db = createD1(path.join(dir, 'c2.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const put = db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)');
      put.run('site_info', JSON.stringify({ name: '自定义站名', copyright: '自定义署名' }));
      put.run('nav_menu', JSON.stringify([{ text: '博客', url: '/blog' }]));
      put.run('features', JSON.stringify({ navExtras: false }));

      const chrome = await readChrome(db, '兜底名', emptyPublic);
      expect(chrome.siteName).toBe('自定义站名');
      expect(chrome.nav).toEqual([{ text: '博客', url: '/blog' }]);
      expect(chrome.navExtras).toBe(false);
      // 版权署名来自 site_info.copyright（后台可改），不是 site_settings 的 footer 键
      expect(chrome.footer.copyrightName).toBe('自定义署名');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(emptyPublic, { recursive: true, force: true });
    }
  });

  it('忽略 site_settings 的 footer / nav 键（上游不写这两个键）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome3-'));
    const emptyPublic = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-pub-'));
    const db = createD1(path.join(dir, 'c3.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const put = db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)');
      // `footer` 不是 site_settings 的键：app.js 的 cfg.footer 取自静态 config.js，
      // 后台只把 site_info.copyright / site_info.footerText 叠加上去。
      put.run('footer', JSON.stringify({ copyrightName: '不该被读到', startYear: '1999', icp: 'X-ICP' }));
      // `nav` 已被上游迁移 0012 明确清除，不再兼容读取。
      put.run('nav', JSON.stringify([{ text: '脏数据', url: '/dirty' }]));

      const chrome = await readChrome(db, '站点名', emptyPublic);
      expect(chrome.footer.copyrightName).toBe('站点名');
      expect(chrome.footer.startYear).toBe('');
      expect(chrome.footer.icp).toBe('');
      expect(chrome.nav).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(emptyPublic, { recursive: true, force: true });
    }
  });

  it('页脚取自静态 config.min.js（与 app.js 的 cfg.footer 同源）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome4-'));
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-pub-'));
    const db = createD1(path.join(dir, 'c4.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      fs.writeFileSync(
        path.join(publicDir, 'config.min.js'),
        'window.BLOG_CONFIG=' +
          JSON.stringify({
            siteUrl: 'https://example.com',
            footer: {
              startYear: 2017,
              icp: '沪ICP备0001号',
              decl: '静态声明',
              email: 'static@example.com',
              copyrightName: '静态署名',
              contact: [{ text: 'Docs', url: 'https://docs.example.com' }],
              links: [{ text: '友站', url: 'https://friend.example.com' }]
            }
          }) +
          ';'
      );

      const chrome = await readChrome(db, '兜底名', publicDir);
      // 页脚导航行优先用 config.js 的 contact（app.js:2470）
      expect(chrome.footerNav).toEqual([{ text: 'Docs', url: 'https://docs.example.com' }]);
      // 友情链接来自 config.js 的 links（app.js:2499）
      expect(chrome.footer.friends).toEqual([{ text: '友站', url: 'https://friend.example.com' }]);
      expect(chrome.footer.startYear).toBe('2017');
      expect(chrome.footer.icp).toBe('沪ICP备0001号');
      expect(chrome.footer.decl).toBe('静态声明');
      expect(chrome.footer.email).toBe('static@example.com');
      expect(chrome.footer.copyrightName).toBe('静态署名');

      // site_info 的两项覆盖 config.js：copyright → copyrightName、footerText → decl
      const put = db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)');
      put.run('site_info', JSON.stringify({ name: '站名', copyright: '后台署名', footerText: '后台声明' }));
      put.run('friend_links', JSON.stringify([{ text: '后台友链', url: 'https://x.example.com' }]));
      const merged = await readChrome(db, '兜底名', publicDir);
      expect(merged.footer.copyrightName).toBe('后台署名');
      expect(merged.footer.decl).toBe('后台声明');
      expect(merged.footer.friends).toEqual([{ text: '后台友链', url: 'https://x.example.com' }]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(publicDir, { recursive: true, force: true });
    }
  });
});
