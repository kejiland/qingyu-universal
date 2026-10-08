/* ============================================================
 * AI 配置的读取与合并（自托管版专有）
 * ------------------------------------------------------------
 * 配置有两个来源：`.env`（部署时写死，重启才变）和 `ai_settings` 表
 * （后台随时改，立即生效）。合并规则是**字段级**的：
 *
 *   字段留空  →  沿用 .env 的值
 *   字段有值  →  用库里的值覆盖
 *
 * 这样后台刚打开时所有输入框都是空的（占位符显示 .env 的当前值），
 * 用户只改「模型名」也不会把地址或 Key 清空——这一点很关键，
 * 早期版本里「保存一个字段 = 其余字段被写空」是典型的事故。
 *
 * 数字字段用 0 / -1 当哨兵而不是 NULL，是为了让 INSERT 语句能统一
 * 用 DEFAULT，也让「0 次重试」和「未设置」区分得开。
 * ============================================================ */
import type { AppConfig } from './config.js';
import type { AppDatabase } from './types.js';

export interface AiSettingsRow {
  id: number;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
  max_retries: number;
  enabled: number;
  public_enabled: number;
  updated_at: string;
}

/** 最终生效的 AI 配置（已合并 env 兜底）。 */
export interface ResolvedAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  publicEnabled: boolean;
  /** 这次生效的值里有多少来自后台库（用于界面提示「已覆盖 .env」）。 */
  fromDb: boolean;
}

/** env 里的开关语义：空 = 开启；0 / false / off / no = 关闭（与 config 层一致）。 */
function envFlag(raw: string, defaultValue: boolean): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export async function readAiSettingsRow(db: AppDatabase): Promise<AiSettingsRow | null> {
  try {
    return (await db.first<AiSettingsRow>('SELECT * FROM ai_settings WHERE id = 1')) ?? null;
  } catch {
    // 表还没建（老库跑在新代码上）：当作没有后台配置，全部走 env
    return null;
  }
}

export function resolveAiConfig(row: AiSettingsRow | null, config: AppConfig): ResolvedAiConfig {
  const baseUrl = (row?.base_url ?? '').trim() || config.ai.baseUrl;
  const apiKey = (row?.api_key ?? '') || config.ai.apiKey;
  const model = (row?.model ?? '').trim() || config.ai.model;

  const timeoutDb = num(row?.timeout_ms);
  const retriesDb = num(row?.max_retries);
  const enabledDb = num(row?.enabled);
  const publicDb = num(row?.public_enabled);

  const fromDb =
    !!row &&
    (!!(row.base_url ?? '').trim() ||
      !!row?.api_key ||
      !!(row.model ?? '').trim() ||
      (Number.isFinite(timeoutDb) && timeoutDb > 0) ||
      (Number.isFinite(retriesDb) && retriesDb >= 0) ||
      (Number.isFinite(enabledDb) && enabledDb >= 0) ||
      (Number.isFinite(publicDb) && publicDb >= 0));

  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutDb) && timeoutDb > 0 ? timeoutDb : config.ai.timeoutMs,
    maxRetries: Number.isFinite(retriesDb) && retriesDb >= 0 ? retriesDb : config.ai.maxRetries,
    enabled: Number.isFinite(enabledDb) && enabledDb >= 0 ? enabledDb !== 0 : envFlag(config.flags.aiEnabled, true),
    publicEnabled:
      Number.isFinite(publicDb) && publicDb >= 0 ? publicDb !== 0 : envFlag(config.flags.aiPublic, true),
    fromDb
  };
}

/** 带缓存的读取：AI 调用每次都查库太吵，1 秒内复用上一次结果。 */
export function createAiSettingsProvider(db: AppDatabase, config: AppConfig, ttlMs = 1000) {
  let cached: { at: number; value: ResolvedAiConfig } | null = null;
  return async (): Promise<ResolvedAiConfig> => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.value;
    const value = resolveAiConfig(await readAiSettingsRow(db), config);
    cached = { at: now, value };
    return value;
  };
}
