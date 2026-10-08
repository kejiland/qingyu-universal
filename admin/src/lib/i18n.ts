/* ============================================================
 * 后台界面多语言
 * ------------------------------------------------------------
 * 与前台共用同一套词典（`app/public/locales/<lang>.json`）和同一个
 * localStorage 键（`blog.locale`），所以：
 *   1. 不必为后台单独维护一份翻译，上游新增文案两边同时生效；
 *   2. 后台切语言后，前台也是同一个语言，换页不会跳回中文。
 *
 * 词典里的 `admin.*` 就是后台文案，与上游旧版后台 `admin.js` 用的是同一批键，
 * 因此两个后台的措辞天然一致。
 * ============================================================ */
import { ref } from 'vue';

export interface AdminLanguage {
  code: string;
  /** 语言自称，如「日本語」，不随当前语言变化 */
  name: string;
  /** `/flags/<code>.svg` 的文件名 */
  flag: string;
}

/** 与 `app/public/app.js` 的 LANGUAGES 一一对应；顺序即弹层里的显示顺序。 */
export const LANGUAGES: AdminLanguage[] = [
  { code: 'zh-CN', name: '中文', flag: 'cn' },
  { code: 'en', name: 'English', flag: 'gb' },
  { code: 'ja', name: '日本語', flag: 'jp' },
  { code: 'ko', name: '한국어', flag: 'kr' },
  { code: 'hi', name: 'हिन्दी', flag: 'in' }
];

const DEFAULT_LANG = 'zh-CN';
/** 与前台共用：切了语言，前台与后台同时变 */
export const LOCALE_KEY = 'blog.locale';

/** 弹层标题：跟随当前语言显示，与前台 `langTitle()` 同一组取值 */
const LANG_TITLES: Record<string, string> = {
  'zh-CN': '语言',
  en: 'Language',
  ja: '言語',
  ko: '언어',
  hi: 'भाषा'
};

/** 当前词典。用 ref 是为了让模板里的 t() 能跟着语言切换重新渲染。 */
const dict = ref<Record<string, string>>({});
const locale = ref<string>(DEFAULT_LANG);
/** 词典是否已就绪（未就绪时 t() 返回键名，界面会短暂显示键名，故入口前先 await） */
const ready = ref(false);

function readStored(): string {
  try {
    return localStorage.getItem(LOCALE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 已保存的语言 → 浏览器首选语言 → 默认中文（与前台 detectLang 同一套规则） */
function detectLang(): string {
  const saved = readStored();
  if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  const raw = (navigator.language || '').toLowerCase();
  if (raw.startsWith('zh')) return 'zh-CN';
  if (raw.startsWith('ja')) return 'ja';
  if (raw.startsWith('ko')) return 'ko';
  if (raw.startsWith('hi')) return 'hi';
  if (raw.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

/**
 * 加载指定语言的词典并切换。
 * 网络失败时回退到已加载的词典（首次且失败则保持键名可见），绝不阻塞后台启动。
 */
export async function setLocale(code: string): Promise<void> {
  const target = LANGUAGES.some((l) => l.code === code) ? code : DEFAULT_LANG;
  try {
    // 服务端给词典带了 ETag，用 no-cache 协商缓存即可：内容没变是 304（几十字节），
    // 变了就拉到新的。这样不必像前台那样维护 I18N_VER 版本号，也不会读到旧词典。
    const response = await fetch(`/locales/${target}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dict.value = (await response.json()) as Record<string, string>;
    ready.value = true;
  } catch {
    /* 拉不到就保留现有词典：宁可是上次的语言，也不要整页变成键名 */
    if (!ready.value) ready.value = true;
  }
  locale.value = target;
  persist(target);
}

function persist(code: string): void {
  try {
    localStorage.setItem(LOCALE_KEY, code);
  } catch {
    /* 隐私模式忽略 */
  }
  try {
    document.documentElement.setAttribute('lang', code);
  } catch {
    /* ignore */
  }
}

/** 启动时调用：读一次语言偏好并把词典拉下来，完成前不要渲染界面 */
export async function initI18n(): Promise<void> {
  await setLocale(detectLang());
}

/** 弹层标题（当前语言下「语言」怎么写） */
export function langTitle(): string {
  return LANG_TITLES[locale.value] ?? LANG_TITLES['zh-CN']!;
}

/**
 * 取文案。词典缺失时**原样返回键名**（与上游一致）：
 * 这样漏翻的项在界面上一眼可见，而不是静默变成空白。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const hit = dict.value[key];
  let text = typeof hit === 'string' ? hit : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

export function useI18n() {
  return { t, locale, LANGUAGES, setLocale, langTitle, ready };
}
