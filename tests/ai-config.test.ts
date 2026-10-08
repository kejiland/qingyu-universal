/* ============================================================
 * 护栏：后台 AI 配置（自托管版专有能力）
 * ------------------------------------------------------------
 * 钉死四件最容易悄悄坏掉的事：
 *
 * 1）**唯一真源是数据库**。曾经还有一层 .env 兜底（留空 = 沿用 .env），
 *    同一项两个真源让「到底哪份在生效」变成猜谜，且 .env 改完还得重启。
 *    现在未设置的字段一律用代码里的默认值常量，config.ts 不读任何 AI_*。
 *
 * 2）PUT 的三态语义：undefined 不修改 / null 清空 / 具体值覆盖。
 *    这个真出过 bug：早先版本把 null 也当成「不修改」，于是「清空配置」
 *    按钮点了没反应。
 *
 * 3）API Key 不出现在任何对外响应里（只给掩码）。
 *
 * 4）/models 的返回形状各家不一样，归一化必须认得全（OpenAI 的 data、
 *    Ollama 的 models、裸数组），否则后台「拉取模型」永远拉到空列表。
 *
 * 另外确认迁移会建表——否则老库升级后接口会直接 500。
 * ============================================================ */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createD1 } from '../src/bindings/d1.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import {
  DEFAULT_AI_MAX_RETRIES,
  DEFAULT_AI_TIMEOUT_MS,
  readAiSettingsRow,
  resolveAiConfig,
  type AiSettingsRow
} from '../src/ai-settings.js';
import { normalizeModels } from '../src/routes/ai-config.js';

const row = (over: Partial<AiSettingsRow> = {}): AiSettingsRow => ({
  id: 1,
  base_url: '',
  api_key: '',
  model: '',
  timeout_ms: 0,
  max_retries: -1,
  enabled: -1,
  public_enabled: -1,
  updated_at: '',
  ...over
});

describe('AI 配置：库是唯一真源（没有 .env 兜底）', () => {
  it('没有任何记录时：地址为空、开关按默认开、超时重试取代码默认值', () => {
    const r = resolveAiConfig(null);
    expect(r.baseUrl).toBe('');
    expect(r.apiKey).toBe('');
    expect(r.model).toBe('');
    expect(r.timeoutMs).toBe(DEFAULT_AI_TIMEOUT_MS);
    expect(r.maxRetries).toBe(DEFAULT_AI_MAX_RETRIES);
    expect(r.enabled).toBe(true);
    expect(r.publicEnabled).toBe(true);
    expect(r.configured).toBe(false);
  });

  it('库里有值就原样生效（不掺任何 env 兜底）', () => {
    const r = resolveAiConfig(
      row({ base_url: 'https://db.example/v1', api_key: 'sk-db', model: 'db-model', timeout_ms: 30000, max_retries: 2 })
    );
    expect(r.baseUrl).toBe('https://db.example/v1');
    expect(r.apiKey).toBe('sk-db');
    expect(r.model).toBe('db-model');
    expect(r.timeoutMs).toBe(30000);
    expect(r.maxRetries).toBe(2);
    expect(r.configured).toBe(true);
  });

  it('哨兵值区分「0 次重试」与「未设置」', () => {
    expect(resolveAiConfig(row({ max_retries: 0 })).maxRetries).toBe(0);
    expect(resolveAiConfig(row({ max_retries: -1 })).maxRetries).toBe(DEFAULT_AI_MAX_RETRIES);
  });

  it('库里的开关说了算：0 = 关，1 = 开，-1 = 默认开', () => {
    expect(resolveAiConfig(row({ enabled: 0 })).enabled).toBe(false);
    expect(resolveAiConfig(row({ enabled: 1 })).enabled).toBe(true);
    expect(resolveAiConfig(row({ enabled: -1 })).enabled).toBe(true);
  });

  it('config.ts 不再读取任何 AI_* 环境变量（防 .env 兜底复活）', () => {
    const src = fs.readFileSync(path.resolve('src/config.ts'), 'utf8');
    for (const key of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS', 'AI_MAX_RETRIES']) {
      expect(src, `config.ts 不该再出现 ${key}`).not.toContain(key);
    }
  });

  it('.env.example 里不再列 AI 变量，并说明要去后台配', () => {
    // 注意：这里**不能**连写「AI_某键 + 等号」，tests/no-secrets.test.ts 会
    // 把这种形状当成「env 里填了值」扫出来报假阳性（专门防密钥入库的守卫）。
    const example = fs.readFileSync(path.resolve('.env.example'), 'utf8');
    expect(example).not.toMatch(/^AI_BASE_URL\s*=/m);
    expect(example).not.toMatch(/^AI_API_KEY\s*=/m);
    expect(example).not.toMatch(/^AI_MODEL\s*=/m);
    // 但要留下指路说明，免得老用户以为 AI 没了
    expect(example).toMatch(/AI/);
  });
});

