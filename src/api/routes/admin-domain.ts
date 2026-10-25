/* ============================================================
 * 后台「设置 -> 域名与 HTTPS」
 * ------------------------------------------------------------
 * 浏览器只访问 app 的鉴权接口；Docker socket 与 Agent token
 * 仅存在于内部 domain-agent。没有 Agent 时诚实返回 unavailable，
 * 不伪造 DNS / HTTPS 成功。
 * ============================================================ */
import {
  DomainActionResponseSchema,
  DomainJobParamSchema,
  DomainJobResponseSchema,
  DomainRemoveBodySchema,
  DomainStatusResponseSchema,
  DomainUpdateBodySchema,
  DomainVerifyBodySchema
} from '../contract/domain.js';
import { ErrorResponseSchema } from '../contract/common.js';
import type { ApiContext, ApiRoute } from '../registry.js';
import { ADMIN_AUTH_ERRORS, adminGuard } from '../admin-auth.js';
import { auditFromContext } from '../audit.js';
import { DomainAgentClient } from '../../domain/agent-client.js';
import type { DomainStatus } from '../../domain/types.js';

const AUTH_ERRORS = ADMIN_AUTH_ERRORS;

function unavailableStatus(message: string): DomainStatus {
  return {
    ok: true,
    available: false,
    agentOnline: false,
    enabled: false,
    primary: '',
    aliases: [],
    publicIp: '',
    httpsReady: false,
    dns: [],
    activeJob: null,
    message
  };
}

function agentError(ctx: ApiContext, status: number, message: string): Response {
  const safe = status === 400 || status === 404 || status === 409 || status === 401 || status === 403 ? status : 503;
  return ctx.c.json({ error: message }, safe);
}

function client(ctx: ApiContext): DomainAgentClient {
  return new DomainAgentClient(ctx.config);
}

export const adminDomainRoutes: ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/admin/domain',
    tags: ['域名'],
    auth: 'admin',
    summary: '读取域名与 HTTPS 状态',
    description: '返回当前主域名、别名、DNS、证书状态和进行中的任务。未配置 domain-agent 时 available=false。',
    responses: {
      200: { description: '当前域名状态', schema: DomainStatusResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      const agent = client(ctx);
      if (!agent.configured) {
        return ctx.c.json(unavailableStatus('域名 Agent 未配置；请确认 domain-agent 服务与 DOMAIN_AGENT_URL/token。'), 200);
      }
      const result = await agent.status();
      if (!result.ok || !result.data) {
        return ctx.c.json(unavailableStatus(result.error || '域名 Agent 不可用'), 200);
      }
      return ctx.c.json(result.data, 200);
    }
  },
  {
    method: 'POST',
    path: '/api/admin/domain/verify',
    tags: ['域名'],
    auth: 'admin',
    summary: '验证 DNS 是否指向本机',
    description: '只验证 DNS 并记录任务，不修改 .env，也不重启容器。',
    request: { body: DomainVerifyBodySchema },
    responses: {
      202: { description: '验证任务已创建', schema: DomainActionResponseSchema },
      400: { description: '域名或 DNS 参数错误', schema: ErrorResponseSchema },
      409: { description: '已有任务在执行', schema: ErrorResponseSchema },
      503: { description: '域名 Agent 不可用', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      const body = await ctx.c.req.json().catch(() => null) as { primary?: string; aliases?: string[] } | null;
      if (!body) return ctx.c.json({ error: '请求体必须是合法 JSON' }, 400);
      const result = await client(ctx).verify(body);
      if (!result.ok || !result.data) return agentError(ctx, result.status, result.error || '创建验证任务失败');
      await auditFromContext(ctx, 'domain.verify', String(body.primary || ''), 'DNS 验证任务已创建');
      return ctx.c.json(result.data, 202);
    }
  },
  {
    method: 'PUT',
    path: '/api/admin/domain',
    tags: ['域名'],
    auth: 'admin',
    summary: '启用或更新域名与 HTTPS',
    description: '先验证所有域名的 DNS，再原子更新 .env、重启 app/Caddy，并实测 HTTPS healthz；失败会回滚 .env。',
    request: { body: DomainUpdateBodySchema },
    responses: {
      202: { description: '启用或更新任务已创建', schema: DomainActionResponseSchema },
      400: { description: '域名或 DNS 参数错误', schema: ErrorResponseSchema },
      409: { description: '已有任务在执行', schema: ErrorResponseSchema },
      503: { description: '域名 Agent 不可用', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      const body = await ctx.c.req.json().catch(() => null) as { primary?: string; aliases?: string[]; kind?: 'enable' | 'update' } | null;
      if (!body) return ctx.c.json({ error: '请求体必须是合法 JSON' }, 400);
      const result = await client(ctx).update(body);
      if (!result.ok || !result.data) return agentError(ctx, result.status, result.error || '创建域名任务失败');
      await auditFromContext(
        ctx,
        body.kind === 'update' ? 'domain.update' : 'domain.enable',
        String(body.primary || ''),
        '域名配置任务已创建'
      );
      return ctx.c.json(result.data, 202);
    }
  },
  {
    method: 'DELETE',
    path: '/api/admin/domain',
    tags: ['域名'],
    auth: 'admin',
    summary: '关闭 HTTPS 或移除域名',
    description: 'mode=disable 关闭 HTTPS 但保留已保存域名；mode=remove 同时清空主域名与别名，并恢复 HTTP 直连。',
    request: { body: DomainRemoveBodySchema },
    responses: {
      202: { description: '关闭或移除任务已创建', schema: DomainActionResponseSchema },
      400: { description: '参数错误', schema: ErrorResponseSchema },
      409: { description: '已有任务在执行', schema: ErrorResponseSchema },
      503: { description: '域名 Agent 不可用', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      const body = await ctx.c.req.json().catch(() => ({})) as { mode?: 'disable' | 'remove' };
      const mode = body.mode === 'disable' ? 'disable' : 'remove';
      const result = mode === 'disable' ? await client(ctx).disable() : await client(ctx).remove();
      if (!result.ok || !result.data) return agentError(ctx, result.status, result.error || '创建域名任务失败');
      await auditFromContext(ctx, mode === 'disable' ? 'domain.disable' : 'domain.remove', '', mode === 'disable' ? '关闭 HTTPS' : '移除域名');
      return ctx.c.json(result.data, 202);
    }
  },
  {
    method: 'GET',
    path: '/api/admin/domain/jobs/:id',
    tags: ['域名'],
    auth: 'admin',
    summary: '读取域名任务状态',
    description: '轮询异步域名任务。任务保存在 Agent 状态卷中，重启后未完成任务会明确标记失败。',
    request: { params: DomainJobParamSchema },
    responses: {
      200: { description: '任务状态', schema: DomainJobResponseSchema },
      404: { description: '任务不存在', schema: ErrorResponseSchema },
      503: { description: '域名 Agent 不可用', schema: ErrorResponseSchema },
      ...AUTH_ERRORS
    },
    handler: async (ctx) => {
      const denied = await adminGuard(ctx);
      if (!denied.ok) return denied.response!;
      const id = ctx.c.req.param('id') || '';
      const result = await client(ctx).job(id);
      if (!result.ok || !result.data) return agentError(ctx, result.status, result.error || '读取任务失败');
      return ctx.c.json(result.data, 200);
    }
  }
];
