/* ============================================================
 * API 契约注册表
 * ------------------------------------------------------------
 * 设计要点（很重要）：
 *
 * 1. 校验是「只读」的。请求原样转发给上游 worker，校验只用于决定
 *    是否提前返回 400。这样契约层**不可能**引入行为变化——不会因为
 *    zod 的默认 strip 行为悄悄删掉上游需要的字段。
 *
 * 2. 响应按声明的 schema 校验，用来发现「声明的契约和实际返回不一致」。
 *    这是防止 schema 漂移的唯一手段：文档写得再漂亮，不校验就是假的。
 *
 * 3. 不覆盖上游的任何行为：CORS、Cache-Control、Cache-Tag、状态码
 *    全部由上游决定，本层只做「放行 / 拒绝 / 漂移告警」。
 * ============================================================ */
import type { Context, Hono } from 'hono';
import { z, type ZodType } from 'zod';
import type { AppDatabase, WorkerEnv, WorkerModule } from '../types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ApiResponseSpec {
  description: string;
  schema: ZodType;
}

export interface ApiRequestSpec {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

export interface ApiContext {
  c: Context;
  /** 自托管数据库：仅供「上游没有、自托管新增」的接口使用（如后台 AI 配置）。 */
  db: AppDatabase;
  /** 上游 worker 期望的绑定集合（含动态 AI 绑定）。 */
  env: WorkerEnv;
  /** 上游应用（app/）的绝对路径 —— 用于复用其中的 JS 模块（如审计写入）。 */
  appDir: string;
  /** 解析真实客户端 IP（与 catch-all 路径同一实现，受 TRUST_PROXY 约束）。 */
  clientIp: (c: Context) => string;
  /** 把当前请求原样转发给上游 worker（含注入的边缘头）。 */
  callUpstream: () => Promise<Response>;
}

export interface ApiRoute {
  method: HttpMethod;
  /** Hono 路径，用 `:name` 表示路径参数 */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  request?: ApiRequestSpec;
  responses: Record<number, ApiResponseSpec>;
  handler: (ctx: ApiContext) => Promise<Response>;
  /** 文档用：是否需要管理员凭证 */
  auth?: 'public' | 'admin';
}

/** 默认处理器：原样转发给上游。 */
export const proxyToUpstream = (ctx: ApiContext): Promise<Response> => ctx.callUpstream();

export type ResponseValidation = 'off' | 'warn' | 'strict';

export interface ApiDeps {
  worker: WorkerModule;
  env: WorkerEnv;
  /** 自托管数据库（自托管新增接口用）。 */
  db: AppDatabase;
  /** 上游应用（app/）的绝对路径。 */
  appDir: string;
  /** 解析真实客户端 IP（与 catch-all 路径共用同一实现）。 */
  clientIp: (c: Context) => string;
  /** 构造带边缘头（CF-Connecting-IP 等）的请求，与 catch-all 路径共用同一实现。 */
  withEdgeHeaders: (c: Context) => Request;
  validateResponses: ResponseValidation;
  logger: { warn: (message: string) => void; error: (message: string) => void };
}

/* ---------- 校验 ---------- */

interface Issue {
  path: string;
  message: string;
}

function formatIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length ? `${prefix}.${issue.path.join('.')}` : prefix;
    return `${path}: ${issue.message}`;
  });
}

async function readJsonBody(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('json')) return undefined;
  try {
    // clone 后读取：原始请求体保持未被消费，稍后原样转发
    return await c.req.raw.clone().json();
  } catch {
    return undefined;
  }
}

function queryObject(c: Context): Record<string, string | string[]> {
  const params = new URL(c.req.url).searchParams;
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

/** 只读校验：不修改将被转发出去的请求。 */
export async function validateRequest(route: ApiRoute, c: Context): Promise<string[]> {
  const spec = route.request;
  if (!spec) return [];

  const problems: string[] = [];

  if (spec.params) {
    const result = spec.params.safeParse(c.req.param());
    if (!result.success) problems.push(...formatIssues(result.error, 'params'));
  }

  if (spec.query) {
    const result = spec.query.safeParse(queryObject(c));
    if (!result.success) problems.push(...formatIssues(result.error, 'query'));
  }

  if (spec.body) {
    const raw = await readJsonBody(c);
    if (raw === undefined) {
      problems.push('body: 请求体必须是合法 JSON');
    } else {
      const result = spec.body.safeParse(raw);
      if (!result.success) problems.push(...formatIssues(result.error, 'body'));
    }
  }

  return problems;
}

interface DriftReport {
  status: number;
  issues: string[];
  undeclared: boolean;
}

async function checkResponse(route: ApiRoute, response: Response): Promise<DriftReport | null> {
  const spec = route.responses[response.status];
  if (!spec) {
    // 未声明的状态码也算漂移，但 406/500 等运行时错误不强制声明
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;

  let data: unknown;
  try {
    data = await response.clone().json();
  } catch {
    return { status: response.status, issues: ['响应体不是合法 JSON'], undeclared: false };
  }

  const result = spec.schema.safeParse(data);
  if (result.success) return null;
  return {
    status: response.status,
    issues: result.error.issues.slice(0, 6).map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    }),
    undeclared: false
  };
}

/* ---------- 注册 ---------- */

export function registerApiRoutes(app: Hono, deps: ApiDeps, routes: ApiRoute[]): void {
  for (const route of routes) {
    app.on(route.method, route.path, async (c) => {
      const problems = await validateRequest(route, c);
      if (problems.length) {
        return c.json({ error: `参数校验失败：${problems.join('；')}` }, 400);
      }

      const response = await route.handler({
        c,
        db: deps.db,
        env: deps.env,
        appDir: deps.appDir,
        clientIp: deps.clientIp,
        callUpstream: () => deps.worker.fetch(deps.withEdgeHeaders(c), deps.env)
      });

      if (deps.validateResponses === 'off') return response;

      const drift = await checkResponse(route, response);
      if (!drift) return response;

      const where = `${route.method} ${route.path} → ${drift.status}`;
      if (deps.validateResponses === 'strict') {
        deps.logger.error(`[contract] 响应不符合声明的 schema：${where} — ${drift.issues.join('；')}`);
        return c.json(
          { error: '响应不符合 API 契约（服务端 bug，已阻止返回）', route: where, issues: drift.issues },
          500
        );
      }
      deps.logger.warn(`[contract] 响应与声明的 schema 不一致：${where} — ${drift.issues.join('；')}`);
      return response;
    });
  }
}