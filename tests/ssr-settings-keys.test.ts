/* ============================================================
 * 护栏：src 读的 site_settings 键必须与前端一致
 * ------------------------------------------------------------
 * 背景（本文件就是为了不再犯）：`src` 里曾把站点信息读成 `site` 键，
 * 而真正的键是 `site_info`（前台 app.js:1026 读的是 s.site_info）。
 * 后果是静默的：站点名称/简介/头像、以及关于页正文全部回落默认值，
 * 而 readSettingJson 有 try/catch，不报错、不抛异常，只是「内容不对」。
 *
 * 更糟的是当时的单测用 `site` 键断言，把 bug 锁死了。
 * 所以这里改成**以 app.js 为准的机械比对**：
 *   src 里每一处 site_settings 键读取，都必须能在 app.js 里找到
 *   同名的 `s.<键>` 读取点；否则测试失败。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const SRC = path.join(ROOT, 'src');
const APP_JS = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');

function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTs(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** src/** 里所有 site_settings 键的读取点（键 → 出现位置）。 */
function srcSettingKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  // readSettingJson<T>(db, 'key') 与 map.get('key')（只匹配字符串字面量）
  const patterns = [
    /readSettingJson<[^>]*>\(\s*\w+\s*,\s*'([^']+)'/g,
    /map\.get\(\s*'([^']+)'\s*\)/g
  ];
  for (const file of collectTs(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const key = match[1] as string;
        const list = found.get(key) ?? [];
        list.push(path.relative(ROOT, file).replace(/\\/g, '/'));
        found.set(key, list);
      }
    }
  }
  return found;
}

describe('site_settings 键名 · 与前端一致', () => {
  const keys = srcSettingKeys();

  it('确实扫到了读取点（防止正则失效导致测试空转）', () => {
    expect(keys.size).toBeGreaterThanOrEqual(7);
    expect(keys.has('site_info')).toBe(true);
    expect(keys.has('friend_links')).toBe(true);
  });

  it('每个键都能在前端 app.js 里找到 s.<键> 的读取点', () => {
    const orphans = [...keys.entries()]
      .filter(([key]) => !new RegExp(`s\\.${key}\\b`).test(APP_JS))
      .map(([key, where]) => `${key}（${[...new Set(where)].join(', ')}）`);
    expect(
      orphans,
      'src 读取了 app.js 里不存在的 site_settings 键：键名拼错或用了旧键名，会导致配置静默失效。'
    ).toEqual([]);
  });

  it('站点信息用 site_info，不是 site', () => {
    expect(keys.has('site_info')).toBe(true);
    expect(
      keys.has('site'),
      '`site` 是旧键名：前台读 s.site_info，写成 site 会让站点名称/简介/头像静默回落默认值。'
    ).toBe(false);
  });

  it('友链用 friend_links，不是 footer.links', () => {
    expect(keys.has('friend_links')).toBe(true);
  });

  it('键清单与预期一致（新增键时必须同步核对前台）', () => {
    expect([...keys.keys()].sort()).toEqual([
      'features',
      'footer_nav',
      'friend_links',
      'home_tags',
      'nav_defaults_version',
      'nav_menu',
      'profile',
      'site_info'
    ]);
  });

  it('不再读 `footer` / `nav` 这两个非 site_settings 键', () => {
    // `footer`：app.js 的 cfg.footer 取自静态 config.js，后台只把
    //   site_info.copyright / site_info.footerText 叠加上去，
    //   所以 site_settings 里根本不存在这个键——读它只会读到 {}。
    // `nav`：已被上游迁移 0012_clear_orphaned_nav.sql 明确清除。
    expect(keys.has('footer')).toBe(false);
    expect(keys.has('nav')).toBe(false);
  });

  it('页脚配置来自静态 config.min.js（与前端同源），而不是 site_settings', () => {
    const chrome = fs.readFileSync(path.join(SRC, 'ssr', 'chrome.ts'), 'utf8');
    expect(chrome).toContain("readBlogConfig(");
    expect(chrome).not.toMatch(/map\.get\(\s*'footer'\s*\)/);
  });
});
