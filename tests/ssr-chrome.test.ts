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
  it('顶栏结构与 app.js 对齐', () => {
    const html = renderTopbar(CHROME, '/');
    expect(html).toContain('<header class="topbar">');
    expect(html).toContain('<div class="container topbar-inner">');
    expect(html).toContain('<div class="topbar-left">');
    expect(html).toContain('<a class="brand" href="/">测试博客</a>');
    expect(html).toContain('<nav class="main-nav">');
    expect(html).toContain('<div class="topbar-actions">');
    // 4 个占位图标按钮：CSS 给了 .icon-btn 固定尺寸，能占住空间
    expect((html.match(/class="icon-btn"/g) ?? []).length).toBe(4);
  });

  it('当前路径的导航项高亮', () => {
    expect(renderTopbar(CHROME, '/archive')).toContain('href="/archive" class="active"');
    // 根路径只精确匹配 '/'，不会把 /archive 也点亮
    const home = renderTopbar(CHROME, '/');
    expect(home).toContain('href="/" class="active"');
    expect(home).not.toContain('href="/archive" class="active"');
  });

  it('页脚含导航、版权与备案号', () => {
    const html = renderFooter(CHROME);
    expect(html).toContain('<footer><div class="container footer-inner">');
    expect(html).toContain('class="footer-nav"');
    expect(html).toContain('class="footer-copy"');
    expect(html).toContain('测试博客');
    expect(html).toContain('2020–');         // 起始年份区间
    expect(html).toContain('京ICP备123号');
  });

  it('wrapWithChrome 按 顶栏 → 正文 → 页脚 组装', () => {
    const html = wrapWithChrome(CHROME, '<main>正文</main>', '/');
    const iHeader = html.indexOf('<header');
    const iMain = html.indexOf('<main>正文</main>');
    const iFooter = html.indexOf('<footer>');
    expect(iHeader).toBeGreaterThanOrEqual(0);
    expect(iHeader).toBeLessThan(iMain);
    expect(iMain).toBeLessThan(iFooter);
  });

  it('站点名与导航文案经过 HTML 转义', () => {
    const evil = {
      ...CHROME,
      siteName: '<script>alert(1)</script>',
      nav: [{ text: '<img src=x>', url: '/"><b>' }]
    };
    const html = renderTopbar(evil, '/');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
  });

  it('未配置导航时回退到默认菜单', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome-'));
    const db = createD1(path.join(dir, 'c.db'));
    try {
      runMigrations(db, MIGRATIONS_DIR);
      const chrome = readChrome(db, '站点名');
      expect(chrome.nav.length).toBeGreaterThan(0);
      expect(chrome.nav.some((n) => n.url === '/archive')).toBe(true);
      expect(chrome.footer.copyrightName).toBe('站点名');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('读取 site_settings 中的 nav / footer 配置', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-chrome2-'));
    const db = createD1(path.join(dir, 'c2.db'));
    try {
      runMigrations(db, MIGRATIONS_DIR);
      const put = db.native.prepare('INSERT INTO site_settings (k,v) VALUES (?,?)');
      put.run('site', JSON.stringify({ name: '自定义站名' }));
      put.run('nav', JSON.stringify([{ text: '博客', url: '/blog' }]));
      put.run('footer', JSON.stringify({ copyrightName: '版权方', startYear: '2018', icp: 'X-ICP' }));

      const chrome = readChrome(db, '兜底名');
      expect(chrome.siteName).toBe('自定义站名');
      expect(chrome.nav).toEqual([{ text: '博客', url: '/blog' }]);
      expect(chrome.footer.copyrightName).toBe('版权方');
      expect(chrome.footer.startYear).toBe('2018');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});