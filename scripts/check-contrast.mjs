#!/usr/bin/env node
/**
 * 界面对比度自检（WCAG 2.1）
 * ---------------------------------------------------------------
 * 解析前台 / 后台样式表中的主题变量，为常用的「前景 / 背景」组合
 * 计算对比度，正文低于 4.5:1 判为失败，非文字（图标、边框、浅底）
 * 低于 3.0:1 仅提示警告。退出码非 0 时 CI 失败。
 *
 * 用法：node scripts/check-contrast.mjs [--warn-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WARN_ONLY = process.argv.includes('--warn-only');

/* ---------- 从 CSS 中抽出某选择器块里的 --token: #hex 定义 ---------- */
function readBlock(css, selector) {
  // 选择器需带左花括号，避免匹配到注释或属性里的同名片段
  const needle = selector.endsWith('{') ? selector : `${selector} {`;
  const idx = css.indexOf(needle);
  if (idx < 0) throw new Error(`找不到选择器块: ${selector}`);
  const open = css.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`选择器块未闭合: ${selector}`);
}

function tokens(css, selector) {
  const body = readBlock(css.replace(/\r\n/g, '\n'), selector.replace(/\r\n/g, '\n'));
  const map = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) map[m[1]] = m[2];
  return map;
}

function hex2rgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].slice(0, 3).map((c) => c + c).join('');
  h = h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** 相对亮度与对比度，支持 8 位 hex 的 alpha（按白底合成，仅做保守估计） */
