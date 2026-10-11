import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const libDir = path.resolve('deploy/lib');
// 部署脚本已按职责拆成 install.sh（入口）+ lib/*.sh（函数）。
// 这里按「先入口、后模块」拼成一份源码再断言，这样某个函数落在哪个文件都不影响护栏语义。
const libFiles = () => fs.readdirSync(libDir).filter((f) => f.endsWith('.sh')).sort();
// 工作树里可能是 CRLF（core.autocrlf），统一成 LF 再匹配，免得断言被换行符干扰
const readLf = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const src = () =>
  [script, ...libFiles().map((f) => path.join(libDir, f))].map(readLf).join('\n');

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

// Windows 上的 bash 是 WSL 转发器：既会把多行脚本塞进 bash -c 搞坏（实测报
// ".: /: is a directory"），也不认 C:\... 这种绝对路径。所以多行脚本写成
// 临时文件、放在仓库里、用相对路径执行 —— 两种环境都成立。
const runBash = (body: string) => {
  const rel = `.qy-test-${process.pid}-${Math.random().toString(36).slice(2)}.sh`;
  fs.writeFileSync(path.resolve(rel), body.replace(/\r\n/g, '\n'), 'utf8');
  try {
    return execFileSync('bash', [rel], { stdio: 'pipe', cwd: bashCwd() }).toString();
  } finally {
    fs.rmSync(path.resolve(rel), { force: true });
  }
};

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
  itBash('入口语法检查通过（bash -n）', () => {
    expect(() => execFileSync('bash', ['-n', bashPath()], { stdio: 'pipe', cwd: bashCwd() })).not.toThrow();
  });

  itBash('每个 lib 模块语法检查通过（bash -n）', () => {
    for (const f of libFiles()) {
      // Windows 上要用正斜杠：WSL 的 bash 转发器不认 "deploy\\lib\\x.sh"
      const rel = `deploy/lib/${f}`;
      expect(
        () => execFileSync('bash', ['-n', rel], { stdio: 'pipe', cwd: bashCwd() }),
        `${rel} 语法有问题`,
      ).not.toThrow();
    }
  });

  it('每个 lib 模块都被 install.sh 载入了', () => {
    const loader = readLf(script);
    const missing = libFiles().filter((f) => !loader.includes(f));
    expect(missing, `这些模块没有被载入：${missing.join(', ')}`).toEqual([]);
  });

  itBash('入口里的载入循环真的能跑通（防止模块名拼错）', () => {
    // 出过 .sh.sh 这类错误：列表里已经带后缀，拼接时又加了一次。
    // bash -n 查不出来，只有真的执行一遍才会暴露。
    const loop = /for _qy_m in ([^;]+); do([\s\S]*?)\ndone/.exec(src());
    expect(loop, 'install.sh 里找不到载入模块的 for 循环').not.toBeNull();
    const names = loop![1].trim().split(/\s+/);
    const body = loop![2]
      .split('\n')
      .map((l) => l.replace(/^\s*#.*$/, '').trimEnd())
      .filter(Boolean)
      .join('\n');

    expect([...names].sort(), '载入列表与 deploy/lib 下的文件对不上').toEqual(libFiles());

    const script2 = [
      'set -euo pipefail',
      '_qy_lib=deploy/lib',
      `for _qy_m in ${names.join(' ')}; do`,
      body,
      'done',
      'echo LOADED_OK',
    ].join('\n');
    expect(runBash(script2)).toContain('LOADED_OK');
  });

  itBash('每个模块都能被单独 source（不依赖别的模块先载入）', () => {
    for (const f of libFiles()) {
      expect(runBash(`set -euo pipefail; . "deploy/lib/${f}"; echo OK_${f}`)).toContain(`OK_${f}`);
    }
  });

  it('lib 模块里没有残留可执行顶层代码（只放函数定义）', () => {
    // 模块是被 source 进主脚本的。顶层若还有赋值或流程控制，
    // 执行顺序就会随着「拆到哪个文件」而变 —— 肉眼极难发现，所以钉死。
    // 扫描方式和生成模块时一致：跳过 heredoc 正文，识别单行函数定义。
    const fnDef = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{(.*)$/;
    const heredoc = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*$/;

    const offenders: string[] = [];
    for (const f of libFiles()) {
      const lines = readLf(path.join(libDir, f)).split('\n');
      const topLevel = new Set<number>();
      let delim: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (delim) {
          if (line.trim() === delim) delim = null;
          continue;
        }
        const h = heredoc.exec(line);
        if (h) {
          delim = h[1] ?? h[2] ?? h[3] ?? null;
          continue;
        }
        const m = fnDef.exec(line);
        if (m) {
          // 单行函数定义自成一体；多行函数定义的正文整段跳过。
          // 正文里可能有 heredoc（daemon.json 就有一处），必须一起跳过，
          // 否则正文里的 } 会被误当成函数结尾。
          if (!/\}\s*$/.test(m[2])) {
            let inner: string | null = null;
            for (let j = i + 1; j < lines.length; j++) {
              if (inner) {
                if (lines[j].trim() === inner) inner = null;
                continue;
              }
              const ih = heredoc.exec(lines[j]);
              if (ih) {
                inner = ih[1] ?? ih[2] ?? ih[3] ?? null;
                continue;
              }
              if (/^\}/.test(lines[j])) {
                i = j;
                break;
              }
            }
          }
          continue;
        }
        topLevel.add(i);
      }
      topLevel.forEach((i) => {
        const t2 = lines[i].trim();
        if (t2 && !t2.startsWith('#')) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, `模块里出现了顶层代码：${offenders.join(', ')}`).toEqual([]);
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
    expect(s).toMatch(/^    shortcut\|domain\) /m);
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
    expect(menu).toContain('ui_opt 16 "自定义快捷键"');
    expect(menu).toContain('请输入 0-20');
    // 菜单里能改成字母 / 数字，也能用 - 移除
    expect(menu).toContain('SUBCMD_ARGS="$REPLY"');
    expect(menu).toContain('SUBCMD_ARGS="--remove"');
  });
  it('domain 子命令能查看 / 切换域名，且四个 .env 字段一起改', () => {
    const s = src();
    expect(s).toMatch(/^cmd_domain\(\) \{/m);
    // 子命令要能在参数解析里接住后面的子参数
    expect(s).toContain('shortcut|domain)');
    expect(s).toContain('domain)   cmd_domain ;;');
    // 换域名必须同时改这四个字段，漏一个就会出现「半 HTTPS」或登录被踢
    const fn = s.slice(s.indexOf('domain_apply() {'), s.indexOf('cmd_domain() {'));
    expect(fn).toContain('env_set SITE_DOMAIN');
    expect(fn).toContain('env_set SITE_URL');
    expect(fn).toContain('env_set APP_BIND');
    expect(fn).toContain('env_set TRUST_PROXY');
    expect(fn).toContain('COMPOSE_PROFILES');
    // 文档里承诺的 `upgrade --domain X` 必须真的写 .env
    const up = s.slice(s.indexOf('cmd_upgrade() {'));
    expect(up.slice(0, 3000)).toContain('domain_apply "$DOMAIN"');
  });
  it('系统信息与测速：借鉴 kejilion.sh，但保持只读、不装任何东西', () => {
    const s = src();
    // 子命令三处齐全：解析 → 分发 → 帮助
    expect(s).toMatch(/^cmd_sysinfo\(\) \{/m);
    expect(s).toMatch(/^cmd_speedtest\(\) \{/m);
    expect(s).toMatch(/^  sysinfo\) cmd_sysinfo ;;$/m);
    expect(s).toMatch(/^  speedtest\) cmd_speedtest ;;$/m);
    expect(s).toMatch(/^    install\|upgrade\|.*\|speedtest\|/m);
    const help = usageText();
    expect(help).toContain('sysinfo');
    expect(help).toContain('speedtest');
    // 只读：不得出现装包 / 改系统的动作
    for (const fn of ['cmd_sysinfo', 'cmd_speedtest']) {
      const start = s.indexOf(`${fn}() {`);
      const body = s.slice(start, s.indexOf('\n}\n', start));
      // 只允许把安装命令写在提示文案里（「想装请自行 apt-get install」），不许真去执行
      expect(body, `${fn} 不该真的执行装包或改系统`).not.toMatch(/^\s*(sudo\s+)?(apt-get|yum|dnf|apk|systemctl|docker)\b/m);
      expect(body, `${fn} 不该把装包/改系统的命令塞进命令替换里`).not.toMatch(/\$\(\s*(sudo\s+)?(apt-get|yum|dnf|apk|systemctl\s+(start|stop|enable|restart))\b/);
    }
    // 兜底：读不到的项必须留空而不是让整条命令失败
    expect(s).toMatch(/^sysinfo_uptime\(\) \{/m);
    expect(s).toContain('[ -r /proc/meminfo ] || return 0');
    expect(s).toMatch(/^detect_ip6\(\) \{/m);
  });

  it('测速：curl 失败会输出全 0，必须看退出码而不是直接打印', () => {
    const s = src();
    const start = s.indexOf('speedtest_probe() {');
    const body = s.slice(start, s.indexOf('\n}\n', start));
    // 不能只判空串：curl 失败时 -w 依然会吐 "0 0 0 0"
    expect(body).toContain('if ! out="$(curl');
    expect(body).toContain('探测失败');
    // 下载测速同理：体积太小说明根本没下到东西
    const dl = s.slice(s.indexOf('speedtest_dl() {'), s.indexOf('\n}\n', s.indexOf('speedtest_dl() {')));
    expect(dl).toContain('[ "$bytes" -lt 100000 ] && return 0');
  });

  it('域名解析按 A+AAAA 全量比对，证书到期时间可查', () => {
    const s = src();
    // 老的「取第一条再和 IPv4 比」在双栈域名下会误报，必须换成全量包含判断
    expect(s).toMatch(/^domain_resolved_ips\(\) \{/m);
    const p = s.slice(s.indexOf('domain_points_here() {'), s.indexOf('\n}\n', s.indexOf('domain_points_here() {')));
    expect(p).toContain('grep -Fxq "$ip"');
    // 只留一处「取第一条」的旧逻辑
    expect(s.match(/awk '\{print \$1\}' \| head -n1"$/gm) ?? []).toHaveLength(0);
    // 证书到期：domain status 与 doctor 都要能看到
    expect(s).toMatch(/^cert_expiry_date\(\) \{/m);
    expect(s).toMatch(/^cert_days_left\(\) \{/m);
    expect(s).toContain('cert_left" -le 15');
    expect(s).toContain('HTTPS 证书有效');
    // AAAA 有记录但机器没 v6 出口 → 提前提醒（这种「一半能开」最难查）
    expect(s).toContain('没有公网 IPv6');
  });

  it('只读命令不用 doctor 的计数器（否则会污染体检统计）', () => {
    const s = src();
    for (const fn of ['cmd_sysinfo', 'cmd_speedtest', 'domain_status']) {
      const start = s.indexOf(`${fn}() {`);
      const body = s.slice(start, s.indexOf('\n}\n', start));
      expect(body, `${fn} 是只读展示，不该用 doc_ok/doc_warn/doc_fail`).not.toMatch(/\bdoc_(ok|warn|fail|info)\b/);
    }
  });
  it('tune 只调网络与内存，绝不碰 SSH / 端口 / 防火墙', () => {
    const s = src();
    const start = s.indexOf('cmd_tune() {');
    expect(start).toBeGreaterThan(-1);
    // tune 是唯一会改系统的命令，权限边界必须写死：改错了会把自己锁在门外
    const whole = s.slice(start, s.indexOf('\n}\n', start));
    const touched = [whole, ...tuneFuncs(s).map((f) => s.slice(f, s.indexOf('\n}\n', f)))].join('\n');
    for (const danger of [
      'sshd_config', 'sshd', 'PasswordAuthentication', 'PermitRootLogin',
      'Port 22', 'ufw', 'iptables', 'firewall-cmd', 'systemctl restart ssh',
      'fail2ban',
    ]) {
      expect(touched, `tune 不该碰 ${danger}`).not.toContain(danger);
    }
    // 调优项必须是白名单式声明，不允许出现任意键值对
    expect(s).toContain('tune_items() {');
    expect(whole).toContain('只改网络队列和内存策略');
  });

  it('tune 必须显式调用，安装流程不会顺手改内核', () => {
    const s = src();
    // cmd_tune 只应出现在 dispatch 与菜单里；安装主流程不得调用
    const occurrences = (s.match(/cmd_tune/g) || []).length;
    expect(occurrences).toBe(2); // 定义 + dispatch
    expect(s).not.toMatch(/cmd_tune\s*$/m);
    // 需要 root 的写操作放在 tune_apply / tune_restore 内部，并前置 need_root
    for (const fn of ['tune_apply', 'tune_restore']) {
      const body = s.slice(s.indexOf(`${fn}() {`), s.indexOf('\n}\n', s.indexOf(`${fn}() {`)));
      expect(body.slice(0, 200), `${fn} 改系统前必须先要 root`).toContain('need_root');
    }
    // 有撤销路径
    expect(s).toContain('tune --restore');
    expect(s).toContain('rm -f "$TUNE_CONF"');
  });
  it('clean 只删悬空镜像和构建缓存，绝不碰数据卷或具名镜像', () => {
    const s = src();
    const start = s.indexOf('cmd_clean() {');
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf('\n}\n', start));
    // `docker system prune -a --volumes` 会删掉没被容器引用的具名镜像和数据卷，
    // 备份、上传文件都可能被牵连 —— 这条命令绝不能出现
    expect(body).not.toMatch(/system\s+prune/);
    expect(body).not.toMatch(/--volumes|-a\s+--filter/);
    expect(body).not.toMatch(/volume\s+(rm|prune)/);
    // 只允许这两种清理
    expect(body).toContain('docker image prune -f --filter "dangling=true"');
    expect(body).toContain('docker builder prune -f');
    // 删之前要让用户看见能回收多少、删的是哪一类
    expect(body).toContain('clean_docker_usage');
    expect(body).toContain('会删掉什么');
  });

  it('docker 体积解析用 awk 算术而不是字符串拼接', () => {
    const s = src();
    // 教训：awk 里调用未定义的函数是致命错误，不能拿函数名当条件用
    const fn = s.slice(s.indexOf('clean_size_gb() {'), s.indexOf('\n}\n', s.indexOf('clean_size_gb() {')));
    expect(fn).toContain('(v + 0) * m / 1073741824');
    // 单位换算必须覆盖 GB/MB，不能只有一种
    for (const unit of ['"k"', '"m"', '"g"', '"t"']) {
      expect(fn, `少了 ${unit} 的换算`).toContain(unit);
    }
  });
  const s = src();
  // 用户不该被要求记路径或敲子命令：全局 qingyu 命令必须随安装就位，
  // 且任何目录（含 ~）敲 qingyu 都能打开数字菜单。
  it('安装后提供全局 qingyu 命令入口', () => {
    expect(s).toContain('GLOBAL_LINK_DIRS="/usr/local/bin /usr/bin"');
    expect(s).toContain('global_link_write() {');
    expect(s).toContain('global_link_remove() {');
    expect(s).toContain('exec bash "%s" "$@"');
    // 删除时靠标记识别，避免误删同名文件
    expect(s).toContain("grep -q 'qingyu-universal'");
    // 非 root 安静跳过，绝不让安装因装不上入口而失败
    expect(s).toContain('global_link_maybe() {');
    expect(s).toContain('[ "$(id -u)" = "0" ] || return 0');
  });

  it('菜单与提示只让用户选数字，不教长命令', () => {
    expect(s).toContain('直接输入数字即可，全程不用敲命令');
    expect(s).toContain('敲 qingyu 打开菜单 → 选 14');
    expect(s).not.toContain('换成域名 + 自动 HTTPS：./deploy/install.sh domain set');
    // 菜单每次打开都顺手补装一次入口，忘了也能自愈
    expect(s).toContain('[ "$(id -u)" = "0" ] && global_link_maybe');
  });
  // 「与博客运行无关的远端提交就不必更新」：只看文档/测试/CI 的提交要跳过，
  // 一旦碰到 app/deploy/compose 等运行相关文件就必须更新，判断不了时保守放行。
  it('更新会跳过只改文档测试的提交', () => {
    expect(s).toContain('UPDATE_DOCONLY_PATTERNS=');
    // README/LICENSE/docs/tests/.github/.vscode/markdown 一律算「无关」
    for (const pat of ['README', 'LICENSE', '^docs/', '^tests?/', '^\\.github/', '\\.(md|markdown|rst|txt)$']) {
      expect(s).toContain(pat);
    }
    // 三态返回：0 相关 / 1 仅文档 / 2 判断不了
    expect(s).toContain('update_scope() {');
    expect(s).toContain('show_pending_files() {');
    expect(s).toContain('skip_docs_only_update() {');
  });

  it('check-update / update / update --check 三处都接了相关性判定', () => {
    // 三条路径各出现一次 update_scope
    expect((s.match(/update_scope \|\| /g) || []).length).toBe(3);
    // 默认跳过，--all 才强制拉
    expect(s).toContain('[ "$scope" = "1" ] && [ "$UPDATE_ALL" != "1" ]');
    expect(s).toContain('[ "$cscope" = "1" ] && [ "$UPDATE_ALL" != "1" ]');
    expect(s).toContain('--all)            UPDATE_ALL=1 ;;');
    // 跳过的分支必须在备份/拉代码之前 return，不能半途才决定不更新
    const upd = s.slice(s.indexOf('cmd_update() {'));
    const iScope = upd.indexOf('update_scope || scope=$?');
    const iBackup = upd.indexOf('step_begin "备份当前数据"');
    expect(iScope).toBeGreaterThan(-1);
    expect(iBackup).toBeGreaterThan(iScope);
  });
});

// 抽出 tune_* 函数体的范围（tune 的写操作都在这些辅助函数里）
function tuneFuncs(s: string): number[] {
  return ['tune_items', 'tune_get', 'tune_status', 'tune_apply', 'tune_restore']
    .map((f) => s.indexOf(`${f}() {`))
    .filter((i) => i > -1);
}
