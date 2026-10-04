/* ============================================================
 * AI 兼容层（OpenAI 兼容接口）
 * ------------------------------------------------------------
 * 上游 ai.js 调用 env.AI.run(model, { messages, … }) 并读取返回的
 * res.response 字段——这是 Cloudflare Workers AI 的返回形状。
 * 这里把任意 OpenAI 兼容服务（OpenAI / DeepSeek / Groq / SiliconFlow /
 * Ollama / LocalAI / vLLM / One-API…）适配成同一形状，因此 app/ 下的
 * AI 代码（摘要 / 润色 / 评论审核）完全无需改动。
 * ============================================================ */
import type { AIBindingLike } from '../types.js';

export interface AIOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; text?: string }>;
  usage?: unknown;
}

export class AIBinding implements AIBindingLike {
  readonly baseUrl: string;
  readonly model: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(options: AIOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey ?? '';
    this.model = options.model || 'gpt-4o-mini';
    this.#timeoutMs = Number(options.timeoutMs ?? 60_000);
  }

  /**
   * @param model  上游传入的 Cloudflare 模型名（配置了 AI_MODEL 时作为回退）
   * @param inputs { messages, temperature, max_tokens, … }
   */
  async run(model: string, inputs: Record<string, unknown>): Promise<{ response: string; usage?: unknown }> {
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