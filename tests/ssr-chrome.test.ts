import { describe, expect, it } from 'vitest';
import { readChrome, renderFooter, renderTopbar, wrapWithChrome } from '../src/ssr/chrome.js';
import { createD1 } from '../src/bindings/d1.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = {
  siteName: '测试博客',
  nav: [
    { text: '首页', url: '/' },
    { text: '归档', url: '/archive' }
  ],
  footer: { copyrightName: '测试博客', startYear: '2020', icp: '京ICP备123号' }
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
    // 5 个动作必须随 SSR 连同图标一起输出，不能等 app.js 空闲接管后才补上
    expect((html.match(/class="icon-btn/g) ?? []).length).toBe(5);
    expect(html).toContain('id="searchToggle"');
    expect(html).toContain('id="langToggle"');
    expect(html).toContain('id="accentToggle"');
    expect(html).toContain('id="bgAnimToggle"');
    expect(html).toContain('id="themeToggle"');
    expect(html).not.toContain('<button class="icon-btn" tabindex="-1" aria-hidden="true"></button>');
    expect((html.match(/<svg /g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('ssr-theme-moon');
    expect(html).toContain('ssr-theme-sun');
  });

  it('当前路径的导航项高亮', async () => {
    expect(renderTopbar(CHROME, '/archive')).toContain('href="/archive" class="nav-link active"');
    // 根路径只精确匹配 '/'，不会把 /archive 也点亮
    const home = renderTopbar(CHROME, '/');
    expect(home).toContain('href="/" class="nav-link active"');
    expect(home).not.toContain('href="/archive" class="nav-link active"');
  });

  it('页脚含导航、版权与备案号', async () => {
    const html = renderFooter(CHROME);
    expect(html).toContain('<footer><div class="container footer-inner">');
    expect(html).toContain('class="footer-nav"');
    expect(html).toContain('class="footer-copy"');
    expect(html).toContain('测试博客');
    expect(html).toMatch(/2020-\d{4}/);  // 起始年份区间
    expect(html).toContain('京ICP备123号');
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
    const evil = {
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
    const db = createD1(path.join(dir, 'c.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const chrome = await readChrome(db, '站点名');
      expect(chrome.nav.length).toBeGreaterThan(0);
      expect(chrome.nav.map((n) => n.url)).toEqual([
        '/', '/tags', '/categories', '/history', '/series', '/popular', '/archive', '/guestbook', '/about'
      ]);
      expect(chrome.footer.copyrightName).toBe('站点名');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧导航缺少 nav_defaults_version 时补齐默认项但不覆盖自定义项', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome3-'));
    const db = createD1(path.join(dir, 'c3.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const put = db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)');
      put.run('nav', JSON.stringify([{ text: '手记', url: '/notes' }]));

      const chrome = await readChrome(db, '站点名');
      const urls = chrome.nav.map((n) => n.url);
      expect(urls).toContain('/notes'); // 自定义项保留
      expect(urls).toContain('/tags');  // 缺失的默认项补上
      expect(chrome.primaryNav.map((n) => n.url)).toContain('/about');
      expect(chrome.secondaryNav.map((n) => n.url)).toEqual(['/tags', '/history', '/series', '/popular']);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('预取 site_settings 行时不再回查数据库', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome4-'));
    const db = createD1(path.join(dir, 'c4.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)').run('site', JSON.stringify({ name: '预取站名' }));
      const rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM site_settings');
      const chrome = await readChrome(db, '兜底名', rows);
      expect(chrome.siteName).toBe('预取站名');
      // 传入的预取行为空数组（表确实为空）与不传是两种语义：
      // 空数组表示「查过了，确实没有」，不应退回默认导航去再查一次。
      const empty = await readChrome(db, '兜底名', []);
      expect(empty.nav.length).toBeGreaterThan(0);
      expect(empty.footer.copyrightName).toBe('兜底名');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('渲染入口接受精简结构，缺字段不抛错', async () => {
    // 不需要任何 cast —— ChromeInput 如实声明了「精简结构合法」，
    // 一旦有人把入口签名收窄回 ChromeData，这条会在类型检查期就红。
    const minimal: Parameters<typeof renderTopbar>[0] = {
      siteName: '精简站',
      nav: [
        { text: '首页', url: '/' },
        { text: '归档', url: '/archive' }
      ],
      footer: { copyrightName: '精简站', startYear: '2020', icp: '' }
    };
    const html = renderTopbar(minimal, { path: '/archive', category: '' });
    expect(html).toContain('href="/archive" class="nav-link active"');
    expect(renderFooter(minimal)).toContain('精简站');
  });
  it('读取 site_settings 中的 nav / footer 配置', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome2-'));
    const db = createD1(path.join(dir, 'c2.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const put = db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)');
      put.run('site', JSON.stringify({ name: '自定义站名' }));
      put.run('nav', JSON.stringify([{ text: '博客', url: '/blog' }]));
      put.run('nav_defaults_version', '1');
      put.run('footer', JSON.stringify({ copyrightName: '版权方', startYear: '2018', icp: 'X-ICP' }));

      const chrome = await readChrome(db, '兜底名');
      expect(chrome.siteName).toBe('自定义站名');
      expect(chrome.nav.map((n) => n.url)).toEqual(['/blog']);
      expect(chrome.nav[0].children).toEqual([]);
      expect(chrome.footer.copyrightName).toBe('版权方');
      expect(chrome.footer.startYear).toBe('2018');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});