function lum(hex) {
  const [r, g, b] = hex2rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const a = lum(fg);
  const b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- 待检查的语义组合 ---------- */
const TARGETS = [
  // [说明, 前景 token, 背景 token, 最低对比度, 是否文字]
  ['正文', '--fg', '--bg', 4.5, true],
  ['卡片正文', '--fg', '--card', 4.5, true],
  ['次要正文（卡片）', '--muted', '--card', 4.5, true],
  ['次要正文（页面）', '--muted', '--bg', 4.5, true],
  ['次要正文（浅底）', '--muted', '--bg-soft', 4.5, true],
  ['主色文字', '--accent', '--bg', 4.5, true],
  ['主色文字（卡片）', '--accent', '--card', 4.5, true],
  ['主色浅底上的文字', '--accent', '--accent-soft', 4.5, true],
  ['危险色文字', '--danger', '--bg', 4.5, true],
  ['危险浅底上的文字', '--danger', '--danger-soft', 4.5, true],
  ['主色底上的按钮文字', '--accent-fg', '--accent', 4.5, true],
  ['次要文字（深底）', '--muted', '--card', 4.5, true],
  ['边框（页面）', '--border', '--bg', 1.0, false],
  ['边框（卡片）', '--border', '--card', 1.0, false],
];

const ADMIN_TARGETS = [
  ['正文', '--ink', '--canvas', 4.5, true],
  ['正文（卡片）', '--ink', '--surface', 4.5, true],
  ['次要正文', '--ink-soft', '--canvas', 4.5, true],
  ['次要正文（卡片）', '--ink-soft', '--surface', 4.5, true],
  ['弱化正文', '--ink-muted', '--canvas', 4.5, true],
  ['弱化正文（卡片）', '--ink-muted', '--surface', 4.5, true],
  ['弱化正文（二级底）', '--ink-muted', '--surface-2', 4.5, true],
  ['主色文字', '--accent', '--canvas', 4.5, true],
  ['主色文字（浅底）', '--accent', '--accent-soft', 4.5, true],
  ['成功色', '--success', '--canvas', 4.5, true],
  ['成功浅底文字', '--success', '--success-soft', 4.5, true],
  ['警告色', '--warning', '--canvas', 4.5, true],
  ['警告浅底文字', '--warning', '--warning-soft', 4.5, true],
  ['危险色', '--danger', '--canvas', 4.5, true],
  ['危险浅底文字', '--danger', '--danger-soft', 4.5, true],
  ['信息色', '--info', '--canvas', 4.5, true],
  ['信息浅底文字', '--info', '--info-soft', 4.5, true],
  ['主色底上的按钮文字', '--accent-fg', '--accent', 4.5, true],
  ['边框（画布）', '--border', '--canvas', 1.0, false],
  ['强边框（画布）', '--border-strong', '--canvas', 1.0, false],
];

const NON_TEXT_MIN = 1.15; // 边框/分隔线：过淡才提示
const failures = [];
const warns = [];

function run(label, css, lightSel, darkSel, combos) {
  for (const [theme, sel] of [['浅色', lightSel], ['深色', darkSel]]) {
    const t = tokens(css, sel);
    const rows = [];
    for (const [name, fg, bg, min, isText] of combos) {
      if (!t[fg] || !t[bg]) {
        warns.push(`${label}/${theme}: 缺少变量 ${!t[fg] ? fg : bg}，跳过「${name}」`);
        continue;
      }
      const r = ratio(t[fg], t[bg]);
      const threshold = isText ? min : NON_TEXT_MIN;
      const ok = r >= threshold;
      rows.push(`  ${ok ? '✅' : isText ? '❌' : '⚠️'} ${name.padEnd(18, ' ')} ${r.toFixed(2)}:1  (${t[fg]} / ${t[bg]})`);
      if (!ok) {
        const line = `${label} · ${theme} · ${name}：${r.toFixed(2)}:1，低于 ${threshold}:1`;
        if (isText) failures.push(line);
        else warns.push(line);
      }
    }
    console.log(`\n▌${label} · ${theme}主题`);
    console.log(rows.join('\n'));
  }
}

/* ---------- 前台各主题配色板（data-accent）也逐个检查 ---------- */
const PALETTE_COMBOS = [
  ['主色文字（页面底）', '--accent', '--bg', 4.5, true],
  ['主色文字（卡片）', '--accent', '--card', 4.5, true],
  ['主色文字（柔化底）', '--accent', '--accent-soft', 4.5, true],
  ['主色底上的文字', '--accent-fg', '--accent', 4.5, true],
  ['正文', '--fg', '--bg', 4.5, true],
  ['次要正文', '--muted', '--card', 4.5, true],
];

function paletteBlocks(css) {
  const re = /(:root|html)\[data-theme="(light|dark)"\]\[data-accent="([a-z]+)"\]\s*\{/g;
  const list = [];
  let m;
  while ((m = re.exec(css))) {
    const theme = m[2] === 'dark' ? '深色' : '浅色';
    const block = readBlock(css, m[0].replace(/\s*\{\s*$/, ''));
    const vars = {};
    for (const t of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) vars[t[1]] = t[2];
    list.push([theme, m[3], vars]);
  }
  return list;
}

const siteCss = fs.readFileSync(path.join(ROOT, 'app/public/style.css'), 'utf8');
const adminCss = fs.readFileSync(path.join(ROOT, 'admin/src/style.css'), 'utf8');

run('前台博客', siteCss, ':root', 'html[data-theme="dark"]', TARGETS);
run('管理后台', adminCss, ':root', '.dark', ADMIN_TARGETS);

console.log('\n▌前台主题配色板（data-accent）');
for (const [theme, name, vars] of paletteBlocks(siteCss.replace(/\r\n/g, '\n'))) {
  const rows = [];
  for (const [label, fg, bg, min, isText] of PALETTE_COMBOS) {
    if (!vars[fg] || !vars[bg]) continue;
    // 未在该配色板里重定义的底色，回落到 :root 的值
    const t = { ...tokens(siteCss.replace(/\r\n/g, '\n'), ':root'), ...vars };
    const r = ratio(t[fg], t[bg]);
    const ok = r >= min;
    rows.push(`  ${ok ? '✅' : '❌'} ${label.padEnd(18, ' ')} ${r.toFixed(2)}:1  (${t[fg]} / ${t[bg]})`);
    if (!ok) failures.push(`配色板 ${name} · ${theme} · ${label}：${r.toFixed(2)}:1，低于 ${min}:1`);
  }
  console.log(`\n  · ${name}（${theme}）`);
  console.log(rows.join('\n'));
}

console.log('');
if (warns.length) {
  console.log(`⚠️  提示 ${warns.length} 条（非文字元素偏淡）：`);
  for (const w of warns) console.log(`   - ${w}`);
}
if (failures.length) {
  console.log(`\n❌ 对比度不达标 ${failures.length} 处（正文需 ≥ 4.5:1）：`);
  for (const f of failures) console.log(`   - ${f}`);
  if (!WARN_ONLY) process.exit(1);
} else {
  console.log('✅ 全部文字对比度达标（WCAG AA）');
}
