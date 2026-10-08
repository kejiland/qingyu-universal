/* ============================================================
 * 后台多语言护栏
 * ------------------------------------------------------------
 * 后台复用前台同一套词典（`app/public/locales/*.json`），最容易静默出错的是：
 * 只在中文里加了键、别的语言漏了 —— 切到该语言就会看到键名。
 * 这里把「后台代码用到的键必须在五种语言里都存在」钉死。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADMIN_SRC = path.join(ROOT, 'admin', 'src');
const LOCALES_DIR = path.join(ROOT, 'app', 'public', 'locales');
const LANGS = ['zh-CN', 'en', 'ja', 'ko', 'hi'] as const;

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function loadLocale(lang: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8')) as Record<string, string>;
}

describe('后台多语言', () => {
  it('五种语言拥有完全相同的键集合', () => {
    const keysets = LANGS.map((lang) => new Set(Object.keys(loadLocale(lang))));
    const base = keysets[0]!;
    for (let i = 1; i < LANGS.length; i++) {
      const missing = [...base].filter((k) => !keysets[i]!.has(k));
      const extra = [...keysets[i]!].filter((k) => !base.has(k));
      expect(missing, `${LANGS[i]} 缺少这些键`).toEqual([]);
      expect(extra, `${LANGS[i]} 多出这些键`).toEqual([]);
    }
  });

  it('后台代码用到的每个文案键在五种语言里都存在', () => {
    const files = walk(ADMIN_SRC, ['.ts', '.vue']);
    /** 键 → 首次出现的位置，报错时方便定位 */
    const used = new Map<string, string>();

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // 只收真实调用：t('...') / t("...")；变量式键名（如 t(item.labelKey)）这里收不到，
      // 由下面的「键表」测试兜底。
      for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) {
        const key = m[1]!;
        if (!key.includes('.')) continue;
        if (!used.has(key)) used.set(key, path.relative(ROOT, file));
      }
    }

    expect(used.size, '没有在后台代码里找到任何 t(...) 调用，正则可能失效了').toBeGreaterThan(0);

    const dicts = new Map(LANGS.map((lang) => [lang, loadLocale(lang)]));
    const problems: string[] = [];
    for (const [key, where] of used) {
      for (const lang of LANGS) {
        if (!dicts.get(lang)![key]) problems.push(`${lang} 缺少 ${key}（用于 ${where}）`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('导航与页头引用的文案键也都在词典里', () => {
    /** 用变量传键的地方（导航 labelKey / 路由 meta.titleKey），键值是写死的，单独列出来核对 */
    const layout = fs.readFileSync(path.join(ADMIN_SRC, 'components', 'layout', 'AdminLayout.vue'), 'utf8');
    const router = fs.readFileSync(path.join(ADMIN_SRC, 'router.ts'), 'utf8');

    const keys = new Set<string>();
    for (const m of layout.matchAll(/labelKey:\s*'([^']+)'/g)) keys.add(m[1]!);
    for (const m of router.matchAll(/titleKey:\s*'([^']+)'/g)) keys.add(m[1]!);
    for (const m of router.matchAll(/subtitleKey:\s*'([^']+)'/g)) keys.add(m[1]!);

    expect(keys.size, '没有从导航 / 路由里解析出任何文案键').toBeGreaterThan(0);

    const dicts = new Map(LANGS.map((lang) => [lang, loadLocale(lang)]));
    const problems: string[] = [];
    for (const key of keys) {
      for (const lang of LANGS) {
        if (!dicts.get(lang)![key]) problems.push(`${lang} 缺少 ${key}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
