/* ============================================================
 * SSR Markdown 渲染器：与 app.js 的同构性 + XSS 护栏
 * ------------------------------------------------------------
 * 为什么要有这个文件：
 *   src/ssr/markdown.ts 是 app.js 渲染器的**同构移植**（项目铁律 4）。
 *   只断言几个字符串很容易「看着对」，所以这里把 app.js 里那几个函数
 *   原样抽出来，在沙箱里跑一遍，再跟 SSR 的产出做**逐字节比对**。
 *
 *   任何一边单独改动（无论是同步上游后 app.js 变了，还是我们自己改了
 *   markdown.ts）都会在这里炸掉，并提示去两边对齐。
 *
 * 另外锁死 XSS：正文按不可信内容处理，原始 HTML 必须转义。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, tokenizeCode, __internals } from '../src/ssr/markdown.js';
import type { WikiPostRef } from '../src/ssr/markdown.js';

const APP_JS = fs.readFileSync(path.resolve('app/public/app.js'), 'utf8');

/**
 * 从 app.js 源码里按名字截出顶层函数。
 * 顶层函数有两种写法：多行（以行首 `}` 收尾）与单行（如 `function slug(s) { … }`）。
 * 用「第一个 `}` 是否与函数签名同行」来区分，避免依赖大括号配对（正文里有正则字面量）。
 */
function sliceFunction(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  if (start < 0) {
    throw new Error(
      `app.js 里找不到 function ${name}()。上游改写了前端渲染器，请把 src/ssr/markdown.ts 与 app.js 重新对齐。`
    );
  }
  const braceStart = APP_JS.indexOf('{', start);
  const lineEnd = APP_JS.indexOf('\n', start);
  const firstClose = APP_JS.indexOf('}', braceStart);
  if (firstClose > 0 && firstClose < lineEnd) {
    // 单行函数
    return APP_JS.slice(start + 1, firstClose + 1);
  }
  const end = APP_JS.indexOf('\n}', start);
  if (end < 0) throw new Error(`app.js 里 function ${name}() 的结尾没有找到`);
  return APP_JS.slice(start + 1, end + 2);
}

/** app.js 渲染器的闭包依赖（inlineMd → resolveWikiLink/postUrl/href → useHashMode/appRoot）。 */
const CLIENT_FUNCS = [
  'esc',
  'tokenizeCode',
  'renderMarkdown',
  'inlineMd',
  'relationTitleKey',
  'resolveWikiLink',
  'getStaticPosts',
  'getPublishedPosts',
  'slug',
  'postUrl',
  'href',
  'useHashMode',
  'appRoot'
];

const CLIENT_SRC = CLIENT_FUNCS.map(sliceFunction).join('\n');

interface ClientRenderer {
  renderMarkdown: (md: string) => string;
  esc: (value: unknown) => string;
  tokenizeCode: (lang: string, code: string) => string;
}

/** 造一个「浏览器里 app.js 的渲染器」，可注入 window.BLOG_POSTS。 */
function makeClientRenderer(blogPosts: WikiPostRef[] = []): ClientRenderer {
  // 只用到 window / location 两个全局；HTTP 协议下 useHashMode() 为 false。
  const factory = new Function(
    'window',
    'location',
    `${CLIENT_SRC}\nreturn { renderMarkdown, esc, tokenizeCode };`
  ) as (w: unknown, l: unknown) => ClientRenderer;
  return factory({ BLOG_POSTS: blogPosts }, { protocol: 'http:' });
}

const POSTS: WikiPostRef[] = [
  { id: 'hello', title: '你好世界' },
  { id: 'p-quote', title: '标题里带 "引号" 与 <标签> 的一篇' },
  { id: 'series-1', title: '系列第一篇' }
];

/* ---------- 夹具 ---------- */

