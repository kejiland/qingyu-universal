/* ============================================================
 * 后台 AI 配置接口（自托管版专有，上游没有对应能力）
 * ------------------------------------------------------------
 *   GET  /api/admin/ai-config       读取当前生效配置（Key 只给掩码）
 *   PUT  /api/admin/ai-config       保存（未提交的字段保持原样）
 *   POST /api/admin/ai-config/test  用当前配置试一次真实调用
 *   POST /api/admin/ai-models       向网关拉一次模型列表（/models）
 *
 * 与契约注册表里的路由不同，这些是**本地实现**，在 app.ts 里直接挂载，
 * 因此必须自己鉴权（否则等于把 API Key 匿名可读可写）。
 *
 * 两个刻意的设计：
 * 1）「未提交的字段保持原样」：后台表单通常只改模型名，若后端按「全量覆盖」
 *    处理，就会把地址或 Key 写空、AI 直接失效。
 * 2）配置只有 `ai_settings` 表一个真源，没有 .env 兜底 —— 见
 *    src/ai-settings.ts 顶部的说明（两个真源曾带来「到底哪份生效」的困惑）。
 * ============================================================ */
import type { Context } from 'hono';
import { z } from 'zod';
import { createAI } from '../bindings/ai.js';
import {
  DEFAULT_AI_MAX_RETRIES,
  DEFAULT_AI_TIMEOUT_MS,
  readAiSettingsRow,
  resolveAiConfig,
  type AiSettingsRow
} from '../ai-settings.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../types.js';
import { authenticateAdmin, jsonError } from './admin-auth.js';

export interface AiConfigDeps {
  config: AppConfig;
  db: AppDatabase;
}

/* ---------- 请求体 ---------- */

/**
 * 一律 `.nullable().optional()`：前台/后台的「没填」习惯写成 null 而不是省略字段，
 * 只写 .optional() 会放行 undefined 却拒绝 null（铁律：请求体必须容忍 null）。
 */
const AiConfigBodySchema = z.object({
  base_url: z.string().nullable().optional(),
  api_key: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  timeout_ms: z.coerce.number().int().min(1000).max(600000).nullable().optional(),
  max_retries: z.coerce.number().int().min(0).max(5).nullable().optional(),
  enabled: z.union([z.boolean(), z.coerce.number().int().min(0).max(1)]).nullable().optional(),
  public_enabled: z.union([z.boolean(), z.coerce.number().int().min(0).max(1)]).nullable().optional()
});

const toFlag = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  return v ? 1 : 0;
};

/* ---------- 响应 ---------- */

/** 只暴露前 3 位与后 4 位，够认出来是哪个 key，又不足以拿去用。 */
function maskKey(key: string): string {
  const k = String(key ?? '').trim();
  if (!k) return '';
  if (k.length <= 8) return '••••••••';
  return `${k.slice(0, 3)}••••${k.slice(-4)}`;
}

function publicView(row: AiSettingsRow | null) {
  const resolved = resolveAiConfig(row);
  return {
    ok: true,
    // 库里**已存**的值（输入框里显示的就是这个；空 = 未设置，用默认值）
    stored: {
      base_url: row?.base_url ?? '',
      model: row?.model ?? '',
      timeout_ms: Number.isFinite(Number(row?.timeout_ms)) && Number(row?.timeout_ms) > 0 ? Number(row?.timeout_ms) : 0,
      max_retries: Number.isFinite(Number(row?.max_retries)) && Number(row?.max_retries) >= 0 ? Number(row?.max_retries) : -1,
      enabled: Number.isFinite(Number(row?.enabled)) && Number(row?.enabled) >= 0 ? Number(row?.enabled) : -1,
      public_enabled: Number.isFinite(Number(row?.public_enabled)) && Number(row?.public_enabled) >= 0 ? Number(row?.public_enabled) : -1
    },
    // 未设置时实际生效的默认值（界面用来做 placeholder，让默认值看得见）
    defaults: {
      timeout_ms: DEFAULT_AI_TIMEOUT_MS,
      max_retries: DEFAULT_AI_MAX_RETRIES
    },
    api_key_set: !!resolved.apiKey,
    api_key_masked: maskKey(resolved.apiKey),
    /** 后台是否已在库里存过配置（界面提示「尚未配置 / 已配置」） */
    configured: resolved.configured,
    /** 真正可用 = 已启用且填了网关地址（与 app.ts 中间件的闸门口径一致） */
    usable: resolved.enabled && !!resolved.baseUrl,
    updated_at: row?.updated_at ?? ''
  };
}

