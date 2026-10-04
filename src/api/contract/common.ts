/* 通用响应 schema。
 * 每个对外复用的 schema 都用 .meta({ id }) 命名——zod v4 会据此在
 * JSON Schema 里输出 $defs + $ref，OpenAPI 生成器再把它们提升为
 * components.schemas，客户端类型因此得到可读的名字而不是匿名结构。 */
import { z } from 'zod';

/** 上游统一的错误响应形状（注意：没有 ok 字段）。 */
export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .meta({ id: 'ErrorResponse', description: '统一错误响应；上游不返回 ok 字段' });

/** 通用成功确认（DELETE 等）。 */
export const OkResponseSchema = z
  .object({ ok: z.literal(true) })
  .meta({ id: 'OkResponse', description: '仅表示操作成功' });

/** 路径参数：单段非空字符串。 */
export const IdParamSchema = z.object({
  id: z.string().min(1)
});

/** GET /healthz 的响应（由 src/routes/health.ts 生成）。 */
export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    storage: z.enum(['local', 's3']),
    database: z.string(),
    databaseStatus: z.enum(['ok', 'error']),
    posts: z.number(),
    migrations: z.object({ applied: z.number(), skipped: z.number() }),
    uptime: z.number()
  })
  .meta({ id: 'HealthResponse' });