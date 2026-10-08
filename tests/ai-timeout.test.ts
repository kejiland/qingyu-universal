/* ============================================================
 * 护栏：AI 链路的自托管增强（前端超时覆盖 + 后端可配超时/重试）
 * ------------------------------------------------------------
 * 背景：接第三方 OpenAI 兼容网关后出过两类问题。（具体网关地址属于个人配置，
 * 写在未入库的 `.env` 里，**不要**写进代码或测试——这里只描述现象，不记地址。）
 *
 * 1) 前端 8 秒硬超时掐断正常生成
 *    前台 apiFetch() 对所有请求统一 8s abort（app.js「超时兜底」）。
 *    上游 Workers AI 常在 2-5s 内返回所以够用，但第三方网关一次摘要生成
 *    普遍 3-12s、偶发几十秒 —— 8s 把**正常**生成掐断，用户看到的是
 *    「signal is aborted without reason」这种没人看得懂的报错。
 *    修复：apply-own-patches.mjs 第 6 类补丁给 apiFetch 加 opts.timeoutMs
 *    覆盖（上游恒为 8000，行为不变），AI 调用点传 60s。
 *
 * 2) 网关间歇性失败 + 超时不可配
 *    src/bindings/ai.ts 原来一次 fetch 定生死（60s 硬编码），
 *    网关偶发 fetch failed / 超时就直接 502。现在自带有限重试，
 *    且 AI_TIMEOUT_MS / AI_MAX_RETRIES 可配。
 *
 * 这些补丁在每次 sync:upstream 后重放，本文件钉住「补丁确实在、
 * 压缩产物确实带上」——防止上游同步后静默丢失。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const APP_JS = read('app/public/app.js');
const ADMIN_JS = read('app/public/admin.js');
const APP_MIN = read('app/public/app.min.js');
const ADMIN_MIN = read('app/public/admin.min.js');
const PATCH_SCRIPT = read('scripts/apply-own-patches.mjs');
const AI_BINDING = read('src/bindings/ai.ts');
const CONFIG_TS = read('src/config.ts');
const ENV_EXAMPLE = read('.env.example');

describe('前端超时覆盖 · 补丁在源文件与压缩产物里都生效', () => {
  it('补丁脚本里有第 6 类 patchAiTimeout() 且被执行', () => {
    expect(PATCH_SCRIPT).toContain('function patchAiTimeout()');
    expect(PATCH_SCRIPT).toMatch(/patchAiTimeout\(\);/);
  });

  it('app.js 的 apiFetch 支持 opts.timeoutMs 覆盖（无传参时仍是 8000）', () => {
    expect(APP_JS).toContain('Number(opts && opts.timeoutMs) || 8000');
  });

  it('app.js 的 AI 摘要调用传了 60s 超时', () => {
    expect(APP_JS).toMatch(/apiFetch\('api\/ai\/summary',\s*\{\s*method:\s*'POST',\s*timeoutMs:\s*60000/);
  });

  it('admin.js 三处 AI 调用（assist / summarize / screen）都传了 60s', () => {
    const calls = [
      /api\('api\/ai\/assist',\s*\{\s*method:\s*'POST',\s*timeoutMs:\s*60000/,
      /api\('api\/ai\/comments',\s*\{\s*method:\s*'POST',\s*timeoutMs:\s*60000,\s*body:[^)]*summarize/,
      /api\('api\/ai\/comments',\s*\{\s*method:\s*'POST',\s*timeoutMs:\s*60000,\s*body:[^)]*screen/
    ];
    for (const re of calls) expect(ADMIN_JS, '缺少 60s 超时的 AI 调用: ' + re).toMatch(re);
  });

  it('压缩产物同样带上补丁（页面实际加载的是 .min.js）', () => {
    expect(APP_MIN).toContain('timeoutMs');
    expect(APP_MIN).toMatch(/timeoutMs\)\|\|8e3/); // Number(...) || 8000 被压成 ||8e3
    expect(ADMIN_MIN.match(/timeoutMs:6e4/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('AI 绑定 · 超时与重试可配', () => {
  it('适配器带有限重试，且只重试可恢复的失败', () => {
    expect(AI_BINDING).toContain('maxRetries');
    expect(AI_BINDING).toContain('isRetryable');
    expect(AI_BINDING).toMatch(/HTTP 429/);
    expect(AI_BINDING).toMatch(/HTTP 5\\d\\d|HTTP 5\{2\}|5\\d\\d/);
  });

  it('config 暴露 AI_TIMEOUT_MS / AI_MAX_RETRIES', () => {
    expect(CONFIG_TS).toContain('AI_TIMEOUT_MS');
    expect(CONFIG_TS).toContain('AI_MAX_RETRIES');
    expect(CONFIG_TS).toMatch(/maxRetries: env\.AI_MAX_RETRIES/);
  });

  it('.env.example 有对应说明（新用户照着填就能通）', () => {
    expect(ENV_EXAMPLE).toContain('AI_TIMEOUT_MS=');
    expect(ENV_EXAMPLE).toContain('AI_MAX_RETRIES=');
  });

  it('AI_MODEL 未配置时的兜底行为有注释说明（否则会 502）', () => {
    // src/bindings/ai.ts 把未配置的模型兜底成 gpt-4o-mini；
    // 第三方网关多半没有这个型号，必须显式配置 AI_MODEL。
    expect(AI_BINDING).toMatch(/gpt-4o-mini/);
  });
});