const FIXTURES: Array<[string, string]> = [
  ['空正文', ''],
  ['纯段落', '正文示例内容。'],
  ['多段落', '第一段。\n\n第二段。\n\n\n第三段。'],
  ['标题 1-6', '# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级'],
  ['行内样式', '**加粗** *斜体* ~~删除~~ `code` 普通'],
  ['转义星号', '\\*不该斜体\\* 与 \\`不该代码\\`'],
  ['无序列表', '- 甲\n- 乙\n- 丙'],
  ['有序列表', '1. 甲\n2. 乙'],
  ['引用', '> 第一行引用\n> 第二行引用'],
  ['分割线', '正文\n\n---\n\n后文'],
  ['代码块 js', '```js\nconst a = 1; // 注释\nconsole.log("hi");\n```'],
  ['代码块 json', '```json\n{"a": 1}\n```'],
  ['代码块 未知语言', '```null\n<raw>\n```'],
  ['代码块 未闭合', '```js\nconst a = 1;'],
  ['表格', '| 姓名 | 年龄 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |'],
  ['图片', '![说明](/media/a.png)'],
  ['图片 javascript 协议', '![x](javascript:alert(1))'],
  ['链接', '[站点](https://example.com)'],
  ['链接 data 协议', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
  ['Smoji', '![smoji:微笑](https://s3-cdn.zsh.moe/smoji/smile.png)'],
  ['双链 按标题', '见 [[你好世界]]。'],
  ['双链 按 id', '见 [[hello]]。'],
  ['双链 别名', '见 [[hello|点这里]]。'],
  ['双链 不存在', '见 [[查无此文]]。'],
  ['双链 多段', '[[hello]] 和 [[系列第一篇]] 和 [[查无此文]]'],
  ['标题里的双链', '# 关于 [[你好世界]]'],
  ['列表里的双链', '- [[hello]]\n- [[查无此文]]'],
  ['XSS script 段落', '测转义与 XSS 防护 <script>alert(1)</script>'],
  ['XSS img onerror', '图 <img src=x onerror=alert(1)>'],
  ['XSS script 标题', '# <script>alert(1)</script>'],
  ['XSS iframe', '<iframe src="https://evil.example"></iframe>'],
  ['XSS 注释', '<!-- <script>alert(1)</script> -->'],
  ['混排', '# 标题\n\n正文 **粗** 与 [[hello]]。\n\n> 引用\n\n- 列表\n\n```py\nprint(1)\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |']
];

describe('SSR Markdown 渲染器 · 与 app.js 同构', () => {
  it('渲染器依赖的函数都还能从 app.js 抽出来', () => {
    expect(CLIENT_SRC).toContain('function renderMarkdown(');
    expect(CLIENT_SRC).toContain('function inlineMd(');
    expect(CLIENT_SRC.length).toBeGreaterThan(2000);
  });

  it.each(FIXTURES)('夹具一致：%s', (_name, md) => {
    const client = makeClientRenderer(POSTS);
    // 前端索引未加载时双链一律 .missing；带索引时才能解析。
    expect(renderMarkdown(md, POSTS)).toBe(client.renderMarkdown(md));
  });

  it('夹具一致：前端索引未加载（无 BLOG_POSTS）', () => {
    const client = makeClientRenderer([]);
    for (const [, md] of FIXTURES) {
      expect(renderMarkdown(md, [])).toBe(client.renderMarkdown(md));
    }
  });

  it('不传索引时，双链降级为 .missing —— 与前端索引未加载状态一致', () => {
    const client = makeClientRenderer([]);
    expect(renderMarkdown('见 [[你好世界]]。')).toBe(client.renderMarkdown('见 [[你好世界]]。'));
    expect(renderMarkdown('见 [[你好世界]]。')).toContain('<span class="wiki-link missing">');
  });

  it('esc / tokenizeCode 与 app.js 逐字符一致', () => {
    const client = makeClientRenderer();
    const samples = ['<a href="x">&amp;\'</a>', '普通文本', '&<>"\'', '汉字与 emoji 🙂'];
    for (const s of samples) {
      expect(__internals.esc(s)).toBe(client.esc(s));
    }
    expect(tokenizeCode('js', 'const a = 1; // 注释')).toBe(
      client.tokenizeCode('js', 'const a = 1; // 注释')
    );
  });

  it('标题锚点与代码块 class 与前端一致（首屏不抖动的前提）', () => {
    const html = renderMarkdown('# 一级\n\n```js\nconst a = 1;\n```');
    expect(html).toContain('<h1 id="toc-1">一级</h1>');
    expect(html).toContain('<pre class="code-block"><code class="lang-js">');
    expect(html).toContain('<span class="tok-kw">const</span>');
  });
});

describe('SSR Markdown 渲染器 · XSS 防护（正文按不可信内容处理）', () => {
  it('正文里的 <script> 被转义，不会变成可执行标签', () => {
    const html = renderMarkdown('测转义与 XSS 防护 <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('正文里的 img onerror / iframe 同样被转义', () => {
    const img = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(img).not.toContain('<img src=x');
    expect(img).toContain('&lt;img src=x onerror=alert(1)&gt;');

    const frame = renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(frame).not.toContain('<iframe');
    expect(frame).toContain('&lt;iframe');
  });

  it('标题、代码块、表格单元格里的原始 HTML 都转义', () => {
    expect(renderMarkdown('# <script>alert(1)</script>')).not.toContain('<script>');
    expect(renderMarkdown('```html\n<script>alert(1)</script>\n```')).not.toContain('<script>');
    expect(renderMarkdown('| a |\n| --- |\n| <script>alert(1)</script> |')).not.toContain('<script>');
  });

  it('渲染出的标签只在白名单内，且不带任何事件处理器', () => {
    const out = renderMarkdown(
      '正文 <script>alert(1)</script> 结束 <img src=x onerror=alert(1)> 还有 <svg onload=alert(1)>'
    );
    // 把输出里所有「真实标签」抠出来逐个校验：注入的 < 都已被转义成 &lt;，不会出现在这里
    const tags = out.match(/<[a-zA-Z/!][^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    const allowed =
      /^<\/?(?:p|br|hr|h[1-6]|strong|em|del|code|pre|span|ul|ol|li|blockquote|table|thead|tbody|tr|th|td|a|img)\b/i;
    for (const tag of tags) {
      expect(tag).toMatch(allowed);
      expect(tag).not.toMatch(/\son\w+\s*=/i);
    }
    // 注入内容原样可见（纯文本），但不可执行
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('javascript: / data: 链接与图片不被渲染成可点击目标', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript:');
    expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('src="javascript:');
    expect(renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('href="data:');
  });
});

describe('SSR Markdown 渲染器 · 双链解析', () => {
  it('按 id / 标题 / 别名解析成站内链接', () => {
    expect(renderMarkdown('[[hello]]', POSTS)).toContain('<a class="wiki-link" href="/posts/hello/">');
    expect(renderMarkdown('[[你好世界]]', POSTS)).toContain('href="/posts/hello/"');
    expect(renderMarkdown('[[hello|点这里]]', POSTS)).toContain('>点这里</a>');
  });

  it('解析不到时渲染 .missing，不产生死链', () => {
    const html = renderMarkdown('[[查无此文]]', POSTS);
    expect(html).toContain('<span class="wiki-link missing">查无此文</span>');
    expect(html).not.toContain('href=');
  });

  it('id 需要 URL 编码后再转义（与前端 esc(href(postUrl(id))) 一致）', () => {
    const posts: WikiPostRef[] = [{ id: "a'b", title: 'x' }];
    const html = renderMarkdown('[[x]]', posts);
    expect(html).toBe(makeClientRenderer(posts).renderMarkdown('[[x]]'));
    expect(html).toContain('&#39;');
  });
});
