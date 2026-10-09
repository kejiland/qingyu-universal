/* ============================================================
 * 后台 AI 助手配置（自托管新增，上游没有这一组接口）
 * ------------------------------------------------------------
 * 与 admin.ts 里那批「代理给上游」的路由不同，这四条是**本地实现**：
 * 直接读写 ai_config 表 + 调用上游 OpenAI 兼容接口做模型拉取/连通性测试。
 *
 * 鉴权：本地 handler 不经过上游，因此必须自己做会话校验 —— 统一走
 *       src/api/admin-auth.ts 的 adminGuard()，与存储配置页共用同一份实现。
 * ============================================================ */
import {
  AiConfigResponseSchema,
  AiConfigUpdateBodySchema,
  AiModelsBodySchema,
  AiModelsResponseSchema,
  AiTestBodySchema,
  AiTestResponseSchema
} from '../contract/ai.js';
import { ErrorResponseSchema } from '../contract/common.js';
import type { ApiContext, ApiRoute } from '../registry.js';
import { auditFromContext } from '../audit.js';
import { ADMIN_AUTH_ERRORS, adminGuard } from '../admin-auth.js';
import {
  aiRuntime,
  listUpstreamModels,
  loadAiConfigFromDb,
  maskApiKey,
  mergeAiConfig,
  saveAiConfigToDb,
  testAiConnection,
  type AiConfig
} from '../../bindings/ai-config.js';

const AUTH_ERRORS = ADMIN_AUTH_ERRORS;

/** 当前生效配置（环境变量默认值 + 数据库覆盖） */
async function effective(ctx: ApiContext): Promise<ReturnType<typeof mergeAiConfig>> {
  const fromDb = await loadAiConfigFromDb(ctx.db);
  return mergeAiConfig(aiRuntime.defaults(), fromDb);
}

/* ---------- 路由 ---------- */

function payload(merged: ReturnType<typeof mergeAiConfig>, defaults: AiConfig): Record<string, unknown> {
  const { config, source } = merged;
  return {
    ok: true,
    enabled: config.enabled,
    publicGenerate: config.publicGenerate,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!config.apiKey,
    apiKeyMasked: maskApiKey(config.apiKey),
    source,
    active: config.enabled && !!config.baseUrl,
    envProvided: {
      baseUrl: !!defaults.baseUrl,
      apiKey: !!defaults.apiKey,
      model: !!defaults.model
    }
  };
}

function normalizeBaseUrl(value: unknown): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/* ---------- 路由 ---------- */