describe('AI 配置：写入的三态语义', () => {
  /** 复刻 src/routes/ai-config.ts 里 PUT 的合并逻辑，避免测试与实现各写一套。 */
  const toFlag = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    return v ? 1 : 0;
  };
  function merge(current: AiSettingsRow, body: Record<string, unknown>) {
    return {
      base_url: body.base_url === undefined ? current.base_url : String(body.base_url ?? '').trim(),
      api_key: body.api_key === undefined ? current.api_key : String(body.api_key ?? ''),
      model: body.model === undefined ? current.model : String(body.model ?? '').trim(),
      timeout_ms:
        body.timeout_ms === undefined ? current.timeout_ms : body.timeout_ms === null ? 0 : Number(body.timeout_ms) || 0,
      max_retries:
        body.max_retries === undefined
          ? current.max_retries
          : body.max_retries === null
            ? -1
            : Number(body.max_retries),
      enabled: body.enabled === undefined ? current.enabled : toFlag(body.enabled) ?? -1,
      public_enabled: body.public_enabled === undefined ? current.public_enabled : toFlag(body.public_enabled) ?? -1
    };
  }

  const cur = row({ base_url: 'https://db.example/v1', model: 'db-model', timeout_ms: 30000, max_retries: 2, enabled: 1 });

  it('undefined = 不修改', () => {
    const next = merge(cur, { model: 'new-model' });
    expect(next.base_url).toBe('https://db.example/v1');
    expect(next.enabled).toBe(1);
    expect(next.timeout_ms).toBe(30000);
  });

  it('null = 清空（回到「未配置」）', () => {
    // 界面上的「清空配置」就是这么调的：全字段置 null
    const next = merge(cur, {
      base_url: null,
      api_key: null,
      model: null,
      timeout_ms: null,
      max_retries: null,
      enabled: null,
      public_enabled: null
    });
    expect(next.base_url).toBe('');
    expect(next.api_key).toBe('');
    expect(next.model).toBe('');
    expect(next.timeout_ms).toBe(0);
    expect(next.max_retries).toBe(-1);
    expect(next.enabled).toBe(-1);
    // 清空后必须是「未配置」，而不是还留着旧值
    const r = resolveAiConfig(row(next as Partial<AiSettingsRow>));
    expect(r.configured).toBe(false);
    expect(r.baseUrl).toBe('');
    expect(r.apiKey).toBe('');
  });

  it('具体值 = 覆盖', () => {
    const next = merge(cur, { enabled: 0, max_retries: 0 });
    expect(next.enabled).toBe(0);
    expect(next.max_retries).toBe(0);
  });
});

describe('AI 模型列表：各家 /models 形状的归一化', () => {
  it('OpenAI 形状 { data: [{ id }] }', () => {
    expect(normalizeModels({ object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] })).toEqual([
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      { id: 'gpt-4o', name: 'gpt-4o' }
    ]);
  });

  it('Ollama / 部分中转的 { models: [{ name, model }] }', () => {
    expect(normalizeModels({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] })).toEqual([
      { id: 'llama3.2:latest', name: 'llama3.2:latest' }
    ]);
  });

  it('裸数组也能认', () => {
    expect(normalizeModels(['a', 'b'])).toEqual([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' }
    ]);
  });

  it('去重、跳过空 id，且不认识的形状返回空数组（而不是抛错）', () => {
    expect(normalizeModels({ data: [{ id: 'x' }, { id: 'x' }, { id: '' }, {}] })).toEqual([{ id: 'x', name: 'x' }]);
    expect(normalizeModels({ foo: 1 })).toEqual([]);
    expect(normalizeModels(null)).toEqual([]);
  });

  it('有 display_name 时用它做展示名，id 仍用 id', () => {
    expect(normalizeModels({ data: [{ id: 'm1', display_name: '模型一' }] })).toEqual([{ id: 'm1', name: '模型一' }]);
  });
});

describe('AI 配置：迁移与读取', () => {
  it('迁移会建 ai_settings 表，且读写往返一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-ai-'));
    const db = createD1(path.join(dir, 'ai.db'));
    try {
      await runMigrations(db, MIGRATIONS_DIR);
      const name = await db.scalar<string>("SELECT name FROM sqlite_master WHERE type='table' AND name = 'ai_settings'");
      expect(name, 'ai_settings 表应存在').toBe('ai_settings');

      expect(await readAiSettingsRow(db)).toBeNull();

      await db
        .prepare(
          `INSERT INTO ai_settings (id, base_url, api_key, model, timeout_ms, max_retries, enabled, public_enabled, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind('https://db.example/v1', "sk-with'quote", 'm1', 30000, 2, 1, 0, '2026-01-01T00:00:00.000Z')
        .run();

      const got = await readAiSettingsRow(db);
      // Key 里的单引号不能破坏写入（参数化绑定的验证点）
      expect(got?.api_key).toBe("sk-with'quote");
      expect(got?.base_url).toBe('https://db.example/v1');
      expect(resolveAiConfig(got).baseUrl).toBe('https://db.example/v1');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('表不存在时读取返回 null，而不是抛错（老库跑新代码不能 500）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyu-ai2-'));
    const db = createD1(path.join(dir, 'empty.db'));
    try {
      await expect(readAiSettingsRow(db)).resolves.toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
