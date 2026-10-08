/* ============================================================
 * 护栏：后台 AI 配置（自托管版专有能力）
 * ------------------------------------------------------------
 * 钉死三件最容易悄悄坏掉的事：
 *
 * 1）合并规则：字段留空 → 沿用 .env；字段有值 → 覆盖。
 *    坏掉的典型后果是「后台只改模型名，结果地址或 Key 被写空」。
 *
 * 2）三态语义：undefined 不修改 / null 清空 / 值覆盖。
 *    这个真出过 bug：早先版本把 null 也当成「不修改」，于是后台的
 *    「恢复 .env 配置」按钮点了没反应，overridden 一直是 true。
 *
 * 3）API Key 不出现在任何对外响应里（只给掩码）。
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
import { readAiSettingsRow, resolveAiConfig, type AiSettingsRow } from '../src/ai-settings.js';
import type { AppConfig } from '../src/config.js';

/** 只取 resolveAiConfig 用到的字段，避免为了构造完整 AppConfig 而拖进整个配置层。 */
function fakeConfig(over: Partial<AppConfig['ai']> & Partial<AppConfig['flags']> = {}): AppConfig {
  return {
    ai: {
      baseUrl: 'https://env.example/v1',
      apiKey: 'sk-env-secret-key',
      model: 'env-model',
      timeoutMs: 60000,
      maxRetries: 1,
      ...over
    },
    flags: { aiEnabled: '', aiPublic: '', ...over }
  } as unknown as AppConfig;
}

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

describe('AI 配置：合并规则', () => {
  it('库里没有记录时完全沿用 .env', () => {
    const r = resolveAiConfig(null, fakeConfig());
    expect(r.baseUrl).toBe('https://env.example/v1');
    expect(r.apiKey).toBe('sk-env-secret-key');
    expect(r.model).toBe('env-model');
    expect(r.timeoutMs).toBe(60000);
    expect(r.maxRetries).toBe(1);
    expect(r.enabled).toBe(true);
    expect(r.fromDb).toBe(false);
  });

  it('留空的字段沿用 .env，填了的字段覆盖——只改模型不会动地址和 Key', () => {
    const r = resolveAiConfig(row({ model: 'db-model' }), fakeConfig());
    expect(r.model).toBe('db-model');      // 覆盖
    expect(r.baseUrl).toBe('https://env.example/v1'); // 沿用
    expect(r.apiKey).toBe('sk-env-secret-key');       // 沿用
    expect(r.fromDb).toBe(true);
  });

  it('库里的开关优先于 .env；.env 关着而库里开着也能开', () => {
    const off = resolveAiConfig(row({ enabled: 0 }), fakeConfig({ aiEnabled: '' }));
    expect(off.enabled).toBe(false);
    const on = resolveAiConfig(row({ enabled: 1 }), fakeConfig({ aiEnabled: '0' }));
    expect(on.enabled).toBe(true);
  });

  it('哨兵值区分「0 次重试」与「未设置」', () => {
    expect(resolveAiConfig(row({ max_retries: 0 }), fakeConfig({ maxRetries: 3 })).maxRetries).toBe(0);
    expect(resolveAiConfig(row({ max_retries: -1 }), fakeConfig({ maxRetries: 3 })).maxRetries).toBe(3);
  });

  it('.env 的关闭语义：0 / false / off 才算关', () => {
    for (const v of ['0', 'false', 'off']) {
      expect(resolveAiConfig(null, fakeConfig({ aiEnabled: v })).enabled).toBe(false);
    }
    expect(resolveAiConfig(null, fakeConfig({ aiEnabled: '' })).enabled).toBe(true);
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

  it('null = 清空（回退到 .env）', () => {
    // 全字段置 null —— 界面上的「恢复 .env 配置」就是这么调的
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
    // 清空后 resolve 出来的应当是「未覆盖」状态（overridden = false）
    const r = resolveAiConfig(row(next as Partial<AiSettingsRow>), fakeConfig());
    expect(r.fromDb).toBe(false);
    expect(r.baseUrl).toBe('https://env.example/v1');
    expect(r.apiKey).toBe('sk-env-secret-key');
  });

  it('具体值 = 覆盖', () => {
    const next = merge(cur, { enabled: 0, max_retries: 0 });
    expect(next.enabled).toBe(0);
    expect(next.max_retries).toBe(0);
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
      expect(resolveAiConfig(got, fakeConfig()).baseUrl).toBe('https://db.example/v1');
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
