/* ============================================================
 * 后台 AI 助手配置契约（自托管新增，上游没有这一组接口）
 * ------------------------------------------------------------
 * 与 /api/settings 的区别：那里是公开 GET，这里必须管理员会话。
 * 密钥永不明文回传：读接口只给 apiKeyMasked + hasApiKey。
 * ============================================================ */
import { z } from 'zod';

export const AiConfigSourceSchema = z.enum(['db', 'env', 'none']);

export const AiConfigResponseSchema = z
  .object({
    ok: z.literal(true),
    /** 总开关：关闭后上游 aiEnabled() 为 false，全站隐藏 AI 元素 */
    enabled: z.boolean(),
    /** 匿名访客是否可触发生成（消耗额度） */
    publicGenerate: z.boolean(),
    baseUrl: z.string(),
    model: z.string(),
    /** 是否已配置密钥（不回传明文） */
    hasApiKey: z.boolean(),
    /** 打码后的密钥，仅用于界面提示当前生效的是哪一把 */
    apiKeyMasked: z.string(),
    /** 当前配置来源：db=后台保存过，env=环境变量兜底，none=未配置 */
    source: AiConfigSourceSchema,
    /** 是否处于「可真正调用」状态（开关打开且有地址） */
    active: z.boolean(),
    /** 环境变量里提供了哪些字段（供界面提示「部署时已预填」） */
    envProvided: z.object({
      baseUrl: z.boolean(),
      apiKey: z.boolean(),
      model: z.boolean()
    })
  })
  .meta({ id: 'AiConfigResponse', description: 'AI 助手配置（密钥打码）' });

export const AiConfigUpdateBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    publicGenerate: z.boolean().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    /**
     * 留空或不传 = 保持原密钥不变（避免用户只改模型时把密钥清掉）。
     * 契约层遵循「拒绝保守」：这里不强制 min(1)，空串按「不修改」处理。
     */
    apiKey: z.string().optional(),
    /** 显式清除密钥（与 apiKey 留空区分开） */
    clearApiKey: z.boolean().optional()
  })
  .meta({ id: 'AiConfigUpdateBody' });

export const AiModelsBodySchema = z
  .object({
    /** 不传 = 用当前已保存配置。允许先填后拉，避免「必须先保存才能获取列表」 */
    baseUrl: z.string().optional(),
    apiKey: z.string().optional()
  })
  .meta({ id: 'AiModelsBody' });

export const AiModelsResponseSchema = z
  .object({
    ok: z.literal(true),
    models: z.array(z.object({ id: z.string(), ownedBy: z.string().optional() }))
  })
  .meta({ id: 'AiModelsResponse', description: '上游 /models 拉取结果' });

export const AiTestBodySchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional()
  })
  .meta({ id: 'AiTestBody' });

export const AiTestResponseSchema = z
  .object({
    /** 测试失败也返回 200 + ok:false：这是「连通性结论」而不是接口错误 */
    ok: z.boolean(),
    model: z.string(),
    ms: z.number(),
    reply: z.string().optional(),
    error: z.string().optional()
  })
  .meta({ id: 'AiTestResponse', description: '连通性测试结果' });
