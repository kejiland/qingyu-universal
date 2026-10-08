/* ============================================================
 * 后台 AI 配置接口（自托管版专有，上游没有对应能力）
 * ------------------------------------------------------------
 *   GET  /api/admin/ai-config       读取当前生效配置（Key 只给掩码）
 *   PUT  /api/admin/ai-config       保存（未提交的字段保持原样）
 *   POST /api/admin/ai-config/test  用当前配置试一次真实调用
 *
 * 与契约注册表里的路由不同，这三个是**本地实现**，在 app.ts 里直接挂载，
 * 因此必须自己鉴权（否则等于把 API Key 匿名可读可写）。
 *
 * 「未提交的字段保持原样」是刻意的设计：后台表单通常只改模型名，
 * 若后端按「全量覆盖」处理，就会把地址或 Key 写空、AI 直接失效。
 * 见 src/ai-settings.ts 里的合并规则。
 * ============================================================ */
import type { Context } from 'hono';
import { z } from 'zod';
import { createAI } from '../bindings/ai.js';
import { readAiSettingsRow, resolveAiConfig, type AiSettingsRow } from '../ai-settings.js';
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

function publicView(row: AiSettingsRow | null, config: AppConfig) {
  const resolved = resolveAiConfig(row, config);
  return {
    ok: true,
    // 库里**已存**的值（输入框里显示的是这个；为空表示「沿用 .env」）
    stored: {
      base_url: row?.base_url ?? '',
      model: row?.model ?? '',
      timeout_ms: Number.isFinite(Number(row?.timeout_ms)) && Number(row?.timeout_ms) > 0 ? Number(row?.timeout_ms) : 0,
      max_retries: Number.isFinite(Number(row?.max_retries)) && Number(row?.max_retries) >= 0 ? Number(row?.max_retries) : -1,
      enabled: Number.isFinite(Number(row?.enabled)) && Number(row?.enabled) >= 0 ? Number(row?.enabled) : -1,
      public_enabled: Number.isFinite(Number(row?.public_enabled)) && Number(row?.public_enabled) >= 0 ? Number(row?.public_enabled) : -1
    },
    // .env 里的兜底值（用来做输入框 placeholder，让「留空=沿用」看得见）
    env: {
      base_url: config.ai.baseUrl,
      model: config.ai.model,
      timeout_ms: config.ai.timeoutMs,
      max_retries: config.ai.maxRetries,
      api_key_set: !!config.ai.apiKey
    },
    api_key_set: !!resolved.apiKey,
    api_key_masked: maskKey(resolved.apiKey),
    /** 后台库里是否已有覆盖记录（界面上提示「当前已覆盖 .env」） */
    overridden: resolved.fromDb,
    updated_at: row?.updated_at ?? ''
  };
}

/* ---------- 处理器 ---------- */

export function createAiConfigHandlers(deps: AiConfigDeps) {
  const { config, db } = deps;

  const get = async (c: Context): Promise<Response> => {
    const denied = await authenticateAdmin(c, config, db);
    if (denied) return denied;
    const row = await readAiSettingsRow(db);
    return c.json(publicView(row, config));
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
     * 点了没反应：开关明明传了 null，库里却还留着旧值，overridden 一直 true。
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

    return c.json(publicView(await readAiSettingsRow(db), config));
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
    const merged = resolveAiConfig(row, config);
    const effective = {
      baseUrl: body.base_url === undefined ? merged.baseUrl : String(body.base_url ?? '').trim(),
      apiKey: body.api_key === undefined ? merged.apiKey : String(body.api_key ?? ''),
      model: body.model === undefined ? merged.model : String(body.model ?? '').trim()
    };

    if (!effective.baseUrl) return jsonError(c, 400, '还没有配置网关地址（AI_BASE_URL 或后台填写）');
    if (!effective.model) return jsonError(c, 400, '还没有配置模型名（AI_MODEL 或后台填写）');

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

  return { get, put, test };
}
