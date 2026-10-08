/* ============================================================
 * 通用版「自有前端增强」补丁（幂等）
 * ------------------------------------------------------------
 * 下面这些改动是我们相对上游 qingyu-blog 的产品增强，不属于上游仓库；
 * 每次用上游 public/ 覆盖 app/public 后，必须由本脚本重新贴回。
 * 已经贴过则只校验、不重复插入；锚点找不到会直接报错，避免「静默丢失」。
 *
 *   1. 首页「站点概览」卡片 —— app.js 的 renderHomeStats() 与它的调用点
 *   2. 主题色 WCAG AA 校准 —— style.css 的 --accent 系列变量
 *   3. 五语「站点概览」文案 —— i18n.js 内嵌中文兜底 + locales/*.json
 *   4. 后台补充文案（admin.extra.*）—— 自托管版独有的界面元素（访问统计、
 *      新手上路、主题切换提示等），Vue 后台与前台共用同一套词典，缺键会露键名
 *
 * 同步链路：npm run sync:upstream
 *   = apply-upstream-adapters（业务接缝）
 *   → apply-frontend-split（首屏拆分 + 展示层补丁）
 *   → apply-own-patches（本脚本）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'app/public');
const read = (name) => fs.readFileSync(path.join(PUB, name), 'utf8');
const write = (name, text) => fs.writeFileSync(path.join(PUB, name), text, 'utf8');
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const report = [];

function replaceOnce(text, from, to, label) {
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`${label}：锚点命中 ${hits} 次（期望 1 次），上游结构可能已变化`);
  return text.split(from).join(to);
}

/* ---------- 1. 首页「站点概览」卡片 ---------- */

const HOME_STATS_FN = `/* 首页「站点概览」小卡片：文章数 / 分类 / 标签 / 总字数 / 最近更新。
 * 数据全部来自已经加载好的文章列表，不额外请求接口，首屏零等待。 */
function renderHomeStats(posts) {
  if (!posts || !posts.length) return '';
  var cats = {};
  var tags = {};
  var words = 0;
  var latest = '';
  var latestId = '';
  posts.forEach(function (p) {
    var cat = String(p.category || '').trim();
    if (cat) cats[cat] = 1;
    normalizeTags(p).forEach(function (tag) { tags[tag] = 1; });
    var text = stripMd(p.content || p.search || '');
    // 中文按字计、英文按词计，混排时用「字符数 + 英文词数」近似总字数
    var cjk = (text.match(/[\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7af]/g) || []).length;
    var other = text.replace(/[\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7af]/g, ' ').match(/[A-Za-z0-9'\\u00c0-\\u024f]+/g);
    words += cjk + (other ? other.length : 0);
    var d = fmtDate(p.date || p.createdAt || p.updatedAt || '');
    if (d && d > latest) { latest = d; latestId = p.id || ''; }
  });
  var items = [
    { k: 'home.stats.posts', v: String(posts.length) },
    { k: 'home.stats.categories', v: String(Object.keys(cats).length) },
    { k: 'home.stats.tags', v: String(Object.keys(tags).length) },
    { k: 'home.stats.words', v: words >= 10000 ? (words / 10000).toFixed(1) + 'w' : (words >= 1000 ? (words / 1000).toFixed(1) + 'k' : String(words)) }
  ];
  if (latest) items.push({ k: 'home.stats.updated', v: latest, href: latestId ? href(postUrl(latestId)) : '' });
  var cells = items.map(function (it) {
    var inner = '<span class="home-stat-v">' + esc(it.v) + '</span>'
      + '<span class="home-stat-k">' + esc(t(it.k)) + '</span>';
    return it.href
      ? '<a class="home-stat home-stat-link" href="' + esc(it.href) + '">' + inner + '</a>'
      : '<div class="home-stat">' + inner + '</div>';
  }).join('');
  return '<section class="home-stats" aria-label="' + esc(t('home.stats.title')) + '">'
    + '<div class="home-stats-title">' + svgIcon('star', 14) + '<span>' + esc(t('home.stats.title')) + '</span></div>'
    + '<div class="home-stats-grid">' + cells + '</div>'
    + '</section>';
}`;

