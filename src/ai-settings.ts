/* ============================================================
 * AI 配置的读取（自托管版专有）
 * ------------------------------------------------------------
 * 唯一真源是 `ai_settings` 表：后台「AI 模型」页写什么，这里就读出什么，
 * 改完立即生效（读取带 1s 缓存）。
 *
 * 曾经这里还有第二来源 —— `.env`（AI_BASE_URL / AI_API_KEY / AI_MODEL…），
 * 合并规则是「库里留空则沿用 .env」。那套设计被刻意移除了，原因：
 *
 *   1. 同一项两个真源：排障时永远要先问「这个值是 .env 的还是库里的」，
 *      而界面只能显示「留空 = 沿用」，看不到 .env 里到底是什么；
 *   2. .env 改完要重启，与「后台改完立即生效」的预期直接冲突；
 *   3. Key 分散在两处，权限收紧容易漏掉一个。
 *
 * 现在超时 / 重试的**默认值是代码常量**（下面的 DEFAULT_*），
 * 不是环境变量 —— 想改就去后台改，不用登服务器改文件再重启。
 *
 * 数字字段仍用 0 / -1 当哨兵而不是 NULL：让 INSERT 能统一用 DEFAULT，
 * 也让「0 次重试」和「未设置」区分得开（0 次重试是有意义的配置）。
 * ============================================================ */
import type { AppDatabase } from './types.js';

/** 单次模型请求超时（毫秒）。第三方网关慢起来能到几十秒，60s 是实测够用的值。 */
export const DEFAULT_AI_TIMEOUT_MS = 60_000;
/** 失败后的额外重试次数（不含首次）。网关间歇性失败，重试一次能救回大部分。 */
export const DEFAULT_AI_MAX_RETRIES = 1;

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

/** 最终生效的 AI 配置。 */
export interface ResolvedAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  publicEnabled: boolean;
  /** 后台是否已经在库里存过配置（界面用它提示「尚未配置 / 已配置」）。 */
  configured: boolean;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export async function readAiSettingsRow(db: AppDatabase): Promise<AiSettingsRow | null> {
  try {
    return (await db.first<AiSettingsRow>('SELECT * FROM ai_settings WHERE id = 1')) ?? null;
  } catch {
    // 表还没建（老库跑在新代码上）：当作没有配置，AI 不可用
    return null;
  }
}

/** 哨兵值：timeout 0 = 未设置，retries / 开关 -1 = 未设置。 */
function hasAnyValue(row: AiSettingsRow | null): boolean {
  if (!row) return false;
  const timeout = num(row.timeout_ms);
  const retries = num(row.max_retries);
  const enabled = num(row.enabled);
  const publicEnabled = num(row.public_enabled);
  return (
    !!(row.base_url ?? '').trim() ||
    !!row.api_key ||
    !!(row.model ?? '').trim() ||
    (Number.isFinite(timeout) && timeout > 0) ||
    (Number.isFinite(retries) && retries >= 0) ||
    (Number.isFinite(enabled) && enabled >= 0) ||
    (Number.isFinite(publicEnabled) && publicEnabled >= 0)
  );
}

export function resolveAiConfig(row: AiSettingsRow | null): ResolvedAiConfig {
  const timeoutDb = num(row?.timeout_ms);
  const retriesDb = num(row?.max_retries);
  const enabledDb = num(row?.enabled);
  const publicDb = num(row?.public_enabled);

  return {
    baseUrl: (row?.base_url ?? '').trim(),
    apiKey: row?.api_key ?? '',
    model: (row?.model ?? '').trim(),
    timeoutMs: Number.isFinite(timeoutDb) && timeoutDb > 0 ? timeoutDb : DEFAULT_AI_TIMEOUT_MS,
    maxRetries: Number.isFinite(retriesDb) && retriesDb >= 0 ? retriesDb : DEFAULT_AI_MAX_RETRIES,
    // 未设置（-1）按「开启」处理：真正决定能不能用的是有没有网关地址
    // （app.ts 中间件里 `enabled && !!baseUrl` 才是最终闸门）。
    enabled: Number.isFinite(enabledDb) && enabledDb >= 0 ? enabledDb !== 0 : true,
    publicEnabled: Number.isFinite(publicDb) && publicDb >= 0 ? publicDb !== 0 : true,
    configured: hasAnyValue(row)
  };
}

/** 带缓存的读取：AI 调用每次都查库太吵，1 秒内复用上一次结果。 */
export function createAiSettingsProvider(db: AppDatabase, ttlMs = 1000) {
  let cached: { at: number; value: ResolvedAiConfig } | null = null;
  return async (): Promise<ResolvedAiConfig> => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.value;
    const value = resolveAiConfig(await readAiSettingsRow(db));
    cached = { at: now, value };
    return value;
  };
}
