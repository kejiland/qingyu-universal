/* ============================================================
 * 护栏：AI 网关地址 / API Key 等隐私不得进入版本库
 * ------------------------------------------------------------
 * 背景：调试 AI 功能时把真实网关地址写进了 README 的变更记录和
 * 测试注释里。这些文件是要提交的，等于把个人配置泄露到公开仓库。
 *
 * 扫的是「会被提交的文件」：优先问 git（`git ls-files`），
 * 拿不到就回退成目录遍历 + 跳过 gitignore 管着的目录。
 * 回退不是为了偷懒——本机 Node spawn 子进程会 EBUSY，
 * 而护栏不能因为环境抽风就静默失效，所以两条路都要有。
 *
 * 三条断言：
 *   1. `.env*` 只有 `.env.example` 该入库，且它的值必须为空；
 *   2. AI_BASE_URL 的值只能是空 / `<占位符>` / 公开厂商白名单；
 *   3. 不得出现真实 key 形状（`sk-` 后跟 16 位以上字母数字）。
 *
 * 注意：本文件的注释里不要连写「AI_某个键 + 等号」，否则护栏会扫到自己
 * （已经发生过一次）。描述时把等号写成「等号」二字。
 * ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');

/* ---------- 候选文件 ---------- */

/** gitignore 管着的目录，目录遍历时要跳过。 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'data', 'uploads', 'backups',
  '.git', '.workbuddy', 'coverage', '.vitest', '.qingyu'
]);

/**
 * 本地环境文件：`.env` / `.env.docker` 里**必然**有真实网关与 Key，
 * 它们不入库（gitignore 挡着），所以也不能被扫——否则护栏会拿
 * 「不该提交的文件」去判定「提交是否合规」，逻辑就反了。
 */
function isEnvFile(name: string): boolean {
  return /^\.env/.test(name) && name !== '.env.example';
}

/** 压缩产物与第三方库：体积大、不是人写的代码，跳过以免拖慢并误报。 */
function isScannable(rel: string): boolean {
  if (/\.(min\.(js|css)|map)$/.test(rel)) return false;
  if (/^app\/public\/libs\//.test(rel)) return false;
  if (/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|pdf|db)$/i.test(rel)) return false;
  return true;
}

function viaGit(): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    const list = out.split('\n').map((l) => l.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
  } catch {
    return null; // spawn 被拦（EBUSY）或不在 git 仓库里
  }
}

function viaWalk(): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(ROOT, rel) : ROOT;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(childRel);
      } else if (!isEnvFile(e.name)) {
        out.push(childRel);
      }
    }
  }
  return out;
}

const tracked: string[] = (viaGit() ?? viaWalk()).filter(isScannable);

/* ---------- 判定规则 ---------- */

/** 允许出现在提交内容里的公开厂商示例地址（这些不是隐私）。 */
const PUBLIC_AI_HOSTS = [
  'api.openai.com',
  'api.deepseek.com',
  'api.siliconflow.cn',
  'api.groq.com',
  'openrouter.ai',
  'api.moonshot.cn',
  'api.zhipuai.cn',
  'dashscope.aliyuncs.com',
  'localhost',
  '127.0.0.1'
];

/** ps1 里模板行形如「AI_BASE_URL + 等号 + 引号 + 引号 + 逗号」，
 *  值会被包一层引号还带尾逗号，先剥干净再判定。 */
function cleanValue(raw: string): string {
  return raw.trim().replace(/^["']/, '').replace(/["',;\s]+$/, '');
}

/** 文档里常见的假值：`<占位符>`、`...`、`sk-...`、`your-key-here`。 */
const PLACEHOLDER = /^(?:<.*>|\.{2,}|sk-\.+|sk-[xX*]{2,}|x{2,}|your[-_ ].*|changeme|placeholder|<.*)$/i;

function isPlaceholder(value: string): boolean {
  return !value || PLACEHOLDER.test(value);
}

function isPlaceholderOrPublic(value: string): boolean {
  return isPlaceholder(value) || PUBLIC_AI_HOSTS.some((h) => value.includes(h));
}

function scan(re: RegExp): string[] {
  const hits: string[] = [];
  for (const rel of tracked) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(re)) hits.push(`${rel}: ${m[0]}`);
  }
  return hits;
}