export const adminAiRoutes: ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/admin/ai',
    tags: ['AI'],
    auth: 'admin',
    summary: '读取 AI 助手配置',
    description:
      '返回当前生效的 AI 配置。密钥只回传打码值（apiKeyMasked）与是否已配置（hasApiKey），' +
      '明文永不出服务端。source 表示配置来自后台保存（db）还是环境变量兜底（env）。',
    responses: {
      200: { description: '当前配置', schema: AiConfigResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      const defaults = aiRuntime.defaults();
      return ctx.c.json(payload(await effective(ctx), defaults), 200);
    }
  },
  {
    method: 'PUT',
    path: '/api/admin/ai',
    tags: ['AI'],
    auth: 'admin',
    summary: '保存 AI 助手配置',
    description:
      '部分更新：只写传入的字段。apiKey 留空表示保持原密钥不变（避免只改模型时把密钥清掉），' +
      '需要清空请显式传 clearApiKey=true。保存后立即刷新运行时绑定，无需重启服务。',
    request: { body: AiConfigUpdateBodySchema },
    responses: {
      200: { description: '保存后的生效配置', schema: AiConfigResponseSchema },
      400: { description: '参数非法', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;

      const body = (await ctx.c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') {
        return ctx.c.json({ error: '缺少配置对象' }, 400);
      }

      const patch: Partial<AiConfig> = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.publicGenerate === 'boolean') patch.publicGenerate = body.publicGenerate;
      if (typeof body.baseUrl === 'string') patch.baseUrl = normalizeBaseUrl(body.baseUrl);
      if (typeof body.model === 'string') patch.model = body.model.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
      if (body.clearApiKey === true) patch.apiKey = '';

      /* 审计用：只记「改了哪些字段」，绝不记密钥本身 */
      const changed: string[] = [];
      if (patch.enabled !== undefined) changed.push('enabled');
      if (patch.publicGenerate !== undefined) changed.push('publicGenerate');
      if (patch.baseUrl !== undefined) changed.push('baseUrl');
      if (patch.model !== undefined) changed.push('model');
      if (patch.apiKey !== undefined) changed.push('apiKey');
      const keyState = patch.apiKey === undefined ? 'kept' : (patch.apiKey ? 'set' : 'cleared');

      try {
        await saveAiConfigToDb(ctx.db, patch);
      } catch (e) {
        return ctx.c.json({ error: `保存失败：${(e as Error)?.message || e}` }, 500);
      }

      // 保存后立刻用数据库真实值重建运行时 → env.AI 动态 getter 立即反映
      const merged = await effective(ctx);
      aiRuntime.set(merged.config, merged.source);
      await auditFromContext(ctx, 'ai.update', changed.join(',') || '(无变化)',
        `enabled=${merged.config.enabled ? 1 : 0} model=${merged.config.model || '-'} key=${keyState}`);
      return ctx.c.json(payload(merged, aiRuntime.defaults()), 200);
    }
  },
  {
    method: 'POST',
    path: '/api/admin/ai/models',
    tags: ['AI'],
    auth: 'admin',
    summary: '拉取上游可用模型列表',
    description:
      '服务端代理请求 {baseUrl}/models（避免浏览器 CORS 与密钥外泄），' +
      '兼容 OpenAI 的 {data:[{id}]}、Ollama 的 {models:[{name}]} 以及裸数组三种返回形态。' +
      'baseUrl/apiKey 不传则使用当前已保存配置，便于「先填地址→拉取→再保存」。',
    request: { body: AiModelsBodySchema },
    responses: {
      200: { description: '模型列表', schema: AiModelsResponseSchema },
      400: { description: '缺少 Base URL', schema: ErrorResponseSchema },
      502: { description: '上游不可达或鉴权失败', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;

      const body = (await ctx.c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const current = (await effective(ctx)).config;

      const baseUrl = normalizeBaseUrl(body && typeof body.baseUrl === 'string' ? body.baseUrl : '') || current.baseUrl;
      const apiKey = (body && typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : current.apiKey;

      if (!baseUrl) return ctx.c.json({ error: '请先填写 Base URL（OpenAI 兼容地址，通常以 /v1 结尾）' }, 400);

      try {
        const models = await listUpstreamModels(baseUrl, apiKey);
        return ctx.c.json({ ok: true, models }, 200);
      } catch (e) {
        return ctx.c.json({ error: `拉取模型失败：${(e as Error)?.message || e}` }, 502);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/admin/ai/test',
    tags: ['AI'],
    auth: 'admin',
    summary: '测试 AI 连通性',
    description:
      '用最小 token 数真实跑一次 chat/completions，可同时暴露地址、密钥、模型名三类问题。' +
      '测试失败也返回 200（ok=false + error），因为它表达的是「连通性结论」而不是接口错误。',
    request: { body: AiTestBodySchema },
    responses: {
      200: { description: '测试结果', schema: AiTestResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;

      const body = (await ctx.c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const current = (await effective(ctx)).config;

      const baseUrl = normalizeBaseUrl(body && typeof body.baseUrl === 'string' ? body.baseUrl : '') || current.baseUrl;
      const apiKey = (body && typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : current.apiKey;
      const model = (body && typeof body.model === 'string' && body.model.trim()) ? body.model.trim() : current.model;

      if (!baseUrl) {
        return ctx.c.json({ ok: false, model, ms: 0, error: '请先填写 Base URL' }, 200);
      }

      const result = await testAiConnection({ baseUrl, apiKey, model });
      return ctx.c.json(result, 200);
    }
  }
];