function patchHomeStats() {
  let app = read('app.js');
  const nl = eolOf(app);

  if (app.includes('function renderHomeStats(')) {
    if (!app.includes('html += renderHomeStats(posts);')) {
      throw new Error('renderHomeStats 已存在但首页调用点缺失，请人工核对');
    }
    report.push('[skip] 首页站点概览卡片已存在');
    return;
  }
  if (!app.includes('function fmtDate(')) {
    throw new Error('renderHomeStats 依赖 fmtDate()，请先运行 apply-frontend-split.mjs');
  }

  const fn = HOME_STATS_FN.replace(/\n/g, nl);
  app = replaceOnce(app, 'function renderHome() {', fn + nl + 'function renderHome() {', 'app.js：renderHome 定义');
  app = replaceOnce(
    app,
    '  html += renderHomeTagRow(posts, tag);',
    '  html += renderHomeTagRow(posts, tag);' + nl + '  html += renderHomeStats(posts);',
    'app.js：renderHome 调用点'
  );
  write('app.js', app);
  report.push('[ok]   首页站点概览卡片（renderHomeStats + 调用点）');
}

/* ---------- 2. 主题色 WCAG AA 校准 ---------- */
/* 上游默认色在浅底/深底上个别组合低于 AA（4.5:1），这里换成校准后的等价色。
 * 只改色值，不改任何选择器与结构。 */

const THEME_COLORS = [
  // 默认浅色（terra）：主色压深、柔色提亮
  ['  --accent: #c25e3a;\n  --accent-soft: #f6e6df;', '  --accent: #a95233;\n  --accent-soft: #f8ebe5;'],
  // 默认深色（terra）：主色偏亮 → 按钮文字改用深色字
  [
    '  --accent: #e08a63;\n  --accent-soft: #3a2c22;\n  --accent-2: #d97d4a;\n  --accent-fg: #fff;',
    '  --accent: #e08a63;\n  --accent-soft: #3a2c22;\n  --accent-2: #d97d4a;\n  --accent-fg: #171512; /* 深色主题按钮用深色字，保证 ≥4.5:1 */'
  ],
  ['浅色模式主色在浅底 ≥4.7:1', '浅色模式主色在浅底 ≥4.5:1'],
  ['  --accent: #c25e3a; --accent-soft: #f6e6df;', '  --accent: #a95233; --accent-soft: #f8ebe5;'],
  ['  --accent: #e08a63; --accent-soft: #3a2c22; --accent-2: #d97d4a; --accent-fg: #fff;', '  --accent: #e08a63; --accent-soft: #3a2c22; --accent-2: #d97d4a; --accent-fg: #171512;'],
  // indigo
  ['  --accent: #2b73af; --accent-soft: #d9e7f5; --accent-2: #1661ab;', '  --accent: #22689f; --accent-soft: #e1ecf7; --accent-2: #1b5c8f;'],
  ['  --accent: #619ac3; --accent-soft: #223144;', '  --accent: #619ac3; --accent-soft: #202d3f;'],
  // bamboo
  ['  --accent: #497568; --accent-soft: #e2ece6; --accent-2: #6e8b74;', '  --accent: #436a5e; --accent-soft: #e8f0eb; --accent-2: #67846e;'],
  ['  --accent: #1ba784; --accent-soft: #1c3429;', '  --accent: #1ba784; --accent-soft: #1b3127;'],
  // dusk 深色
  [
    '  --accent: #ad6598; --accent-soft: #362640; --accent-2: #c98ab9; --accent-fg: #fff;',
    '  --accent: #bd7fab; --accent-soft: #35253f; --accent-2: #d3a2c6; --accent-fg: #241a26;'
  ]
];

function patchThemeContrast() {
  let css = read('style.css');
  const nl = eolOf(css);

  if (css.includes('--accent: #a95233;')) {
    report.push('[skip] 主题色校准已存在');
    return;
  }

  let done = 0;
  for (const [fromRaw, toRaw] of THEME_COLORS) {
    // 单行锚点两侧可能夹在长行里，仍用精确子串替换；多行锚点按文件行尾拼接
    const from = fromRaw.replace(/\n/g, nl);
    const to = toRaw.replace(/\n/g, nl);
    css = replaceOnce(css, from, to, `style.css：${from.trim().slice(0, 42)}`);
    done++;
  }
  write('style.css', css);
  report.push(`[ok]   主题色 WCAG AA 校准（${done} 处）`);

  // 校准会影响 style.min.css，提醒构建阶段产物需重新生成
  report.push('       注意：style.min.css 需由 npm run frontend:build 重新压缩');
}

/* ---------- 3. 五语「站点概览」文案 ---------- */

const STATS_KEYS = [
  'home.stats.title',
  'home.stats.posts',
  'home.stats.categories',
  'home.stats.tags',
  'home.stats.words',
  'home.stats.updated',
  'home.stats.none'
];

