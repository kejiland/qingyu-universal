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

// Windows 上的 bash 通常是 WSL 的转发器，只认 POSIX 路径：把 E:\a\b 直接丢给它
// 会被当成一个叫 "E:Qingyu-vpsdeployinstall.sh" 的文件，而 wslpath 在没装 WSL
// 的机器上也未必存在。这里改成「在仓库根目录里传相对路径」，两种情况都成立。
const bashPath = () => {
  if (process.platform !== 'win32') return script;
  return 'deploy/install.sh';
};
const bashCwd = () => (process.platform === 'win32' ? path.resolve('.') : undefined);

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
    expect(() => execFileSync('bash', ['-n', bashPath()], { stdio: 'pipe', cwd: bashCwd() })).not.toThrow();
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

  // ---------- 更新（update / check-update）----------
  it('更新功能的关键函数都还在', () => {
    const s = src();
    for (const fn of ['remote_revision', 'compare_revision', 'show_pending_commits', 'cmd_update', 'cmd_check_update']) {
      expect(s, `缺少函数 ${fn}()`).toMatch(new RegExp(`^${fn}\\(\\)\\s*\\{`, 'm'));
    }
  });

  it('update / check-update 都接到了分发器', () => {
    const s = src();
    expect(s).toMatch(/^\s*update\)\s+cmd_update ;;$/m);
    expect(s).toMatch(/^\s*check-update\)/m);
  });

  it('拿不到远端版本时绝不继续更新（不能把正在跑的版本换成别的）', () => {
    const s = src();
    const fn = s.slice(s.indexOf('cmd_update() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // compare_revision 失败（unknown）必须走 die，不能继续往下走备份/重建
    expect(body).toContain('拿不到远端版本号');
    const dieAt = body.indexOf('拿不到远端版本号');
    const backupAt = body.indexOf('backup_now');
    const buildAt = body.indexOf('compose_build');
    expect(dieAt, 'cmd_update 里找不到 unknown 分支的错误提示').toBeGreaterThan(-1);
    expect(backupAt, 'cmd_update 里找不到 backup_now').toBeGreaterThan(-1);
    expect(buildAt, 'cmd_update 里找不到 compose_build').toBeGreaterThan(-1);
    expect(dieAt).toBeLessThan(backupAt);
    expect(dieAt).toBeLessThan(buildAt);
  });

  it('更新前一定先备份（代码能回滚，数据库迁移回滚不了）', () => {
    const s = src();
    const fn = s.slice(s.indexOf('cmd_update() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.indexOf('backup_now')).toBeLessThan(body.indexOf('update_source'));
    expect(body.indexOf('update_source')).toBeLessThan(body.indexOf('compose_build'));
  });

  it('比较版本的两端都拿得到 SHA 才敢判「已是最新」', () => {
    const s = src();
    const fn = s.slice(s.indexOf('compare_revision() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('UPDATE_CUR="$(resolve_revision_full)"');
    expect(body).toContain('UPDATE_REMOTE="$(remote_revision)"');
    // 本地读不出来也要算 unknown —— refs_equal 空值会返回 1，
    // 若不显式拦掉就会被误判成「有新版」，白重建一次还可能降级
    expect(body).toMatch(/if \[ -z "\$UPDATE_CUR" \]/);
    expect(body).toContain('UPDATE_STATE="unknown"');
  });

  // ---------- 终端 UI ----------
  it('有一套统一的排版原语（不再各处手工拼盒子）', () => {
    const s = src();
    for (const fn of ['ui_banner', 'ui_section', 'ui_kv', 'ui_hint', 'ui_opt', 'ui_rule', 'ui_bar']) {
      expect(s, `缺少 UI 原语 ${fn}()`).toMatch(new RegExp(`^${fn}\\(\\)\\s*\\{`, 'm'));
    }
    // 非 UTF-8 终端要能降级成 ASCII，否则进度条 / 对勾全是乱码
    expect(s).toContain('G_FULL');
    expect(s).toMatch(/G_FULL="#"/);
    // 尊重 NO_COLOR
    expect(s).toContain('NO_COLOR');
  });

  it('自定义配置项：解析、用法、配置档、.env 四处都齐', () => {
    const s = src();
    for (const f of [
      '--admin-email',
      '--data-dir',
      '--log-level',
      '--redis',
      '--ai-base-url',
      '--ai-key',
      '--ai-model',
      '--s3-endpoint',
      '--s3-region',
      '--s3-key-id',
      '--s3-secret',
      '--s3-bucket',
      '--s3-public-base',
    ]) {
      expect(s, `${f} 没有写进 .env 模板`).toContain(f);
      expect(s, `${f} 没有写进配置档导出`).toContain(f);
    }
    // 这些值必须真的落到 env（否则「填了没生效」）
    for (const k of ['BLOG_ADMIN_EMAIL', 'LOG_LEVEL', 'REDIS_URL', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'S3_ENDPOINT']) {
      expect(s, `${k} 没有写进 .env`).toContain(`${k}=`);
    }
  });

  it('默认零配置：不加任何参数也不会提问', () => {
    const s = src();
    // NO_WIZARD 默认 1 —— 只有显式 --wizard 才走问答向导
    expect(s).toMatch(/^NO_WIZARD=1/m);
    // interact_mode / interact_database 都要在「没要求向导」时直接返回
    for (const fn of ['interact_mode', 'interact_database']) {
      const body = s.slice(s.indexOf(`${fn}() {`));
      expect(body.slice(0, 600), `${fn} 没有「非向导直接返回」的短路`).toContain('[ "$WIZARD_FORCE" != "1" ] && return 0');
    }
    // 帮助第一屏必须告诉用户「什么都不用填」
    const help = usageText();
    expect(help).toContain('默认行为：不提问、不需要任何配置');
  });

  it('只检查的命令不装 git（纯只读，不该动系统包管理器）', () => {
    const s = src();
    const fn = s.slice(s.indexOf('cmd_check_update() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toContain('ensure_git');
  });
it('边框不再用 tr 拼重复字符（非 UTF-8 locale 下会变乱码）', () => {
    const s = src();
    // tr 在非 UTF-8 locale 下按字节处理，─(3 字节) 会被拆成乱码，必须走纯 bash 拼接
    expect(s).not.toMatch(/^\s*[^#\n].*\| tr ' '/m);
    expect(s).toMatch(/^ui_repeat\(\) \{/m);
  });

  it('快捷键：默认 k、可自定义、可移除，装完自动生效', () => {
    const s = src();
    expect(s).toMatch(/^SHORTCUT_KEY="k"/m);
    expect(s).toMatch(/^SHORTCUT_OFF=0/m);
    expect(s).toMatch(/^    shortcut\) /m);
    expect(s).toMatch(/^  shortcut\)   cmd_shortcut ;;$/m);
    // 大小写两个别名都写，Shift 敲也能用
    expect(s).toContain('alias %s=');
    // 改键前先删旧块，避免留下两个快捷键
    expect(s).toContain('shortcut_strip "$rc"');
    // 安装成功后自动装上
    const fn = s.slice(s.indexOf('cmd_install() {'));
    expect(fn).toContain('shortcut_maybe');
  });

  it('运维菜单明示当前快捷键并提供交互式自定义入口', () => {
    const s = src();
    expect(s).toMatch(/^shortcut_current_key\(\) \{/m);
    const start = s.indexOf('maybe_show_menu() {');
    const menu = s.slice(start, s.indexOf('\n}\n', start));
    // 当前键必须从 rc 文件实读，不能把默认 k 当成“已安装”
    expect(menu).toContain('shortcut_key="$(shortcut_current_key)"');
    expect(menu).toContain('ui_kv "终端快捷键"');
    expect(menu).toContain('ui_opt 15 "自定义快捷键"');
    expect(menu).toContain('请输入 0-15');
    // 菜单里能改成字母 / 数字，也能用 - 移除
    expect(menu).toContain('SUBCMD_ARGS="$REPLY"');
    expect(menu).toContain('SUBCMD_ARGS="--remove"');
  });
});
