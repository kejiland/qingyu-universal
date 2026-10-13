/* ============================================================
 * 旧正文 HTML 归一化
 * ------------------------------------------------------------
 * 早期从 WordPress 等平台导入的老文章，正文里混着原始 HTML：
 * 排版用的 `&nbsp;` 实体、`<!--more-->` 摘要分隔注释、
 * 早已无法播放的 Flash `<embed>/<object>` 播放器，以及正常的
 * `<p> <div> <img> <a>` 等排版标签。
 *
 * 服务端 SSR 用 marked 渲染：实体被浏览器解出、`<embed>` 不可见，
 * 看起来「还算正常」；但 app.js 接管后会用自己的 Markdown 渲染器重绘正文，
 * 那套渲染器对所有文本先做 HTML 转义，于是这些标记变成字面文字
 * （`&nbsp;&nbsp;`、`<!--more-->`、`<embed src=…>`）直接显示给读者。
 *
 * 这里在正文送进渲染器**之前**做一次归一化，让两端行为一致：
 *   1) 代码块与行内代码整体保护，其中的尖括号是正文，不当 HTML 处理；
 *   2) 去掉 HTML 注释（`<!--more-->` 等）；
 *   3) 去掉已死的 Flash / Applet 元素与无意义标签；
 *   4) 其余 HTML 标签抽成占位符，渲染完原样放回（属性做消毒）；
 *   5) 还原 HTML 实体，正文里不再露出 `&nbsp;` 字样。
 *
 * 注意：前端 app.js 里有同一套规则的等价实现（renderMarkdown 前置归一化），
 *       两侧必须同步修改，否则 SSR 与接管后渲染又会分叉。
 * ============================================================ */

/** 归一化结果：text 送渲染器，restore() 把保护段放回渲染结果。 */
export interface NormalizedLegacyHtml {
  text: string;
  restore(html: string): string;
}

/* 注释：`<!--more-->` / `<!--note-->` 之类的摘要标记 */
const COMMENT = /<!--[\s\S]*?-->/g;
/* 带内容删除：脚本、样式、Applet、Object（Flash/播放器外壳） */
const DROP_BLOCK = /<\s*(script|style|applet|object)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DROP_BLOCK_SELF = /<\s*(script|style|applet|object)\b[^>]*\/>/gi;
/* 只删标签、保留内部文本：embed/param（Flash 播放器）、base/meta/link（文档元信息） */
const DROP_TAG = /<\s*\/?\s*(embed|param|base|meta|link)\b[^>]*>/gi;
/* 剩下的行内/块级 HTML 标签：抽成占位符原样放回 */
const TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\/?>/g;
/* 抽取时若遇到未闭合残留的 script/style（正则没配对），直接丢弃 */
const UNCLOSED_DANGEROUS = /^<\s*\/?\s*(script|style|applet|object)\b/i;
/* 属性消毒：事件处理器、iframe srcdoc（可执行内联文档） */
const EVENT_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const SRCDOC_ATTR = /\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
/* 可执行协议（javascript:/vbscript:/data:text/html），仅限属性值 */
const BAD_URL_ATTR =
  /((?:href|src|xlink:href|action|formaction|poster|background|data)\s*=\s*)(["'])\s*(?:javascript|vbscript|livescript|mocha|data\s*:\s*text\/html)[^"']*\2/gi;

/** 常见命名实体（含希腊字母，老文章里常见）。 */
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  zwnj: '', zwj: '', iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥', brvbar: '¦', sect: '§',
  uml: '¨', copy: '©', ordf: 'ª', laquo: '«', not: '¬', reg: '®', macr: '¯', deg: '°', plusmn: '±',
  sup2: '²', sup3: '³', acute: '´', micro: 'µ', para: '¶', middot: '·', cedil: '¸', sup1: '¹',
  ordm: 'º', raquo: '»', frac14: '¼', frac12: '½', frac34: '¾', iquest: '¿', times: '×', divide: '÷',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  dagger: '†', Dagger: '‡', bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″',
  lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄', euro: '€', trade: '™',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  asymp: '≈', equiv: '≡', sum: '∑', prod: '∏', part: '∂', nabla: '∇', isin: '∈', notin: '∉',
  cap: '∩', cup: '∪', int: '∫', cong: '≅', sim: '∼', sube: '⊂', supe: '⊃', sub: '⊆', sup: '⊇',
  oplus: '⊕', otimes: '⊗', perp: '⊥', sdot: '⋅', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ',
  Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ',
  Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω'
};

const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,9});/g;