const STATS_TEXT = {
  'zh-CN': ['站点概览', '文章', '分类', '标签', '总字数', '最近更新', '还没有可统计的内容'],
  en: ['At a glance', 'Posts', 'Categories', 'Tags', 'Words', 'Updated', 'Nothing to summarise yet'],
  ja: ['サイト概要', '記事', 'カテゴリ', 'タグ', '総文字数', '最終更新', 'まだ集計できる内容がありません'],
  ko: ['사이트 요약', '글', '카테고리', '태그', '총 글자', '최근 업데이트', '아직 집계할 내용이 없습니다'],
  hi: ['साइट अवलोकन', 'पोस्ट', 'श्रेणियाँ', 'टैग', 'शब्द', 'अंतिम अद्यतन', 'अभी दिखाने को कुछ नहीं']
};

/** 在 `"home.latest"` 那一行之后插入概览文案；JSON 的缩进沿用锚点行。 */
function insertAfterHomeLatest(text, values, nl) {
  const lines = text.split(nl);
  const idx = lines.findIndex((l) => l.includes('"home.latest"'));
  if (idx < 0) throw new Error('locales：未找到 "home.latest" 锚点');
  if (lines.some((l) => l.includes('"home.stats.title"'))) return { text, inserted: false };
  const indent = (lines[idx].match(/^\s*/) || [''])[0];
  const added = STATS_KEYS.map((k, i) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(values[i])},`);
  lines.splice(idx + 1, 0, ...added);
  return { text: lines.join(nl), inserted: true };
}

function patchI18nTexts() {
  /* 3a. i18n.js 内嵌中文兜底（_BUILTIN_ZH） */
  let i18n = read('i18n.js');
  const nl = eolOf(i18n);
  const anchor = '    "home.latest": "最新发布",';
  if (!i18n.includes('"home.stats.title"')) {
    if (!i18n.includes(anchor)) throw new Error('i18n.js：未找到 _BUILTIN_ZH 的 home.latest 锚点');
    const added = STATS_KEYS
      .map((k, i) => `    ${JSON.stringify(k)}: ${JSON.stringify(STATS_TEXT['zh-CN'][i])},`)
      .join(nl);
    i18n = replaceOnce(i18n, anchor, anchor + nl + added, 'i18n.js：_BUILTIN_ZH 概览文案');
    // 改了 locales 内容，按项目约定递增语言包版本，强制客户端拉新 JSON
    const ver = i18n.match(/I18N_VER = '(\d+)'/);
    if (ver) i18n = i18n.replace(`I18N_VER = '${ver[1]}'`, `I18N_VER = '${Number(ver[1]) + 1}'`);
    write('i18n.js', i18n);
    report.push('[ok]   i18n.js 内嵌中文兜底 + 语言包版本递增');
  } else {
    report.push('[skip] i18n.js 概览文案已存在');
  }

  /* 3b. locales/*.json 五语 */
  const done = [];
  for (const lang of Object.keys(STATS_TEXT)) {
    const name = `locales/${lang}.json`;
    const raw = read(name);
    const res = insertAfterHomeLatest(raw, STATS_TEXT[lang], eolOf(raw));
    if (res.inserted) {
      write(name, res.text);
      done.push(lang);
    }
  }
  report.push(done.length ? `[ok]   locales 概览文案：${done.join(' / ')}` : '[skip] locales 概览文案已存在');
}

/* ---------- 4. 后台自托管版独有文案 ---------- */
/* Vue 后台复用前台这套词典（`admin.*` 就是后台文案）。但「访问统计」「新手上路」
 * 「主题切换提示」是自托管版独有的界面元素，上游没有对应键，这里补上，
 * 否则切到其它语言时这些位置会显示成键名。 */

const EXTRA_KEYS = [
  'admin.extra.stats',
  'admin.extra.statsDesc',
  'admin.extra.guide',
  'admin.extra.themeLight',
  'admin.extra.themeDark',
  'admin.extra.siderExpand',
  'admin.extra.siderCollapse',
  'admin.extra.advancedSettings',
  'admin.extra.advancedSettingsDesc',
  'admin.extra.notMigrated',
  /* 页头副标题：上游后台页头只有主标题，Vue 版每页多一行说明，沿用上游
   * 已有的 `.desc` 措辞；只有这三页上游没有对应句，这里补上。 */
  'admin.extra.newPostDesc',
  'admin.extra.editPostDesc',
  'admin.extra.pendingDesc',
  /* 壳层无障碍与提示语 */
  'admin.extra.closeMenu',
  'admin.extra.loggedOut',
  'admin.extra.breadcrumb',
  /* AI 模型配置页：自托管版专有（上游 Cloudflare 版是平台绑定 env.AI，
   * 没有网关 / Key / 模型这些概念，也就没有这套文案）。
   * 缺键时 t() 会原样吐键名显示在界面上，所以五语必须一次补齐。 */
  'admin.sidebar.ai',
  'admin.ai.title',
  'admin.ai.subtitle',
  'admin.ai.desc',
  'admin.ai.updatedAt',
  'admin.ai.envHint',
  'admin.ai.notSet',
  'admin.ai.overridden',
  'admin.ai.followingEnv',
  'admin.ai.followHint',
  'admin.ai.gateway',
  'admin.ai.baseUrl',
  'admin.ai.baseUrlHint',
  'admin.ai.apiKey',
  'admin.ai.apiKeyPh',
  'admin.ai.apiKeyKeep',
  'admin.ai.apiKeyWillReplace',
  'admin.ai.toggleKey',
  'admin.ai.model',
  'admin.ai.modelHint',
  'admin.ai.advanced',
  'admin.ai.timeout',
  'admin.ai.timeoutHint',
  'admin.ai.retries',
  'admin.ai.retriesHint',
  'admin.ai.enable',
  'admin.ai.enableHint',
  'admin.ai.public',
  'admin.ai.publicHint',
  'admin.ai.on',
  'admin.ai.off',
  'admin.ai.followEnv',
  'admin.ai.resetTitle',
  'admin.ai.resetHint',
  'admin.ai.reset',
  'admin.ai.resetOk',
  'admin.ai.save',
  'admin.ai.saving',
  'admin.ai.saved',
  'admin.ai.saveFail',
  'admin.ai.test',
  'admin.ai.testing',
  'admin.ai.testOk',
  'admin.ai.testFail',
  'admin.ai.loadFail',
  'admin.ai.retry'
];

const EXTRA_TEXT = {
  'zh-CN': [
    '访问统计', '流量趋势与来源分布', '新手上路', '切换到浅色', '切换到深色', '展开侧栏', '收起侧栏',
    '高级设置', '导航、页脚、公告、功能开关、评论规则与广告位', '尚未迁移',
    '支持 Markdown、AI 助手与定时发布', '修改正文、标签与发布设置', '优先处理访客的新留言',
    '关闭菜单', '已退出登录', '面包屑',
    /* AI 模型页 */
    'AI 模型', 'AI 模型', '配置 AI 摘要与写作助手使用的模型服务',
    '这里填的值会覆盖 .env 里的 AI_* 配置，保存后立即生效，无需重启',
    '上次更新', '留空则沿用 .env', '未设置',
    '当前已用后台配置覆盖 .env', '当前完全沿用 .env 的配置',
    '输入框留空表示沿用 .env 的值；填了才覆盖。',
    '网关与模型', '接口地址', 'OpenAI 兼容地址，需带 /v1（如 https://api.deepseek.com/v1）',
    'API Key', '输入新的 API Key', '未修改：保持当前已保存的 Key', '已修改：保存后替换当前 Key',
    '显示 / 隐藏', '模型名称', '可下拉选常见模型，也可直接输入任意模型名',
    '超时与开关', '超时（毫秒）', '单次请求的超时时间，网关较慢时可调大',
    '额外重试次数', '网络错误、超时、429/5xx 时重试；-1 表示沿用 .env',
    '启用 AI', '关闭后前台不再显示 AI 摘要与写作助手',
    '允许访客触发生成', '关闭后仅管理员可生成，避免额度被刷',
    '开', '关', '沿用 .env',
    '恢复为 .env 配置', '清空此处保存的全部覆盖值（含 API Key），回到完全由 .env 决定。',
    '清空覆盖', '已恢复为 .env 配置',
    '保存', '保存中…', '已保存，立即生效', '保存失败',
    '测试连接', '测试中…', '连接正常', '连接失败',
    '加载 AI 配置失败', '重试'
  ],
  en: [
    'Traffic', 'Traffic trends and referrer breakdown', 'Getting started', 'Switch to light theme',
    'Switch to dark theme', 'Expand sidebar', 'Collapse sidebar',
    'Advanced settings', 'Navigation, footer, announcement, feature toggles, comment rules and ads',
    'Not migrated yet',
    'Markdown, AI assistant and scheduled publishing', 'Edit the body, tags and publishing options',
    'Handle new visitor comments first',
    'Close menu', 'Signed out', 'Breadcrumb',
    /* AI models page */
    'AI models', 'AI models', 'Configure the model service behind AI summaries and the writing assistant',
    'Values here override the AI_* settings in .env and apply immediately — no restart',
    'Last updated', 'blank = use .env', 'not set',
    'Admin settings currently override .env', 'Currently using .env values only',
    'Blank fields fall back to .env; only filled fields override it.',
    'Gateway and model', 'API base URL', 'OpenAI-compatible URL, must include /v1 (e.g. https://api.deepseek.com/v1)',
    'API key', 'Enter a new API key', 'Unchanged: the saved key is kept', 'Changed: replaces the saved key on save',
    'Show / hide', 'Model name', 'Pick a common model or type any model name',
    'Timeouts and toggles', 'Timeout (ms)', 'Per-request timeout; raise it for slow gateways',
    'Extra retries', 'Retries on network errors, timeouts, 429/5xx; -1 means use .env',
    'Enable AI', 'When off, AI summaries and the writing assistant are hidden',
    'Let visitors trigger generation', 'When off, only admins can generate — protects your quota',
    'On', 'Off', 'Use .env',
    'Restore .env configuration', 'Clear every override saved here (including the API key) and let .env decide again.',
    'Clear overrides', 'Restored to .env configuration',
    'Save', 'Saving…', 'Saved — applies immediately', 'Save failed',
    'Test connection', 'Testing…', 'Connection OK', 'Connection failed',
    'Failed to load AI settings', 'Retry'
  ],
  ja: [
    'アクセス統計', 'アクセス推移と参照元の内訳', 'はじめに', 'ライトテーマに切り替え',
    'ダークテーマに切り替え', 'サイドバーを展開', 'サイドバーを折りたたむ',
    '詳細設定', 'ナビ・フッター・お知らせ・機能スイッチ・コメント規則・広告枠', '未移行',
    'Markdown・AI アシスタント・予約投稿に対応', '本文・タグ・公開設定を編集',
    '訪問者からの新しいコメントを優先対応',
    'メニューを閉じる', 'ログアウトしました', 'パンくずリスト',
    /* AI モデル設定ページ */
    'AI モデル', 'AI モデル', 'AI 要約と執筆アシスタントが使うモデルサービスを設定します',
    'ここに入力した値は .env の AI_* 設定を上書きし、保存後すぐ反映されます（再起動不要）',
    '最終更新', '空欄なら .env を使用', '未設定',
    '現在は管理画面の設定が .env を上書きしています', '現在は .env の設定のみを使用しています',
    '空欄の項目は .env の値を引き継ぎます。入力した項目だけ上書きされます。',
    'ゲートウェイとモデル', 'API ベース URL', 'OpenAI 互換 URL（/v1 まで含める、例 https://api.deepseek.com/v1）',
    'API キー', '新しい API キーを入力', '未変更：保存済みのキーを保持', '変更あり：保存時にキーを置換',
    '表示 / 非表示', 'モデル名', 'よく使うモデルから選択、または任意のモデル名を入力',
    'タイムアウトとスイッチ', 'タイムアウト（ミリ秒）', '1 リクエストのタイムアウト。遅いゲートウェイなら大きく',
    '追加リトライ回数', 'ネットワークエラー・タイムアウト・429/5xx で再試行。-1 は .env を使用',
    'AI を有効化', 'オフにすると AI 要約と執筆アシスタントが表示されません',
    '訪問者の生成を許可', 'オフにすると管理者のみ生成可能（消費量の保護）',
    'オン', 'オフ', '.env を使用',
    '.env 設定に戻す', 'ここに保存した上書きをすべて消去し（API キー含む）、.env の設定に戻します。',
    '上書きを消去', '.env の設定に戻しました',
    '保存', '保存中…', '保存しました — すぐ反映されます', '保存に失敗',
    '接続テスト', 'テスト中…', '接続成功', '接続失敗',
    'AI 設定の読み込みに失敗', '再試行'
  ],
  ko: [
    '방문 통계', '트래픽 추세와 유입 경로', '시작하기', '라이트 테마로 전환',
    '다크 테마로 전환', '사이드바 펼치기', '사이드바 접기',
    '고급 설정', '내비게이션·푸터·공지·기능 스위치·댓글 규칙·광고', '아직 이전되지 않음',
    'Markdown, AI 어시스턴트, 예약 발행 지원', '본문, 태그, 발행 설정 수정',
    '방문자의 새 댓글을 우선 처리',
    '메뉴 닫기', '로그아웃되었습니다', '이동 경로',
    /* AI 모델 설정 페이지 */
    'AI 모델', 'AI 모델', 'AI 요약과 집필 도우미가 사용할 모델 서비스를 설정합니다',
    '여기에 입력한 값은 .env의 AI_* 설정을 덮어쓰며, 저장 즉시 반영됩니다(재시작 불필요)',
    '마지막 업데이트', '비워두면 .env 사용', '설정되지 않음',
    '현재 관리자 설정이 .env를 덮어쓰고 있습니다', '현재 .env 설정만 사용합니다',
    '빈 칸은 .env 값을 따르며, 입력한 항목만 덮어씁니다.',
    '게이트웨이와 모델', 'API 기본 주소', 'OpenAI 호환 주소, /v1 포함 필요(예: https://api.deepseek.com/v1)',
    'API 키', '새 API 키 입력', '변경 없음: 저장된 키 유지', '변경됨: 저장 시 키 교체',
    '표시 / 숨기기', '모델 이름', '자주 쓰는 모델을 고르거나 임의의 모델명 입력',
    '타임아웃과 스위치', '타임아웃(ms)', '요청 1회 제한 시간. 느린 게이트웨이는 키우세요',
    '추가 재시도 횟수', '네트워크 오류·타임아웃·429/5xx 시 재시도. -1은 .env 사용',
    'AI 사용', '끄면 AI 요약과 집필 도우미가 숨겨집니다',
    '방문자 생성을 허용', '끄면 관리자만 생성 가능(사용량 보호)',
    '켜기', '끄기', '.env 사용',
    '.env 설정으로 복원', '여기에 저장된 모든 재정의(API 키 포함)를 지우고 .env 설정으로 돌아갑니다.',
    '재정의 지우기', '.env 설정으로 복원했습니다',
    '저장', '저장 중…', '저장됨 — 즉시 반영됩니다', '저장 실패',
    '연결 테스트', '테스트 중…', '연결 정상', '연결 실패',
    'AI 설정을 불러오지 못했습니다', '다시 시도'
  ],
  hi: [
    'ट्रैफ़िक', 'ट्रैफ़िक रुझान और रेफ़रर विवरण', 'शुरुआत करें', 'लाइट थीम पर जाएँ',
    'डार्क थीम पर जाएँ', 'साइडबार खोलें', 'साइडबार बंद करें',
    'उन्नत सेटिंग्स', 'नेविगेशन, फ़ुटर, घोषणा, फ़ीचर टॉगल, टिप्पणी नियम और विज्ञापन',
    'अभी स्थानांतरित नहीं',
    'Markdown, AI सहायक और निर्धारित प्रकाशन समर्थित', 'मुख्य सामग्री, टैग और प्रकाशन सेटिंग बदलें',
    'आगंतुकों की नई टिप्पणियाँ पहले निपटाएँ',
    'मेन्यू बंद करें', 'साइन आउट हो गया', 'ब्रेडक्रम्ब',
    /* AI मॉडल सेटिंग पृष्ठ */
    'AI मॉडल', 'AI मॉडल', 'AI सारांश और लेखन सहायक के लिए मॉडल सेवा कॉन्फ़िगर करें',
    'यहाँ दर्ज मान .env की AI_* सेटिंग्स को ओवरराइड करते हैं और तुरंत लागू होते हैं (रीस्टार्ट आवश्यक नहीं)',
    'अंतिम अद्यतन', 'खाली छोड़ें = .env उपयोग', 'सेट नहीं',
    'वर्तमान में व्यवस्थापक सेटिंग्स .env को ओवरराइड कर रही हैं', 'वर्तमान में केवल .env मान उपयोग हो रहे हैं',
    'खाली फ़ील्ड .env के मान का उपयोग करते हैं; केवल भरे गए फ़ील्ड ओवरराइड करते हैं।',
    'गेटवे और मॉडल', 'API बेस URL', 'OpenAI-संगत पता, /v1 सहित (जैसे https://api.deepseek.com/v1)',
    'API कुंजी', 'नई API कुंजी दर्ज करें', 'अपरिवर्तित: सहेजी गई कुंजी रहेगी', 'परिवर्तित: सहेजने पर कुंजी बदलेगी',
    'दिखाएँ / छिपाएँ', 'मॉडल नाम', 'सामान्य मॉडल चुनें या कोई भी मॉडल नाम दर्ज करें',
    'टाइमआउट और स्विच', 'टाइमआउट (ms)', 'प्रति अनुरोध समय-सीमा; धीमे गेटवे के लिए बढ़ाएँ',
    'अतिरिक्त पुनः प्रयास', 'नेटवर्क त्रुटि, टाइमआउट, 429/5xx पर पुनः प्रयास; -1 = .env उपयोग',
    'AI सक्षम करें', 'बंद करने पर AI सारांश और लेखन सहायक छिप जाते हैं',
    'आगंतुकों को जनरेट करने दें', 'बंद करने पर केवल व्यवस्थापक जनरेट कर सकते हैं (कोटा सुरक्षा)',
    'चालू', 'बंद', '.env उपयोग करें',
    '.env कॉन्फ़िगरेशन पर वापस', 'यहाँ सहेजी गई सभी ओवरराइड (API कुंजी सहित) साफ़ करें और .env को निर्णय लेने दें।',
    'ओवरराइड साफ़ करें', '.env कॉन्फ़िगरेशन पर वापस',
    'सहेजें', 'सहेज रहा है…', 'सहेजा गया — तुरंत लागू', 'सहेजना विफल',
    'कनेक्शन जाँच', 'जाँच रहा है…', 'कनेक्शन ठीक', 'कनेक्शन विफल',
    'AI सेटिंग्स लोड नहीं हो सकीं', 'पुनः प्रयास'
  ]
};

/**
 * 在 `"admin.sidebar.dashboard"` 那一行之后**补齐缺失的键**（已存在的不动）。
 * 必须按「缺哪个补哪个」来写：整体跳过的话，后续再想加键就永远插不进去了。
 */
function insertAfterAdminAnchor(text, values, nl) {
  const lines = text.split(nl);
  const idx = lines.findIndex((l) => l.includes('"admin.sidebar.dashboard"'));
  if (idx < 0) throw new Error('locales：未找到 "admin.sidebar.dashboard" 锚点');
  const indent = (lines[idx].match(/^\s*/) || [''])[0];
  const added = EXTRA_KEYS
    .map((k, i) => ({ k, line: `${indent}${JSON.stringify(k)}: ${JSON.stringify(values[i])},` }))
    .filter(({ k }) => !lines.some((l) => l.includes(`${JSON.stringify(k)}:`)))
    .map(({ line }) => line);
  if (!added.length) return { text, inserted: 0 };
  lines.splice(idx + 1, 0, ...added);
  return { text: lines.join(nl), inserted: added.length };
}

function patchAdminExtraTexts() {
  /* 4a. i18n.js 内嵌中文兜底：file:// 本地预览时用得上 */
  let i18n = read('i18n.js');
  const nl = eolOf(i18n);
  const anchor = '    "admin.sidebar.dashboard": "仪表盘",';
  const missingBuiltin = EXTRA_KEYS
    .map((k, i) => ({ k, line: `    ${JSON.stringify(k)}: ${JSON.stringify(EXTRA_TEXT['zh-CN'][i])},` }))
    .filter(({ k }) => !i18n.includes(`${JSON.stringify(k)}:`))
    .map(({ line }) => line);

  if (missingBuiltin.length) {
    if (!i18n.includes(anchor)) throw new Error('i18n.js：未找到 _BUILTIN_ZH 的 admin.sidebar.dashboard 锚点');
    i18n = replaceOnce(i18n, anchor, anchor + nl + missingBuiltin.join(nl), 'i18n.js：_BUILTIN_ZH 后台补充文案');
    const ver = i18n.match(/I18N_VER = '(\d+)'/);
    if (ver) i18n = i18n.replace(`I18N_VER = '${ver[1]}'`, `I18N_VER = '${Number(ver[1]) + 1}'`);
    write('i18n.js', i18n);
    report.push(`[ok]   i18n.js 后台补充文案 ${missingBuiltin.length} 条 + 语言包版本递增`);
  } else {
    report.push('[skip] i18n.js 后台补充文案已齐全');
  }

  /* 4b. locales/*.json 五语 */
  let total = 0;
  const langs = [];
  for (const lang of Object.keys(EXTRA_TEXT)) {
    const name = `locales/${lang}.json`;
    const raw = read(name);
    const res = insertAfterAdminAnchor(raw, EXTRA_TEXT[lang], eolOf(raw));
    if (res.inserted) {
      write(name, res.text);
      total += res.inserted;
      langs.push(`${lang}(${res.inserted})`);
    }
  }
  report.push(total ? `[ok]   locales 后台补充文案：${langs.join(' / ')}` : '[skip] locales 后台补充文案已齐全');
}

/* ---------- 5. 页脚「建站年份 / ICP 备案号」接入站点设置 ---------- */
/* 上游 getConfig() 只把 site_info 的 copyright / footerText 叠加到页脚，
 * 而 startYear（版权起始年）与 icp（备案号）只从静态 config.js 读 ——
 * 后台虽然给了输入框（存 site_info），前台却永远显示不出用户填的值，
 * 属于「后台配得出来、前台不消费」的假设置项。这里把这两个字段接进
 * 同一条覆盖链，取值口径与上游已有的两行完全一致（site_info 优先）。 */

const FOOTER_IDENTITY_ANCHOR =
  '  if (siteInfo.footerText) footer = Object.assign({}, footer, { decl: siteInfo.footerText });';

function patchFooterIdentity() {
  let app = read('app.js');
  const nl = eolOf(app);

  if (app.includes('if (siteInfo.startYear)')) {
    report.push('[skip] 页脚建站年份 / 备案号覆盖链已存在');
    return;
  }
  if (!app.includes(FOOTER_IDENTITY_ANCHOR)) {
    throw new Error('app.js：未找到 siteInfo.footerText 覆盖锚点，上游结构可能已变化');
  }

  const added =
    FOOTER_IDENTITY_ANCHOR + nl +
    '  /* 自托管版：建站年份与备案号同样走站点设置（上游只能改静态 config.js）。 */' + nl +
    '  if (siteInfo.startYear) footer = Object.assign({}, footer, { startYear: siteInfo.startYear });' + nl +
    '  if (siteInfo.icp) footer = Object.assign({}, footer, { icp: siteInfo.icp });';
  app = replaceOnce(app, FOOTER_IDENTITY_ANCHOR, added, 'app.js：页脚 footerText 覆盖行');
  write('app.js', app);
  report.push('[ok]   页脚建站年份 / 备案号接入 site_info 覆盖链');
}

/* ---------- 6. AI 请求的前端超时放宽 ---------- */
/* 前台 apiFetch() 对所有请求统一 8 秒 abort（app.js「超时兜底」注释）。
 * 上游 Workers AI 常在 2-5s 内返回，8s 够用；自托管接 OpenAI 兼容网关后，
 * 一次摘要生成普遍要 3-12s，偶发慢到几十秒 —— 8s 会把**正常**生成掐断，
 * 前端拿到的是一条难懂的「signal is aborted without reason」。
 * 这里给 apiFetch 加 opts.timeoutMs 覆盖（上游恒为 8000，行为不变），
 * 并在 AI 调用点传入 60s。后端适配器另有 AI_TIMEOUT_MS（默认 60s）兜底，
 * 两边取交集：后端先超时会回 502「AI 服务暂不可用」，文案仍然友好。 */

function patchAiTimeout() {
  const OLD_TIMER = 'var timer = ac ? setTimeout(function () { ac.abort(); }, 8000) : null;';
  const SUMMARY_CALL = "apiFetch('api/ai/summary', { method: 'POST', body: JSON.stringify({ slug: slug, lang: aiLang(), force: force }) })";
  const SUMMARY_NEW = "apiFetch('api/ai/summary', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ slug: slug, lang: aiLang(), force: force }) })";

  let app = read('app.js');
  const nlApp = eolOf(app);
  const nl = nlApp;
  const NEW_TIMER =
    '/* 自托管增强：AI 请求（摘要生成等）走第三方网关普遍要 3-12s，' + nl +
    '   * 8s 会把正常生成掐断；调用方可用 opts.timeoutMs 覆盖，上游恒为 8000。 */' + nl +
    '  var timer = ac ? setTimeout(function () { ac.abort(); }, Number(opts && opts.timeoutMs) || 8000) : null;';
  const oldTimerApp = OLD_TIMER;
  const newTimerApp = NEW_TIMER.split(nl).join(nlApp);
  let changed = false;
  if (app.includes('Number(opts && opts.timeoutMs)')) {
    report.push('[skip] app.js 超时覆盖已存在');
  } else {
    if (!app.includes(oldTimerApp)) throw new Error('app.js：未找到 8s 超时锚点，上游结构可能已变化');
    app = replaceOnce(app, oldTimerApp, newTimerApp, 'app.js：apiFetch 超时可覆盖');
    app = replaceOnce(app, SUMMARY_CALL, SUMMARY_NEW, 'app.js：AI 摘要调用传 timeoutMs');
    write('app.js', app);
    changed = true;
    report.push('[ok]   app.js 超时可覆盖 + AI 摘要 60s');
  }

  let admin = read('admin.js');
  const calls = [
    ["api('api/ai/assist', { method: 'POST', body: JSON.stringify({ action: action, text: text, lang: lang }) })",
     "api('api/ai/assist', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ action: action, text: text, lang: lang }) })",
     'assist'],
    ["api('api/ai/comments', { method: 'POST', body: JSON.stringify({ action: 'summarize' }) })",
     "api('api/ai/comments', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ action: 'summarize' }) })",
     'comments/summarize'],
    ["api('api/ai/comments', { method: 'POST', body: JSON.stringify({ action: 'screen', text: text }) })",
     "api('api/ai/comments', { method: 'POST', timeoutMs: 60000, body: JSON.stringify({ action: 'screen', text: text }) })",
     'comments/screen']
  ];
  if (admin.includes('timeoutMs: 60000')) {
    report.push('[skip] admin.js AI 调用超时已存在');
  } else {
    for (const [from, to, label] of calls) {
      admin = replaceOnce(admin, from, to, 'admin.js：' + label + ' 传 timeoutMs');
    }
    write('admin.js', admin);
    changed = true;
    report.push('[ok]   admin.js 三处 AI 调用 60s');
  }
  if (changed) report.push('       注意：app.min.js / admin.min.js 需由 npm run frontend:build 重新压缩');
}

/* ---------- 执行 ---------- */

patchHomeStats();
patchThemeContrast();
patchI18nTexts();
patchAdminExtraTexts();
patchFooterIdentity();
patchAiTimeout();

console.log(report.join('\n'));
