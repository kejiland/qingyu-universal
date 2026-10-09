/* ============================================================
 * AI 配置存储（后台「设置 → AI 助手」）
 * ------------------------------------------------------------
 * 落点：独立表 ai_config(k,v)，**不经过公开的 /api/settings**
 *       （那个接口匿名可读且带缓存头，放 API Key 会泄露）。
 * 优先级：数据库配置 > 环境变量（环境变量用作首次部署的默认值）。
 * 生效方式：写入后立刻更新内存 store 并重建 binding，
 *           配合 worker-env 的动态 getter，**无需重启即生效**。
 * ============================================================ */
import type { AppDatabase, AIBindingLike } from '../types.js';
import { AIBinding, type AIOptions } from './ai.js';

export interface AiConfig {
  /** 总开关：关闭时 aiEnabled() 为 false，全站隐藏 AI 元素 */
  enabled: boolean;
  /** 匿名访客是否可触发生成（消耗额度）；关闭后生成类接口要求作者会话 */
  publicGenerate: boolean;
  /** OpenAI 兼容根地址，如 https://api.example.com/v1 */
  baseUrl: string;
  /** Bearer 密钥（只在服务端流转，读接口只回传打码值） */
  apiKey: string;
  /** 默认模型名 */
  model: string;
}

export type AiConfigSource = 'db' | 'env' | 'none';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function boolish(value: unknown, fallback: boolean): boolean {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return TRUE_VALUES.has(s);
}

/** 环境变量侧的默认配置（部署时用 AI_BASE_URL / AI_API_KEY / AI_MODEL 预填） */
export function envDefaults(raw: { baseUrl: string; apiKey: string; model: string; enabled: string; publicGenerate: string }): AiConfig {
  const baseUrl = raw.baseUrl.replace(/\/+$/, '');
  return {
    // 配了 baseUrl 就默认启用；BLOG_AI_ENABLED 显式写 0/false/off 可关掉
    enabled: baseUrl ? boolish(raw.enabled || '1', true) : false,
    publicGenerate: boolish(raw.publicGenerate || '1', true),
    baseUrl,
    apiKey: raw.apiKey,
    model: raw.model
  };
}

/** 读取数据库里的 AI 配置（不含的键不返回，交由调用方与默认值合并） */
export async function loadAiConfigFromDb(db: AppDatabase): Promise<Partial<AiConfig>> {
  let rows: Array<{ k: string; v: string }> = [];
  try {
    rows = await db.all<{ k: string; v: string }>('SELECT k, v FROM ai_config');
  } catch {
    // 迁移尚未执行（首次启动竞态）时按「无配置」处理
    return {};
  }
  const out: Partial<AiConfig> = {};
  for (const row of rows) {
    const v = String(row.v ?? '');
    switch (row.k) {
      case 'enabled': out.enabled = boolish(v, true); break;
      case 'publicGenerate': out.publicGenerate = boolish(v, true); break;
      case 'baseUrl': out.baseUrl = v.replace(/\/+$/, ''); break;
      case 'apiKey': out.apiKey = v; break;
      case 'model': out.model = v; break;
      default: break;
    }
  }
  return out;
}

/** 合并：数据库优先，其次环境变量 */
export function mergeAiConfig(base: AiConfig, fromDb: Partial<AiConfig>): { config: AiConfig; source: AiConfigSource } {
  const has = Object.keys(fromDb).length > 0;
  const config: AiConfig = {
    enabled: fromDb.enabled ?? base.enabled,
    publicGenerate: fromDb.publicGenerate ?? base.publicGenerate,
    baseUrl: fromDb.baseUrl ?? base.baseUrl,
    apiKey: fromDb.apiKey !== undefined ? fromDb.apiKey : base.apiKey,
    model: fromDb.model ?? base.model
  };
  // 只有真正落过库才算 db；否则看环境变量是否给出了可用地址
  const source: AiConfigSource = has ? 'db' : (base.baseUrl ? 'env' : 'none');
  return { config, source };
}

/** 写入数据库（只写传入的字段），并同步更新时间戳 */
export async function saveAiConfigToDb(db: AppDatabase, patch: Partial<AiConfig>): Promise<void> {
  const stmts: Array<{ sql: string; params: unknown[] }> = [];
  const put = (k: string, v: string): void => {
    stmts.push({
      sql: 'INSERT INTO ai_config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
      params: [k, v]
    });
  };
  if (patch.enabled !== undefined) put('enabled', patch.enabled ? '1' : '0');
  if (patch.publicGenerate !== undefined) put('publicGenerate', patch.publicGenerate ? '1' : '0');
  if (patch.baseUrl !== undefined) put('baseUrl', patch.baseUrl);
  if (patch.apiKey !== undefined) put('apiKey', patch.apiKey);
  if (patch.model !== undefined) put('model', patch.model);
  if (!stmts.length) return;

  const prepared = stmts.map((s) => db.prepare(s.sql).bind(...s.params));
  await db.batch(prepared);
}