describe('隐私不入库：AI 网关地址与 API Key', () => {
  it('扫描到的文件数量合理（防止 git/walk 失灵导致空扫描）', () => {
    expect(tracked.length).toBeGreaterThan(50);
  });

  /* 两条注意事项（都踩过）：
   * ① 值部分写 `[^"\r\n]*` 而不是 `[^"\s]+`——模板里赋值后紧跟换行，
   *    用 `\s+` 会跨行把下一行整个吃掉当值，报出一串假阳性；
   * ② 本文件的注释里不要再连写「AI_某个键 + 等号」，否则会扫到自己。 */
  const ASSIGN = (key: string) => new RegExp(`${key}[ \\t]*=[ \\t]*"?([^"\\r\\n]*)"?`, 'g');

  const badValues = (key: string, accept: (v: string) => boolean): string[] => {
    const bad: string[] = [];
    for (const rel of tracked) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const m of txt.matchAll(ASSIGN(key))) {
        const v = cleanValue(m[1]);
        if (v && !accept(v)) bad.push(`${rel}: ${m[0]}`);
      }
    }
    return bad;
  };

  it('提交内容里 AI_BASE_URL 不得带私有网关地址', () => {
    const bad = badValues('AI_BASE_URL', isPlaceholderOrPublic);
    expect(bad, `疑似私有网关地址（只允许空值 / <占位符> / 公开厂商）：\n${bad.join('\n')}`).toEqual([]);
  });

  it('提交内容里 AI_API_KEY 不得带真实密钥', () => {
    const bad = badValues('AI_API_KEY', isPlaceholder);
    expect(bad, `疑似真实 API Key：\n${bad.join('\n')}`).toEqual([]);
  });

  it('提交内容里不得出现真实 key 形状（sk- 后跟 16 位以上字符）', () => {
    const bad = scan(/sk-[A-Za-z0-9]{16,}/g);
    expect(bad, `疑似真实密钥字符串：\n${bad.join('\n')}`).toEqual([]);
  });

  /* AI 配置已经不读 .env 了（唯一真源是后台写入的 ai_settings 表），
   * 所以 .env.example 里**不该再有**这两个键 —— 留着反而会让人以为
   * 填了有用。这里把断言反过来：有这个键就是回归。 */
  it('.env.example 里不再有 AI 网关 / 密钥变量', () => {
    const txt = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const key of ['AI_BASE_URL', 'AI_API_KEY']) {
      expect(txt, `.env.example 不该再出现 ${key}（AI 只走后台配置）`).not.toMatch(
        new RegExp(`^${key}\\s*=`, 'm')
      );
    }
  });

  /* AI 两项之外也一样：这个模板是要给人抄的，任何密钥类键只要被填了值，
   * 就等于把「示例」变成了「待泄露的默认值」。注释行（# 开头）不算。 */
  it('.env.example 里所有密钥类键都必须留空', () => {
    const txt = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const filled: string[] = [];
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS|PASSWORD)[A-Z0-9_]*)\s*=(.*)$/);
      if (!m) continue;
      const [, key, value] = m;
      if (value.trim() && !/^<.*>$/.test(value.trim())) filled.push(`${key}=${value.trim()}`);
    }
    expect(filled, `.env.example 里这些密钥不该有值：\n${filled.join('\n')}`).toEqual([]);
  });

  it('部署脚本写出的 .env 模板里 AI 两项必须是空值', () => {
    /* 两个脚本语法不同，分开锚定：
     *   sh  : AI_BASE_URL 后直接等号再换行
     *   ps1 : 同上，但整行被引号包住、末尾多一个逗号
     *         —— 值必须停在引号前，否则会把行尾逗号当成值 */
    const patterns: Array<[string, RegExp]> = [
      ['deploy/install.sh', /^AI_(?:BASE_URL|API_KEY)=(.*)$/gm],
      ['deploy/install.ps1', /^\s*"AI_(?:BASE_URL|API_KEY)=(.*)",\s*$/gm]
    ];
    let checked = 0;
    for (const [rel, re] of patterns) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const m of txt.matchAll(re)) {
        checked += 1;
        expect(m[1].trim(), `${rel} 里的 ${m[0].trim()} 应该是空模板`).toBe('');
      }
    }
    expect(checked, '两个部署脚本都没匹配到 AI 模板行，正则可能已失效').toBeGreaterThanOrEqual(4);
  });
});
