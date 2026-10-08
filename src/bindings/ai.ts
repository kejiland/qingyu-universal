/* ============================================================
 * AI 兼容层（OpenAI 兼容接口）
 * ------------------------------------------------------------
 * 上游 ai.js 调用 env.AI.run(model, { messages, … }) 并读取返回的
 * res.response 字段——这是 Cloudflare Workers AI 的返回形状。
 * 这里把任意 OpenAI 兼容服务（OpenAI / DeepSeek / Groq / SiliconFlow /
 * Ollama / LocalAI / vLLM / One-API…）适配成同一形状，因此 app/ 下的
 * AI 代码（摘要 / 润色 / 评论审核）完全无需改动。
 *
 * 与 Workers AI 不同，第三方网关会间歇性失败（连接重置、超时、429）。
 * 上游模型调用失败时 aiChat() 会吞掉异常返回 ''，handler 再回
 * 502「AI 服务暂不可用」——用户点一下没反应就只能再点一次。
 * 所以这里自带**有限重试**：只对明显可恢复的失败重试，且退避等待。
 * 幂等性没问题：AI 请求都是「给一段文本产出一段文本」，重试不改变系统状态。
 * ============================================================ */
import type { AIBindingLike } from '../types.js';

export interface AIOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** 额外重试次数（不含首次）。默认 1，即最多请求 2 次。 */
  maxRetries?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; text?: string }>;
  usage?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 判断是否值得重试：网络层失败、超时、429、5xx。4xx（除 429）不重试——重试也是同样的错。 */
function isRetryable(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  // undici 的网络错误是 TypeError: fetch failed
  if (name === 'TypeError') return true;
  const msg = String((err as { message?: string } | null)?.message ?? '');
  if (/HTTP 429/.test(msg)) return true;
  if (/HTTP 5\d\d/.test(msg)) return true;
  return false;
}

export class AIBinding implements AIBindingLike {
  readonly baseUrl: string;
  readonly model: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: AIOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey ?? '';
    this.model = options.model || 'gpt-4o-mini';
    this.#timeoutMs = Number(options.timeoutMs ?? 60_000);
    const retries = Number(options.maxRetries ?? 1);
    this.#maxRetries = Number.isFinite(retries) ? Math.min(Math.max(Math.trunc(retries), 0), 5) : 1;
  }

  /**
   * @param model  上游传入的 Cloudflare 模型名（配置了 AI_MODEL 时作为回退）
   * @param inputs { messages, temperature, max_tokens, … }
   */
  async run(model: string, inputs: Record<string, unknown>): Promise<{ response: string; usage?: unknown }> {
    const attempts = this.#maxRetries + 1;
    let lastError: unknown = null;

    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.#call(model, inputs);
      } catch (err) {
        lastError = err;
        if (i === attempts - 1 || !isRetryable(err)) break;
        // 退避：400ms、800ms、1200ms……
        await sleep(400 * (i + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #call(model: string, inputs: Record<string, unknown>): Promise<{ response: string; usage?: unknown }> {
    const body: Record<string, unknown> = {
      model: this.model || model,
      messages: inputs.messages ?? [],
      stream: false
    };
    if (inputs.temperature !== undefined) body.temperature = inputs.temperature;
    const maxTokens = inputs.max_tokens ?? inputs.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (inputs.top_p !== undefined) body.top_p = inputs.top_p;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`AI 接口 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? choice?.text ?? '';
    return { response: String(text), usage: data.usage };
  }
}

export function createAI(options: AIOptions): AIBinding {
  return new AIBinding(options);
}

/* ------------------------------------------------------------
 * 动态绑定：每次调用时才去解析配置
 * ------------------------------------------------------------
 * 上面的 AIBinding 在启动时把 baseUrl / Key / 模型固定下来，后台改了
 * 配置只能重启才生效。自托管版允许在后台改 AI 配置，所以这里再包一层：
 * `run()` 时才向 provider 要最新配置，再现场构造一个 AIBinding 用掉。
 *
 * 顺带解决一个反直觉的点：Cloudflare 版里 `env.AI` 是平台绑定，**恒存在**，
 * 上游 ai.js 的 `aiEnabled()` 靠它做第一道判断。以前自托管版是
 * 「没配 baseUrl 就不给 env.AI」，和上游形状不一致；现在改成恒存在，
 * 真正的「配没配」交给 BLOG_AI_ENABLED 表达（见 app.ts 的请求中间件）。
 * ------------------------------------------------------------ */
export interface DynamicAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function createDynamicAI(
  resolve: () => Promise<DynamicAiOptions>
): AIBindingLike & { readonly baseUrl: string; readonly model: string } {
  return {
    // 契约要求有这两个只读属性（健康检查会读），动态绑定给空串即可——
    // 真实值只有 run() 时才确定。
    baseUrl: '',
    model: '',
    async run(model: string, inputs: Record<string, unknown>) {
      const cfg = await resolve();
      if (!cfg.baseUrl) throw new Error('AI 未配置网关地址（后台「AI 模型」或 AI_BASE_URL）');
      const binding = new AIBinding({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model || model,
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries
      });
      return binding.run(model, inputs);
    }
  };
}
