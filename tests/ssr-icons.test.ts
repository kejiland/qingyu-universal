/* ============================================================
 * SSR 图标表护栏
 * ------------------------------------------------------------
 * `src/ssr/icons.ts` 是 app.js `svgIcon()` 的复刻。这类「抄一遍」的代码
 * 最容易在同步上游时悄悄漂移（上游加一个图标 / 改一条 path，我们毫无察觉），
 * 于是这里直接把 app/public/app.js 里的 `var I = { ... }` 整表抽出来，
 * 逐个 SVG 与我们的实现做**字节级**比对。
 *
 * 覆盖三件事：
 *   1. 键集合完全一致（不多不少）
 *   2. 每个图标的 SVG 文本完全一致（默认 size=18）
 *   3. size 参数化行为一致（挑几个图标比较 size=13/14/20/34）
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ICON_NAMES, svgIcon } from '../src/ssr/icons.js';

const APP_JS = path.resolve(process.cwd(), 'app/public/app.js');

const STROKE =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

interface UpstreamIcon {
  /** `<svg` 与 `width=` 之间的内容（仅 spinner 有 class） */
  prefix: string;
  /** `</svg>` 之前的路径片段 */
  body: string;
}

/** 从 app.js 源码里抽出 `var I = { name: '<svg .../>', ... }` 图标表。 */
function readUpstreamIcons(): Map<string, UpstreamIcon> {
  const source = fs.readFileSync(APP_JS, 'utf8');
  const start = source.indexOf('  var I = {');
  if (start < 0) throw new Error('未在 app.js 里找到 `var I = {` 图标表');
  const end = source.indexOf('\n  };', start);
  if (end < 0) throw new Error('未在 app.js 里找到图标表的结束 `};`');
  const table = source.slice(start, end);

  const icons = new Map<string, UpstreamIcon>();
  const line = /^\s*(?:'([^']+)'|([A-Za-z_][\w-]*)):\s*'<svg([\s\S]*?)<\/svg>',?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = line.exec(table))) {
    const name = match[1] ?? match[2];
    const raw = match[3];
    // 上游统一写法：'<svg ' + s + ' ' + c + '>' 或 '<svg class="spin-icon" ' + s + ' ' + c + '>'
    const parts = raw.split("' + s + ' ' + c + '>");
    if (parts.length !== 2) throw new Error(`图标 ${name} 的拼接写法与预期不符：${raw.slice(0, 80)}`);
    icons.set(name, { prefix: parts[0], body: parts[1] });
  }
  return icons;
}

function upstreamSvg(icon: UpstreamIcon, size: number): string {
  return (
    `<svg${icon.prefix}width="${size}" height="${size}" ${STROKE}>${icon.body}</svg>`
  );
}

const UPSTREAM = readUpstreamIcons();

describe('SSR 图标表与 app.js 同构', () => {
  it('键集合完全一致（不多不少）', () => {
    expect([...ICON_NAMES].sort()).toEqual([...UPSTREAM.keys()].sort());
  });

  it('app.js 的图标表确实被解析出来（防止正则失效导致空跑通过）', () => {
    // 上游 2.10.92 的图标数；下限放宽到 45，防止上游删几个图标就让测试失真，
    // 但一旦正则失效（解析出 0 条）会立刻变红。
    expect(UPSTREAM.size).toBeGreaterThanOrEqual(45);
  });

  it('每个图标默认 size=18 的 SVG 文本逐字节一致', () => {
    for (const name of UPSTREAM.keys()) {
      expect(svgIcon(name), `图标 ${name} 不一致`).toBe(upstreamSvg(UPSTREAM.get(name)!, 18));
    }
  });

  it('size 参数化行为一致', () => {
    for (const size of [13, 14, 15, 20, 26, 34]) {
      for (const name of UPSTREAM.keys()) {
        expect(svgIcon(name, size), `图标 ${name} 在 size=${size} 时不一致`).toBe(
          upstreamSvg(UPSTREAM.get(name)!, size)
        );
      }
    }
  });

  it('未知图标返回空字符串（与 app.js 的 `I[name] || ""` 一致）', () => {
    expect(svgIcon('__not_an_icon__')).toBe('');
    expect(svgIcon('')).toBe('');
  });
});
