/* ============================================================
 * AI 兼容层（OpenAI 兼容接口）
 * ------------------------------------------------------------
 * 上游 ai.js 调用 env.AI.run(model, { messages, ... }) 并读取返回的
 * res.response 字段——这是 Cloudflare Workers AI 的返回形状。
 * 这里把任意 OpenAI 兼容服务（OpenAI / DeepSeek / Groq / SiliconFlow /
 * Ollama / LocalAI / vLLM / One-API 等）适配成同一形状，
 * 因此 app/ 下的 AI 代码（摘要 / 润色 / 评论审核）完全无需改动。
 * ============================================================ */

export class AIBinding {
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'gpt-4o-mini';
    this.timeoutMs = Number(options.timeoutMs || 60000);
  }

  /**
   * @param {string} model   上游传入的 Cloudflare 模型名（作为回退）
   * @param {object} inputs  { messages, temperature, max_tokens, ... }
   * @returns {Promise<{response: string, usage?: object}>}
   */
  async run(model, inputs) {
    const input = inputs || {};
    const body = {
      model: this.model || model,
      messages: input.messages || [],
      stream: false
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.max_tokens !== undefined) body.max_tokens = input.max_tokens;
    else if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
    if (input.top_p !== undefined) body.top_p = input.top_p;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {}
        ),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error('AI 接口 HTTP ' + res.status + (detail ? '：' + detail.slice(0, 200) : ''));
      }
      const data = await res.json();
      const choice = data && data.choices && data.choices[0];
      const text = (choice && choice.message && choice.message.content) ||
        (choice && choice.text) || '';
      return { response: String(text || ''), usage: data && data.usage };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createAI(options) {
  return new AIBinding(options);
}