/* ============================================================
 * OpenAPI 3.1 文档生成
 * ------------------------------------------------------------
 * 直接复用 zod v4 原生的 z.toJSONSchema()——它产出的就是 JSON Schema
 * 2020-12，而 OpenAPI 3.1 正是基于该标准，因此不需要任何转换库。
 *
 * 契约里带 .meta({ id }) 的 schema 会被 zod 输出为 $defs + $ref，
 * 这里把 $defs 提升为 components.schemas 并改写 $ref 路径，
 * 客户端生成器因此能产出有名字的类型（PostSummary 而不是匿名结构）。
 *
 * 文档来源 = 路由注册表 = 运行时校验规则 = 客户端类型生成来源。
 * ============================================================ */
import { z, type ZodType } from 'zod';
import { HealthResponseSchema } from './contract/common.js';
import type { ApiRoute, HttpMethod } from './registry.js';

export interface OpenApiOptions {
  title: string;
  version: string;
  description?: string;
  /** 对外基地址，通常等于 SITE_URL */
  serverUrl: string;
}

/** 把 #/$defs/X 改写为 #/components/schemas/X（含嵌套引用）。 */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
        out.$ref = `#/components/schemas/${value.slice('#/$defs/'.length)}`;
      } else {
        out[key] = rewriteRefs(value);
      }
    }
    return out;
  }
  return node;
}

/** 转换过程中顺带收集具名 schema，用于 components.schemas。 */
class SchemaRegistry {
  readonly schemas: Record<string, unknown> = {};

  convert(schema: ZodType): Record<string, unknown> {
    const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
    delete json.$schema;

    const defs = json.$defs as Record<string, unknown> | undefined;
    if (defs) {
      for (const [name, def] of Object.entries(defs)) {
        if (name in this.schemas) continue;
        const cloned = JSON.parse(JSON.stringify(def)) as Record<string, unknown>;
        delete cloned.$schema;
        this.schemas[name] = rewriteRefs(cloned);
      }
      delete json.$defs;
    }
    return rewriteRefs(json) as Record<string, unknown>;
  }
}

const isOptional = (schema: ZodType): boolean => schema.safeParse(undefined).success;

function objectShape(schema: ZodType): Record<string, ZodType> | null {
  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  return shape && typeof shape === 'object' ? shape : null;
}

function expandParameters(
  registry: SchemaRegistry,
  schema: ZodType,
  location: 'path' | 'query'
): Array<Record<string, unknown>> {
  const shape = objectShape(schema);
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => ({
    name,
    in: location,
    required: location === 'path' ? true : !isOptional(field),
    schema: registry.convert(field)
  }));
}

export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** 生成稳定的 operationId：GET /api/posts/:id → getApiPostsById */
export function operationIdFor(method: HttpMethod, path: string): string {
  const camel = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `By${camel(segment.slice(1))}` : camel(segment)));
  return method.toLowerCase() + segments.join('');
}

export function buildOpenApiDocument(routes: ApiRoute[], options: OpenApiOptions): Record<string, unknown> {
  const registry = new SchemaRegistry();
  const paths: Record<string, Record<string, unknown>> = {};
  const tagNames = new Set<string>();

  for (const route of routes) {
    const oaPath = toOpenApiPath(route.path);
    route.tags.forEach((tag) => tagNames.add(tag));

    const responses: Record<string, unknown> = {};
    for (const [status, spec] of Object.entries(route.responses)) {
      responses[status] = {
        description: spec.description,
        content: { 'application/json': { schema: registry.convert(spec.schema) } }
      };
    }

    const operation: Record<string, unknown> = {
      tags: route.tags,
      summary: route.summary,
      operationId: operationIdFor(route.method, route.path),
      responses
    };
    if (route.description) operation.description = route.description;
    if (route.auth === 'admin') operation.security = [{ bearerAuth: [] }];

    const parameters = [
      ...(route.request?.params ? expandParameters(registry, route.request.params, 'path') : []),
      ...(route.request?.query ? expandParameters(registry, route.request.query, 'query') : [])
    ];
    if (parameters.length) operation.parameters = parameters;

    if (route.request?.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: registry.convert(route.request.body) } }
      };
    }

    paths[oaPath] = { ...(paths[oaPath] ?? {}), [route.method.toLowerCase()]: operation };
  }

  // 健康检查是 Hono 原生路由，不经过契约注册表，单独补进文档
  tagNames.add('系统');
  paths['/healthz'] = {
    get: {
      tags: ['系统'],
      summary: '健康检查',
      description: '容器 HEALTHCHECK 与负载均衡探针使用；数据库异常时返回 503。',
      operationId: 'getHealthz',
      responses: {
        200: {
          description: '服务正常',
          content: { 'application/json': { schema: registry.convert(HealthResponseSchema) } }
        },
        503: {
          description: '数据库不可用',
          content: { 'application/json': { schema: registry.convert(HealthResponseSchema) } }
        }
      }
    }
  };

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {})
    },
    servers: [{ url: options.serverUrl }],
    tags: [...tagNames].map((name) => ({ name })),
    components: {
      schemas: registry.schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: '管理员会话 token（POST /api/admin/login 获取）或 BLOG_WRITE_TOKEN'
        }
      }
    },
    paths
  };
}