/* 「核心实体」解码后会变成真正的尖括号 / & ，必须等标签抽取做完再解，
 * 否则正文里作为**文本**展示的 `&lt;script&gt;` 会被当成真标签处理掉。 */
const CORE_ENTITY_NAMES = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);
const CORE_ENTITY_CODES = new Set([38, 60, 62, 34, 39]);

/** 标签属性消毒：去事件处理器 / srcdoc / 可执行协议。 */
export function sanitizeLegacyTag(tag: string): string {
  return tag
    .replace(EVENT_ATTR, '')
    .replace(SRCDOC_ATTR, '')
    .replace(BAD_URL_ATTR, '$1$2$2');
}

/**
 * 还原命名与数字实体；未知实体原样保留（交给上层按文本转义）。
 * includeCore=false 时跳过 &lt; &gt; &amp; &quot; &apos;（及对应数字实体）。
 */
export function decodeLegacyEntities(text: string, includeCore = true): string {
  return text.replace(ENTITY, (match, name: string) => {
    if (name.charAt(0) === '#') {
      const code =
        name.charAt(1) === 'x' || name.charAt(1) === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      if (!includeCore && CORE_ENTITY_CODES.has(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    if (!includeCore && CORE_ENTITY_NAMES.has(name.toLowerCase())) return match;
    const hit = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
    return hit === undefined ? match : hit;
  });
}

/**
 * 归一化旧正文里的原始 HTML，供 Markdown 渲染器安全使用。
 * 用法：`const n = normalizeLegacyHtml(content); marked.parse(n.text)` 渲染后 `n.restore(html)`。
 */
export function normalizeLegacyHtml(markdown: unknown): NormalizedLegacyHtml {
  const stash: string[] = [];
  let text = String(markdown ?? '');

  const protect = (re: RegExp, keep?: (m: string) => string): void => {
    text = text.replace(re, (m) => {
      stash.push(keep ? keep(m) : m);
      return `\u0002${stash.length - 1}\u0002`;
    });
  };

  // 1) 代码块与行内代码：整体保护，渲染完原样放回
  protect(/```[\s\S]*?(?:```|$)/g);
  protect(/`[^`\n]*`/g);
  // 2) 注释
  text = text.replace(COMMENT, '');
  // 3) 死元素
  text = text.replace(DROP_BLOCK, '').replace(DROP_BLOCK_SELF, '').replace(DROP_TAG, '');
  // 4) 排版实体先还原（&nbsp; &hellip; …），正文里不再露出 "&nbsp;" 字样
  text = decodeLegacyEntities(text, false);
  // 5) 其余标签抽成占位符（属性消毒后保存）
  protect(TAG, (tag) => (UNCLOSED_DANGEROUS.test(tag) ? '' : sanitizeLegacyTag(tag)));
  // 6) 核心实体最后还原：此时文本里的 &lt;script&gt; 只会作为文字展示，
  //    不会被当成真标签（`&amp;nbsp;` 这种双重编码也因此保持字面量）
  text = decodeLegacyEntities(text, true);

  return {
    text,
    restore(html: string): string {
      return String(html ?? '').replace(/\u0002(\d+)\u0002/g, (m, idx: string) => stash[Number(idx)] ?? '');
    }
  };
}