/* ---------- 模型列表归一化 ---------- */

/** OpenAI 兼容网关 /models 的返回形状不止一种，这里统一成 [{ id, name }]。
 *  单独导出是为了能被测试直接覆盖（各家的返回形状差异很容易写错）：
 *    · OpenAI / 多数中转：{ object: 'list', data: [{ id, … }] }
 *    · Ollama / 部分中转：{ models: [{ name, model }] }
 *    · 少数直接返回数组
 *  另外按 id 去重，并封顶 500 条（大中转站动辄上千个模型）。 */
export function normalizeModels(payload: unknown): Array<{ id: string; name: string }> {
  const pickList = (raw: unknown): unknown[] => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.data)) return obj.data;
      if (Array.isArray(obj.models)) return obj.models;
    }
    return [];
  };

  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const item of pickList(payload)) {
    // 少数网关直接返回字符串数组：["gpt-4o-mini", "gpt-4o"]
    if (typeof item === 'string') {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push({ id, name: id });
      }
      continue;
    }
    const rec = (item ?? {}) as Record<string, unknown>;
    const id = String(rec.id ?? rec.name ?? rec.model ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(rec.name ?? rec.display_name ?? rec.id ?? id).trim() || id;
    out.push({ id, name });
    if (out.length >= 500) break;
  }
  return out;
}

/* ---------- 处理器 ---------- */

