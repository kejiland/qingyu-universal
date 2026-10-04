/* ============================================================
 * 导入示例文章到运行中的实例
 * ------------------------------------------------------------
 * 用法：node dist/cli/seed.js <站点地址> [--token <会话或写入令牌>]
 * 会把 public/posts.js 里的示例文章逐篇 POST 到 /api/posts，
 * 已存在的 id 自动跳过（幂等，可重复执行）。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface SeedPost {
  id?: string;
  title?: string;
  [key: string]: unknown;
}

const args = process.argv.slice(2);
const base = args[0];
const tokenIndex = args.indexOf('--token');
const token = (tokenIndex >= 0 ? args[tokenIndex + 1] : '') || process.env.BLOG_TOKEN || '';

if (!base || base.startsWith('--')) {
  console.error('用法：node dist/cli/seed.js <站点地址> [--token <token>]\n示例：node dist/cli/seed.js https://blog.example.com');
  process.exit(1);
}

// posts.js 是 JS 字面量而非 JSON，用 vm 沙箱取出 BLOG_POSTS
const source = fs.readFileSync(path.join(ROOT, 'app', 'public', 'posts.js'), 'utf8');
const sandbox: { window: { BLOG_POSTS?: SeedPost[] } } = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const posts = sandbox.window.BLOG_POSTS ?? [];

const api = `${base.replace(/\/+$/, '')}/api/posts`;
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (token) headers['Authorization'] = `Bearer ${token}`;

console.log(`目标 API：${api}${token ? '（已携带凭证）' : '（无凭证，若后端要求鉴权将返回 401）'}`);

let created = 0;
let skipped = 0;
let failed = 0;

for (const post of posts) {
  try {
    const response = await fetch(api, { method: 'POST', headers, body: JSON.stringify(post) });
    if (response.status === 201) {
      created++;
      console.log(`  ✓ 已创建：${post.title}`);
    } else if (response.status === 409) {
      skipped++;
      console.log(`  · 已存在：${post.title}`);
    } else {
      failed++;
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      console.log(`  ✗ 失败(${response.status})：${post.title} — ${detail.error ?? ''}`);
    }
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ 请求异常：${post.title} — ${message}`);
  }
}

console.log(`\n完成：新建 ${created} / 跳过 ${skipped} / 失败 ${failed}`);
if (failed && !token) {
  console.log('提示：若后端开启写鉴权，请携带凭证重试（--token 或 BLOG_TOKEN 环境变量）。');
}
process.exit(failed ? 1 : 0);