/** 密钥打码：保留首尾便于核对，中间一律星号 */
export function maskApiKey(key: string): string {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '*'.repeat(k.length);
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

/* ------------------------------------------------------------
 * 运行时配置（内存单例）
 * worker-env 的动态 getter 直接读它，所以后台保存后立即生效。
 * ------------------------------------------------------------ */

export interface AiRuntimeSnapshot {
  config: AiConfig;
  source: AiConfigSource;
  /** 是否真的可调用（有地址 + 开关打开） */
  active: boolean;
}

class AiRuntime {
  #config: AiConfig = { enabled: false, publicGenerate: true, baseUrl: '', apiKey: '', model: '' };
  #source: AiConfigSource = 'none';
  #binding: AIBindingLike | undefined;
  /** 环境变量侧的默认值，供后台接口在「合并后回读」时复用 */
  #defaults: AiConfig = { enabled: false, publicGenerate: true, baseUrl: '', apiKey: '', model: '' };

  setDefaults(defaults: AiConfig): void {
    this.#defaults = { ...defaults };
  }

  defaults(): AiConfig {
    return { ...this.#defaults };
  }

  /** 用合并后的配置重置运行时（会重建 binding） */
  set(config: AiConfig, source: AiConfigSource): void {
    this.#config = { ...config };
    this.#source = source;
    this.#binding = config.baseUrl
      ? new AIBinding({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model })
      : undefined;
  }

  /** 供 env.AI getter 使用：开关关闭或没地址时返回 undefined（上游 aiEnabled() 即为 false） */
  get(): AIBindingLike | undefined {
    if (!this.#config.enabled) return undefined;
    return this.#binding;
  }

  snapshot(): AiRuntimeSnapshot {
    return {
      config: { ...this.#config },
      source: this.#source,
      active: this.#config.enabled && !!this.#config.baseUrl
    };
  }
}

export const aiRuntime = new AiRuntime();

/* ------------------------------------------------------------
 * 上游能力拉取与连通性测试
 * ------------------------------------------------------------ */

export interface UpstreamModel {
  id: string;
  ownedBy?: string;
}

/** 拉取上游 /models 列表，兼容 OpenAI/Ollama/裸数组等返回形态 */
export async function listUpstreamModels(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<UpstreamModel[]> {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 Base URL');
  const response = await fetch(`${base}/models`, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const hint = response.status === 401 || response.status === 403
      ? '（鉴权失败：请检查 API Key）'
      : response.status === 404
        ? '（该地址没有 /models 接口，可手动填写模型名）'
        : '';
    throw new Error(`HTTP ${response.status}${hint}${detail ? `：${detail.slice(0, 160)}` : ''}`);
  }
  const data = (await response.json()) as unknown;
  return normalizeModelList(data);
}

function normalizeModelList(data: unknown): UpstreamModel[] {
  const pick = (item: unknown): UpstreamModel | null => {
    if (typeof item === 'string') return { id: item };
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    const id = rec.id ?? rec.name ?? rec.model;
    if (typeof id !== 'string' || !id) return null;
    const ownedBy = rec.owned_by ?? rec.ownedBy ?? rec.organization;
    return { id, ...(typeof ownedBy === 'string' && ownedBy ? { ownedBy } : {}) };
  };

  let raw: unknown[] = [];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const list = rec.data ?? rec.models ?? rec.result;
    if (Array.isArray(list)) raw = list;
  }
  const models = raw.map(pick).filter((m): m is UpstreamModel => m !== null);
  // 去重 + 稳定排序，便于下拉里查找
  const seen = new Set<string>();
  return models
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface AiTestResult {
  ok: boolean;
  model: string;
  ms: number;
  reply?: string;
  error?: string;
}

/** 连通性测试：用最小 token 数跑一次 chat/completions，能真实暴露鉴权/模型名/网络问题 */
export async function testAiConnection(options: AIOptions & { model: string }): Promise<AiTestResult> {
  const started = Date.now();
  const model = options.model || 'gpt-4o-mini';
  try {
    const binding = new AIBinding({ ...options, model });
    const res = await binding.run(model, {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      temperature: 0
    });
    return { ok: true, model, ms: Date.now() - started, reply: String(res.response || '').slice(0, 80) };
  } catch (e) {
    return { ok: false, model, ms: Date.now() - started, error: (e as Error)?.message || String(e) };
  }
}