export function createAiConfigHandlers(deps: AiConfigDeps) {
  const { config, db } = deps;

  const get = async (c: Context): Promise<Response> => {
    const denied = await authenticateAdmin(c, config, db);
    if (denied) return denied;
    const row = await readAiSettingsRow(db);
    return c.json(publicView(row));
  };

  const put = async (c: Context): Promise<Response> => {
    const denied = await authenticateAdmin(c, config, db);
    if (denied) return denied;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return jsonError(c, 400, '请求体不是合法 JSON');
    }
    const parsed = AiConfigBodySchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return jsonError(c, 400, `参数校验失败：${first?.path.join('.') || 'body'}: ${first?.message ?? '不合法'}`);
    }
    const body = parsed.data;

    const current = (await readAiSettingsRow(db)) ?? {
      id: 1,
      base_url: '',
      api_key: '',
      model: '',
      timeout_ms: 0,
      max_retries: -1,
      enabled: -1,
      public_enabled: -1,
      updated_at: ''
    };

    /* 三态语义（改过一次 bug，别再写回去）：
     *   undefined → 不修改（前端表单没提交这个字段）
     *   null      → **清空**，回退到 .env
     *   具体值     → 覆盖
     * 早先版本把 null 也当成「不修改」，结果后台的「恢复 .env 配置」按钮
     * 点了没反应：开关明明传了 null，库里却还留着旧值，configured 一直是 true。
     * 数字字段清空要写回哨兵值（timeout 0 / retries -1 / 开关 -1），
     * 因为「0 次重试」是有意义的配置，不能用 0 兼作「未设置」。 */
    const next = {
      base_url: body.base_url === undefined ? current.base_url : String(body.base_url ?? '').trim(),
      api_key: body.api_key === undefined ? current.api_key : String(body.api_key ?? ''),
      model: body.model === undefined ? current.model : String(body.model ?? '').trim(),
      timeout_ms:
        body.timeout_ms === undefined
          ? current.timeout_ms
          : body.timeout_ms === null
            ? 0
            : Number(body.timeout_ms) || 0,
      max_retries:
        body.max_retries === undefined
          ? current.max_retries
          : body.max_retries === null
            ? -1
            : Number(body.max_retries),
      enabled: body.enabled === undefined ? current.enabled : toFlag(body.enabled) ?? -1,
      public_enabled:
        body.public_enabled === undefined ? current.public_enabled : toFlag(body.public_enabled) ?? -1,
      updated_at: new Date().toISOString()
    };

    try {
      /* prepare + bind：参数化写入。API Key 是用户输入的任意字符串，
       * 拼进 SQL 里一个引号就能把语句搞坏（更糟的是被注入）。
       * 占位符统一用 ?，PostgreSQL 适配器会自己转成 $1/$2。 */
      await db
        .prepare(
          `INSERT INTO ai_settings (id, base_url, api_key, model, timeout_ms, max_retries, enabled, public_enabled, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             base_url = excluded.base_url,
             api_key = excluded.api_key,
             model = excluded.model,
             timeout_ms = excluded.timeout_ms,
             max_retries = excluded.max_retries,
             enabled = excluded.enabled,
             public_enabled = excluded.public_enabled,
             updated_at = excluded.updated_at`
        )
        .bind(
          next.base_url,
          next.api_key,
          next.model,
          next.timeout_ms,
          next.max_retries,
          next.enabled,
          next.public_enabled,
          next.updated_at
        )
        .run();
    } catch (e) {
      return jsonError(c, 500, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    }

    return c.json(publicView(await readAiSettingsRow(db)));
  };

  /** 用当前生效配置（或请求体里的临时配置）真实调一次模型，验证能不能通。 */
  const test = async (c: Context): Promise<Response> => {
    const denied = await authenticateAdmin(c, config, db);
    if (denied) return denied;

    let body: Partial<z.infer<typeof AiConfigBodySchema>> = {};
    try {
      const raw = (await c.req.json().catch(() => null)) as unknown;
      if (raw && typeof raw === 'object') {
        const parsed = AiConfigBodySchema.partial().safeParse(raw);
        if (parsed.success) body = parsed.data;
      }
    } catch {
      /* 允许空 body：用已保存的配置测 */
    }

    const row = await readAiSettingsRow(db);
    const merged = resolveAiConfig(row);
    const effective = {
      baseUrl: body.base_url === undefined ? merged.baseUrl : String(body.base_url ?? '').trim(),
      apiKey: body.api_key === undefined ? merged.apiKey : String(body.api_key ?? ''),
      model: body.model === undefined ? merged.model : String(body.model ?? '').trim()
    };

    if (!effective.baseUrl) return jsonError(c, 400, '还没有填写网关地址');
    if (!effective.model) return jsonError(c, 400, '还没有填写模型名（可点「拉取模型」从网关获取）');

    const started = Date.now();
    try {
      const ai = createAI({
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        model: effective.model,
        timeoutMs: merged.timeoutMs,
        maxRetries: 0 // 测试就要快，不重试
      });
      const res = await ai.run(effective.model, {
        messages: [{ role: 'user', content: '回复两个字：正常' }]
      });
      const text = String(res?.response ?? '').trim();
      return c.json({
        ok: true,
        ms: Date.now() - started,
        model: effective.model,
        reply: text.slice(0, 200)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, ms: Date.now() - started, error: `调用失败：${msg}` }, 200);
    }
  };

  /* ---------- 模型列表：向网关拉一次 GET /models ---------- */

  /**
   * 拉取模型列表。
   * 允许在请求体里带**临时**的 base_url / api_key：后台的典型流程是
   * 「填地址 → 填 Key → 点拉取模型 → 选一个 → 保存」，这时候库里还没存，
   * 只拿库里的值会拉不到。
   */
  const models = async (c: Context): Promise<Response> => {
    const denied = await authenticateAdmin(c, config, db);
    if (denied) return denied;

    let body: Partial<z.infer<typeof AiConfigBodySchema>> = {};
    try {
      const raw = (await c.req.json().catch(() => null)) as unknown;
      if (raw && typeof raw === 'object') {
        const parsed = AiConfigBodySchema.partial().safeParse(raw);
        if (parsed.success) body = parsed.data;
      }
    } catch {
      /* 允许空 body：用已保存的配置拉 */
    }

    const merged = resolveAiConfig(await readAiSettingsRow(db));
    const baseUrl = (body.base_url === undefined ? merged.baseUrl : String(body.base_url ?? '').trim()).replace(/\/+$/, '');
    const apiKey = body.api_key === undefined ? merged.apiKey : String(body.api_key ?? '');

    if (!baseUrl) return jsonError(c, 400, '还没有填写网关地址');
    if (!/^https?:\/\//i.test(baseUrl)) return jsonError(c, 400, '网关地址必须以 http:// 或 https:// 开头');

    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        // 列表接口应该很快，没必要等满 60s 的模型超时
        signal: AbortSignal.timeout(15_000)
      });
      const text = await response.text();
      if (!response.ok) {
        return c.json(
          { ok: false, ms: Date.now() - started, error: `网关返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}` },
          200
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return c.json({ ok: false, ms: Date.now() - started, error: '网关返回的不是 JSON' }, 200);
      }
      const list = normalizeModels(payload);
      if (!list.length) {
        return c.json({ ok: false, ms: Date.now() - started, error: '网关没有返回可用模型' }, 200);
      }
      return c.json({ ok: true, ms: Date.now() - started, count: list.length, models: list });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, ms: Date.now() - started, error: `拉取失败：${msg}` }, 200);
    }
  };

  return { get, put, test, models };
}
