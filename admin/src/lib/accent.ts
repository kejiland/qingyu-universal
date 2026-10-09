/**
 * 主题色（accent palette）· 与前台博客共用一份 localStorage
 * ------------------------------------------------------------
 * 前台 app.js 写的是 localStorage["qingyu.accent"]（缺省 terra），
 * 前台与后台同源，所以后台读同一个键即可保持同步：
 * 在博客里换主题色 → 后台跟着变；在后台换 → 博客下次打开也一致。
 *
 * 色板定义在 style.css 的 [data-accent=...] 变量块，这里只负责
 * 属性读写、持久化与跨标签页同步。
 */

export interface AccentPalette {
  id: string;
  label: string;
  /** 色板预览点用的颜色（与 style.css 中的取值保持一致） */
  dot: string;
}

export const ACCENT_PALETTES: AccentPalette[] = [
  { id: 'terra', label: '赭橙', dot: '#c25e3a' },
  { id: 'indigo', label: '黛蓝', dot: '#2b73af' },
  { id: 'bamboo', label: '竹青', dot: '#497568' },
  { id: 'dusk', label: '凝夜紫', dot: '#8b2671' }
];

export const DEFAULT_ACCENT = 'terra';

/** 与前台 app.js 的 accentKey() 保持一致 */
export const ACCENT_STORAGE_KEY = 'qingyu.accent';

function isKnown(id: string | null | undefined): id is string {
  return ACCENT_PALETTES.some((p) => p.id === id);
}

export function getAccent(): string {
  try {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isKnown(saved)) return saved;
  } catch {
    /* 隐私模式下 localStorage 可能抛错 */
  }
  return DEFAULT_ACCENT;
}

/** 把主题色写到 <html> 上；返回是否写入成功。 */
export function applyAccent(id: string): boolean {
  const next = isKnown(id) ? id : DEFAULT_ACCENT;
  try {
    document.documentElement.setAttribute('data-accent', next);
    return true;
  } catch {
    return false;
  }
}

export function setAccent(id: string): void {
  const next = isKnown(id) ? id : DEFAULT_ACCENT;
  applyAccent(next);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, next);
  } catch {
    /* 存不进去也不影响本次会话的显示 */
  }
}

/**
 * 跨标签页 / 跨前后台同步：另一个页面改了主题色时，本页同步刷新。
 * 返回取消订阅函数。
 */
export function watchAccent(onChange: (id: string) => void): () => void {
  const handler = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== ACCENT_STORAGE_KEY) return;
    const next = getAccent();
    applyAccent(next);
    onChange(next);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
