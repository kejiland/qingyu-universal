import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeLegacyHtml, sanitizeLegacyTag, decodeLegacyEntities } from '../src/lib/legacy-html.js';

/* ------------------------------------------------------------
 * 旧正文 HTML 归一化
 * ------------------------------------------------------------
 * WordPress 等旧平台导入的老文章正文里混着原始 HTML（&nbsp; 实体、<!--more-->
 * 注释、早已失效的 Flash <embed>/<object> 播放器）。服务端 SSR 透传它们，
 * 浏览器看不见；但 app.js 接管后会用自己的渲染器重绘正文，转义后这些标记
 * 就变成 "&nbsp;"、"<!--more-->"、"<embed src=…>" 这样的字面文字显示给读者。
 *
 * 这里除了验证规则本身，还把 app.js 里的前端实现抽出来跑同一批用例，
 * 保证「服务端 src/lib/legacy-html.ts」与「前端 app.js」两侧不会分叉。
 * ------------------------------------------------------------ */

/** 把 app.js 中的前端等价实现抽出来单独求值（不加载整个 app）。 */
function loadFrontendHelper(): (md: string) => { text: string; restore(html: string): string } {
  const app = fs.readFileSync(path.join(process.cwd(), 'app/public/app.js'), 'utf8');
  const start = app.indexOf('var LEGACY_COMMENT =');
  const end = app.indexOf('function renderMarkdown(md)');
  expect(start, 'app.js 缺少前端旧正文归一化实现').toBeGreaterThan(-1);
  expect(end, 'app.js 缺少 renderMarkdown()').toBeGreaterThan(start);
  const snippet = app.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${snippet}\nreturn normalizeLegacyHtml;`);
  return factory() as (md: string) => { text: string; restore(html: string): string };
}

const frontend = loadFrontendHelper();

/* 截图里的典型症状样例：老文章正文。 */
const LEGACY_SAMPLE = [
  '<p>&nbsp;</p>',
  '<!--more-->',
  '<p>52 EVER OSL 第一阶段F组 <strong>第三轮</strong>&nbsp;&nbsp;比赛回顾</p>',
  '<embed src="http://player.youku.com/player.php/sid/MjQ4NjI1NjQ0NjA4NzQ4NDg4NjQ5NzI1NTU0.html" quality="high" allowscriptaccess="always" type="application/x-shockwave-flash" width="480" height="400"></embed>',
  '<p>&hellip;&nbsp;完</p>'
].join('\n');

const CASES: Array<{ name: string; md: string; expect: (out: string) => void }> = [
  {
    name: '截图样例：实体还原、注释与失效播放器消失',
    md: LEGACY_SAMPLE,
    expect: (out) => {
      expect(out).not.toContain('&nbsp;');
      expect(out).not.toContain('<!--more-->');
      expect(out).not.toContain('embed');
      expect(out).not.toContain('shockwave-flash');
      expect(out).toContain('52 EVER OSL 第一阶段F组');
      expect(out).toContain('<strong>第三轮</strong>');
      expect(out).toContain('比赛回顾');
      expect(out).toContain('…');
    }
  },
  {
    name: 'script / style 连内容一起删除',
    md: '前<script>alert(1)</script>后<style>.a{}</style>尾',
    expect: (out) => {
      expect(out).toBe('前后尾');
    }
  },
  {
    name: 'object / applet 连内容一起删除',
    md: 'a<object data="x.swf">fallback</object>b',
    expect: (out) => {
      expect(out).toBe('ab');
    }
  },
  {
    name: '正常排版标签透传',
    md: '<div class="x"><p>hi <em>there</em></p></div>',
    expect: (out) => {
      expect(out).toBe('<div class="x"><p>hi <em>there</em></p></div>');
    }
  },
  {
    name: '属性消毒：on* 事件、srcdoc、javascript: 协议',
    md: '<img src="/a.png" onerror="steal()" alt="a"><a href="javascript:evil()">x</a><iframe srcdoc="<script>x</script>"></iframe>',
    expect: (out) => {
      expect(out).toContain('src="/a.png"');
      expect(out).not.toContain('onerror');
      expect(out).not.toContain('srcdoc');
      expect(out).not.toContain('javascript:');
      expect(out).toContain('href=""');
    }
  },
  {
    name: '代码块与行内代码内的尖括号不当 HTML 处理',
    md: ['```html', '<p>&nbsp;<embed></p>', '```', '行内 `<b>&nbsp;</b>`'].join('\n'),
    expect: (out) => {
      expect(out).toContain('<p>&nbsp;<embed></p>');
      expect(out).toContain('`<b>&nbsp;</b>`');
    }
  },
  {
    name: '双重编码保持字面量，正文里作为文字展示的 <script> 不被当标签',
    md: '&amp;nbsp; 与 &lt;script&gt;alert(1)&lt;/script&gt;',
    expect: (out) => {
      expect(out).toContain('&nbsp;');
      expect(out).toContain('<script>alert(1)</script>');
    }
  },
  {
    name: '未闭合的 script 起始标签直接丢弃',
    md: '前<script>alert(1) 后',
    expect: (out) => {
      expect(out).toBe('前alert(1) 后');
    }
  }
];

describe('旧正文 HTML 归一化', () => {
  for (const c of CASES) {
    it(`服务端：${c.name}`, () => {
      const n = normalizeLegacyHtml(c.md);
      c.expect(n.restore(n.text));
    });

    it(`前端 app.js：${c.name}`, () => {
      const n = frontend(c.md);
      c.expect(n.restore(n.text));
    });
  }

  it('两侧对同一段正文的归一化结果完全一致', () => {
    for (const c of CASES) {
      const a = normalizeLegacyHtml(c.md);
      const b = frontend(c.md);
      expect(b.text, c.name).toBe(a.text);
      expect(b.restore(b.text), c.name).toBe(a.restore(a.text));
    }
  });

  it('renderMarkdown 已接入归一化（接管后重绘不会再显示字面标记）', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'app/public/app.js'), 'utf8');
    expect(app).toContain('function normalizeLegacyHtml(');
    expect(app).toContain('var legacy = normalizeLegacyHtml(md);');
    expect(app).toContain('return legacy.restore(html);');
  });

  it('sanitizeLegacyTag 只动属性，不动标签名', () => {
    expect(sanitizeLegacyTag('<a href="/x" onclick="a()">')).toBe('<a href="/x">');
    expect(sanitizeLegacyTag('<p>')).toBe('<p>');
  });

  it('decodeLegacyEntities 支持数字实体与十六进制实体，未知实体原样保留', () => {
    expect(decodeLegacyEntities('&#20013;&#x4e2d;')).toBe('中中');
    expect(decodeLegacyEntities('&notarealentity;')).toBe('&notarealentity;');
    expect(decodeLegacyEntities('&nbsp;&lt;', false)).toBe(' &lt;');
  });
});