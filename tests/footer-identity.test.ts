/* ============================================================
 * 护栏：页脚「站点设置覆盖链」必须前台与 SSR 同构
 * ------------------------------------------------------------
 * 背景（本文件就是为了不再犯）：后台「页脚与版权」里有建站年份与 ICP 备案号
 * 两个输入框，值存进 site_settings 后，前台 renderFooter() 却只从**静态
 * config.js** 读这两个字段——app.js 的覆盖链当时只覆盖 copyright / footerText
 * 两项。结果是「后台配得出来、前台永远不生效」的假设置项。
 *
 * 修复方式是在 app.js（走 apply-own-patches.mjs 自有补丁）与 src/ssr/chrome.ts
 * 两处**各加一行**，把 startYear / icp 也接进覆盖链。
 *
 * 所以这里钉三件事：
 *   1. 两处覆盖的字段集合必须完全一致（铁律 4：SSR 与 SPA 同构，漏一边会闪烁）
 *   2. 建站年份与备案号必须在链上（否则又变回假设置项）
 *   3. 后台保存时不得再写 site / footer / nav 这三个键
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const APP_JS = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
const CHROME_TS = fs.readFileSync(path.join(ROOT, 'src', 'ssr', 'chrome.ts'), 'utf8');
const ADVANCED = fs.readFileSync(
  path.join(ROOT, 'admin', 'src', 'views', 'AdvancedSettingsView.vue'),
  'utf8'
);
const SETTINGS = fs.readFileSync(
  path.join(ROOT, 'admin', 'src', 'views', 'SettingsView.vue'),
  'utf8'
);

/** app.js：`if (siteInfo.X) footer = Object.assign({}, footer, {...})` */
function appFields(): string[] {
  const re = /if \(siteInfo\.(\w+)\) footer = Object\.assign\(/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(APP_JS)) !== null) out.add(m[1] as string);
  return [...out].sort();
}

/** chrome.ts：`if (str(site.X)) footer.Y = ...` */
function ssrFields(): string[] {
  const re = /if \(str\(site\.(\w+)\)\) footer\./g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(CHROME_TS)) !== null) out.add(m[1] as string);
  return [...out].sort();
}

/** 后台 saveSettings({...}) 里登记的顶层键 */
function savedKeys(source: string): string[] {
  const out: string[] = [];
  // 多行形式：api.saveSettings({\n      key: ...
  // 注意 .vue 源文件是 CRLF，行尾必须写成 \r?\n 才匹配得上
  const block = /api\.saveSettings\(\{\r?\n([\s\S]*?)\r?\n\s*\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(source)) !== null) {
    // 先抹掉 \r：CRLF 时 `^` 落在 \r 之后，缩进计数会被多算一个字符
    const body = (m[1] as string).replace(/\r/g, '');
    const indent = /^ */ .exec(body)?.[0].length ?? 0;
    const kre = new RegExp(`^ {${indent}}(\\w+):`, 'gm');
    let k: RegExpExecArray | null;
    while ((k = kre.exec(body)) !== null) out.push(k[1] as string);
  }
  // 单行形式：api.saveSettings({ key: ... })
  const inline = /api\.saveSettings\(\{\s*(\w+):/g;
  while ((m = inline.exec(source)) !== null) out.push(m[1] as string);
  return [...new Set(out)];
}

describe('页脚覆盖链 · 前台与 SSR 同构', () => {
  const app = appFields();
  const ssr = ssrFields();

  it('确实扫到了覆盖点（防止正则失效导致测试空转）', () => {
    expect(app.length).toBeGreaterThanOrEqual(4);
    expect(ssr.length).toBeGreaterThanOrEqual(4);
  });

  it('前台与 SSR 覆盖的字段集合完全一致', () => {
    expect(
      app,
      'app.js 与 src/ssr/chrome.ts 的页脚覆盖链字段不一致——' +
        'SSR 首屏与 app.js 接管后的结果会不一样，产生页脚内容闪烁。'
    ).toEqual(ssr);
  });

  it('建站年份与备案号在覆盖链上（后台填了必须能生效）', () => {
    for (const key of ['copyright', 'footerText', 'startYear', 'icp']) {
      expect(app, `app.js 覆盖链缺少 ${key}`).toContain(key);
      expect(ssr, `chrome.ts 覆盖链缺少 ${key}`).toContain(key);
    }
  });
});

describe('后台保存的 site_settings 键 · 与上游一致', () => {
  const keys = [...savedKeys(ADVANCED), ...savedKeys(SETTINGS)];

  it('确实扫到了保存键（防止正则失效导致测试空转）', () => {
    expect(keys).toContain('site_info');
    expect(keys).toContain('nav_menu');
  });

  it('不再写 site / footer / nav 这三个键', () => {
    // site：旧键名，前台读的是 site_info，写了也无人消费。
    // footer：不是合法的 site_settings 键，页脚默认取自静态 config.js。
    // nav：上游迁移 0012_clear_orphaned_nav.sql 已明确清除，
    //      且现在没有任何消费点（app.js:1045 只读 nav_menu）。
    for (const bad of ['site', 'footer', 'nav']) {
      expect(keys, `后台仍在写 ${bad} 键`).not.toContain(bad);
    }
  });

  it('仍然覆盖上游 saveSettings() 的全部十个合法键', () => {
    for (const key of [
      'site_info',
      'profile',
      'nav_menu',
      'nav_defaults_version',
      'home_tags',
      'footer_nav',
      'friend_links',
      'moderate_comments',
      'comment_blocklist',
      'features'
    ]) {
      expect(keys, `后台没有写上游的 ${key} 键`).toContain(key);
    }
  });
});
