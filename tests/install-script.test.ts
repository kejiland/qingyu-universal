import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 一键部署脚本的护栏测试。
 *
 * install.sh 是纯 bash、没有类型检查兜底，写错一个引号只有到了服务器上才会炸；
 * 而「用法里写了但参数解析没接」「接了但用法里没写」这类偏差更是只能靠人眼发现。
 * 这里把几件最容易坏的事钉死：语法、用法与解析的一致性、新增能力的关键符号仍在。
 *
 * 说明：本文件只在能调用 bash 的环境下断言语法（Windows 上 spawn bash 会 EBUSY），
 * 其余断言全部基于源码文本，任何平台都稳定可跑。
 */
const script = path.resolve('deploy/install.sh');
// 工作树里可能是 CRLF（core.autocrlf），统一成 LF 再匹配，免得断言被换行符干扰
const src = () => fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n');

const canRunBash = (() => {
  try {
    execFileSync('bash', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const itBash = canRunBash ? it : it.skip;

const flagsIn = (text: string) => {
  const out = new Set<string>();
  for (const m of text.matchAll(/--([a-z][a-z0-9-]*)/g)) out.add(m[1]);
  return out;
};

// 用法文本：usage() 里的 heredoc（不靠执行脚本拿，避免平台差异）
const usageText = () => {
  const s = src();
  const start = s.indexOf('usage() {');
  const end = s.indexOf('\nEOF\n}', start);
  expect(start, '找不到 usage()').toBeGreaterThan(-1);
  expect(end, 'usage() 的 heredoc 没有正常结束').toBeGreaterThan(start);
  return s.slice(start, end);
};

// 参数解析段落：只取 while 循环那一段，避免 usage 文本里的同名字符串干扰。
// 锚点必须是「参数解析」这段注释 —— 脚本里还有别处（curl 兼容层）也用
// `while [ $# -gt 0 ]`，直接搜那句话会定位到错误的位置。
const parseRegion = () => {
  const s = src();
  const start = s.indexOf('# ---------- 参数解析 ----------');
  const end = s.indexOf('\ndone', start);
  expect(start, '找不到参数解析循环').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
};

describe('deploy/install.sh', () => {
  itBash('语法检查通过（bash -n）', () => {
    expect(() => execFileSync('bash', ['-n', script], { stdio: 'pipe' })).not.toThrow();
  });

  it('用法里列出的每个长选项都真的被解析', () => {
    const documented = flagsIn(usageText());
    const parsed = flagsIn(parseRegion());
    const missing = [...documented].filter((f) => !parsed.has(f));
    expect(missing, `用法里写了但没接的选项：${missing.join(', ')}`).toEqual([]);
  });

  it('解析的每个长选项都在用法里写清楚了', () => {
    const documented = flagsIn(usageText());
    const parsed = flagsIn(parseRegion());
    const undocumented = [...parsed].filter((f) => !documented.has(f));
    expect(undocumented, `接了但没告诉用户的选项：${undocumented.join(', ')}`).toEqual([]);
  });

  it('向导 / 断点续跑 / 演练 / 配置档的关键函数都还在', () => {
    const s = src();
    for (const fn of [
      'run_wizard',
      'wizard_probe',
      'is_valid_domain',
      'wizard_summary',
      'wizard_maybe',
      'run_step',
      'state_has',
      'state_mark',
      'state_clear',
      'dry_run_report',
      'apply_timezone',
      'apply_env_extras',
      'save_config_maybe',
      'load_config_file',
      'post_install_guide',
      'show_version_diff',
    ]) {
      // 定义处为了对齐会写 `state_has()   {`，所以按正则匹配而不是整串包含
      expect(s, `缺少函数 ${fn}()`).toMatch(new RegExp(`^${fn}\\(\\)\\s*\\{`, 'm'));
    }
  });

  it('安装步骤都走 run_step（断点续跑才不会漏掉某一步）', () => {
    const s = src();
    for (const key of ['sysenv', 'source', 'config', 'preflight', 'build']) {
      expect(s, `步骤 ${key} 没有登记进度`).toContain(`run_step ${key} `);
    }
  });

  it('演练模式在任何实际改动之前就返回', () => {
    const s = src();
    const dry = s.indexOf('if [ "$DRY_RUN" = "1" ]; then');
    const mutate = s.indexOf('run_step sysenv');
    expect(dry).toBeGreaterThan(-1);
    expect(mutate).toBeGreaterThan(dry);
  });

  it('安装收尾会给出「接下来做什么」而不是只丢一个地址', () => {
    const s = src();
    expect(s).toContain('post_install_guide');
    expect(s).toContain('接下来三件事');
  });
});
