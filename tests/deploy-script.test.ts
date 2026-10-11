import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 部署助手（deploy/qy.sh）的护栏测试。
 *
 * 这是纯 bash 的交互脚本，最容易坏的不是语法而是交互本身 ——
 * 出过两次只有真跑才暴露的 bug：主菜单用错校验函数导致死循环，
 * 以及提示语被 $(...) 命令替换吞掉，用户既看不到提问也看不到纠错。
 * 下面的用例都是把脚本真的跑一遍。
 */
const script = path.resolve('deploy/qy.sh');
const readLf = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const src = () => readLf(script);

// 取出某个函数体：从函数起点往后找第一个顶格 } 作为结尾。
// 写成 s.slice(s.indexOf(f), s.indexOf('\n}')) 会踩坑 —— 那个 indexOf
// 命中的是前面某个函数的结尾，切出来是空串，测试会莫名其妙地失败。
const funcBody = (s: string, name: string) => {
  const i = s.indexOf(`\n${name}() {`);
  expect(i, `找不到 ${name}`).toBeGreaterThan(-1);
  const j = s.indexOf('\n}', i);
  expect(j, `${name} 没有正常结束`).toBeGreaterThan(i);
  return s.slice(i, j);
};

const canRunBash = (() => {
  try {
    execFileSync('bash', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const itBash = canRunBash ? it : it.skip;

const bashCwd = () => (process.platform === 'win32' ? path.resolve('.') : undefined);

// 多行脚本用 bash -c 在这台机器上会被 WSL 转发层搞坏，写成文件再执行
const runBash = (body: string, input?: string, args: string[] = []) => {
  const rel = `.qy-test-${process.pid}-${Math.random().toString(36).slice(2)}.sh`;
  fs.writeFileSync(path.resolve(rel), body.replace(/\r\n/g, '\n'), 'utf8');
  try {
    const r = spawnSync('bash', [rel, ...args], { cwd: bashCwd(), input, encoding: 'utf8' });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } finally {
    fs.rmSync(path.resolve(rel), { force: true });
  }
};

// 拿一个「确定没装过」的目录，避免碰到真实部署
const FRESH = '/tmp/qy-not-installed';

describe('deploy/qy.sh', () => {
  itBash('语法检查通过（bash -n）', () => {
    expect(() => execFileSync('bash', ['-n', 'deploy/qy.sh'], { stdio: 'pipe', cwd: bashCwd() })).not.toThrow();
  });

  itBash('管道喂完输入会退出，不会无限刷屏', () => {
    // 出过一次死循环：主菜单按「选项个数」校验，传不了选项的菜单永远不合法，
    // 输入流结束后又默认选中 1，于是反复重画菜单。
    const out = runBash('QINGYU_DIR=/tmp/qy-not-installed bash deploy/qy.sh', '0\n');
    expect(out).not.toContain('timeout');
    // 只应出现一次菜单标题
    expect(out.match(/轻语博客 · 部署助手/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  itBash('提问和纠错提示要打到 stderr，不能被 $(...) 吞掉', () => {
    // pick / menu_read 都在 $(...) 里调用，提示走 stdout 就等于没提示
    const out = runBash('QINGYU_DIR=/tmp/qy-not-installed bash deploy/qy.sh', 'abc\n99\n0\n');
    expect(out, '看不到「请选择」提示').toContain('请选择');
    expect(out, '输入非数字没有提示').toContain('请输入数字');
    expect(out, '选了不存在的编号没有提示').toContain('没有 99 这个选项');
  });

  itBash('非法输入会被拦住并重问', () => {
    const out = runBash('QINGYU_DIR=/tmp/qy-not-installed bash deploy/qy.sh', 'abc\n\n0\n');
    expect(out).toContain('请输入数字');
    // 空输入走默认（1 = 安装），至少不该把非法输入当成有效选择
    expect(out).not.toContain('没有 abc 这个选项');
  });

  itBash('没装过就执行安装类命令，会友好报错而不是崩', () => {
    const out = runBash('QINGYU_DIR=/tmp/qy-not-installed bash deploy/qy.sh status');
    expect(out).toContain('还没安装过');
  });

  itBash('--help 列出所有子命令', () => {
    const out = runBash('bash deploy/qy.sh --help');
    for (const c of ['install', 'update', 'rollback', 'backup', 'restore', 'doctor', 'clean']) {
      expect(out, `帮助里缺少 ${c}`).toContain(c);
    }
  });

  itBash('不认识的命令会报错', () => {
    const out = runBash('bash deploy/qy.sh no-such-command');
    expect(out).toContain('不认识');
  });

  it('菜单是纯数字选择，没有要用户记的命令', () => {
    const s = src();
    const menu = funcBody(s, 'menu');
    // 九个功能 + 退出，全部是 1)-9) / 0)
    for (let i = 0; i <= 9; i++) {
      expect(menu, `菜单里没有 ${i} 这一项`).toMatch(new RegExp(`^\\s+${i}\\)`, 'm'));
    }
    expect(menu).not.toContain('deploy/install.sh');
  });

  it('清理只删悬空镜像和构建缓存，绝不碰数据卷', () => {
    const s = src();
    const body = funcBody(s, 'do_clean');
    // docker system prune -a --volumes 会删掉具名镜像和数据卷
    expect(body).not.toMatch(/system\s+prune/);
    expect(body).not.toMatch(/--volumes/);
    expect(body).not.toMatch(/volume\s+(rm|prune)/);
    expect(body).toContain('docker image prune -f --filter "dangling=true"');
    expect(body).toContain('docker builder prune -f');
    // 删之前要让用户知道会删什么
    expect(body).toContain('不会碰数据库、备份和上传的文件');
  });

  it('无域名直连时必须关掉 TRUST_PROXY', () => {
    // 直连暴露时若还信 X-Forwarded-For，客户端能伪造 IP 绕过登录锁定和频控
    const body = funcBody(src(), 'write_env');
    const branches = /if \[ -n "\$domain" \]; then([\s\S]*?)else([\s\S]*?)\n  fi/.exec(body);
    expect(branches, 'write_env 里找不到「有域名 / 无域名」两个分支').not.toBeNull();
    expect(branches![1], '有域名时（走反代）应该信任 X-Forwarded-For').toContain('trust=1');
    expect(branches![2], '无域名直连暴露时必须 trust=0').toContain('trust=0');
  });

  it('更新前一定先备份', () => {
    const s = src();
    const body = funcBody(s, 'do_update');
    const iBackup = body.indexOf('do_backup');
    const iFetch = body.indexOf('fetch_code');
    expect(iBackup, '更新前没有先备份').toBeGreaterThan(-1);
    expect(iBackup, '备份必须发生在拉代码之前').toBeLessThan(iFetch);
  });

  it('回滚前也先备份', () => {
    const s = src();
    const body = funcBody(s, 'do_rollback');
    expect(body.indexOf('do_backup')).toBeLessThan(body.indexOf('checkout'));
  });

  it('每个菜单项都接到了实际动作，没有空分支', () => {
    const s = src();
    const menu = s.slice(s.indexOf('menu() {'), s.indexOf('\nmain()'));
    const dispatch = menu.slice(menu.indexOf('local c;'));
    for (let i = 1; i <= 9; i++) {
      const m = new RegExp(`^\\s+${i}\\)\\s+do_\\w+`, 'm').exec(dispatch);
      expect(m, `菜单第 ${i} 项没有接到 do_xxx 动作`).not.toBeNull();
    }
  });
  it('安装不再问域名和端口，只留数据库的数字选择', () => {
    const body = funcBody(src(), 'do_install');
    expect(body).not.toMatch(/ask\s+"域名/);
    expect(body).not.toMatch(/ask\s+"想用哪个端口/);
    expect(body).toContain('菜单第 7 项');
    // 端口固定为默认 8787，域名留空
    expect(body).toContain('local domain="" port=8787');
  });

  it('解除域名的端口也是数字选择，且校验非法端口', () => {
    const body = funcBody(src(), 'unset_domain');
    expect(body).toMatch(/pick "改用哪个端口？"/);
    expect(body).toMatch(/端口必须是数字/);
  });
});
describe('deploy/install.sh（curl | bash 引导脚本）', () => {
  const boot = () => readLf(path.resolve('deploy/install.sh'));

  itBash('语法检查通过（bash -n）', () => {
    expect(() =>
      execFileSync('bash', ['-n', 'deploy/install.sh'], { stdio: 'pipe', cwd: bashCwd() })
    ).not.toThrow();
  });

  it('下载地址带完整仓库前缀（老版本踩过的 fatal: repository does not exist）', () => {
    expect(boot()).toContain('https://raw.githubusercontent.com/$REPO/$BRANCH/deploy/qy.sh');
    // 不允许出现没有协议前缀的裸仓库名克隆
    expect(boot()).not.toMatch(/git clone[^|]*"\$\{?REPO\}?"/);
  });

  it('只是薄引导：把活儿交给 qy.sh，不自己实现安装逻辑', () => {
    const s = boot();
    expect(s).toContain('exec bash "$TARGET" "$@"');
    expect(s).not.toContain('docker compose');
    expect(s.length).toBeLessThan(2500);
  });

  itBash('拿不到代码时给出可读的错误，而不是静默退出', () => {
    // 用一个干净的目录，避免命中「已有仓库」那条分支
    const s = boot()
      .replace(/^REPO=.*$/m, 'REPO=kejiland/definitely-not-a-real-repo-xyz')
      .replace(/^APP_DIR=.*$/m, 'APP_DIR=/tmp/qy-boot-test');
    const out = runBash(s, '');
    expect(out).toContain('✗');
    expect(out).toMatch(/下载失败/);
  });
});
describe('curl | bash 的 stdin 问题（用户在 Linux 上实测踩到）', () => {
  itBash('stdin 是脚本文本而非终端时，报可读错误而不是静默退出', () => {
    // 模拟 curl ... | bash：stdin 立刻 EOF
    const out = runBash(src(), '');
    expect(out).toContain('读不到终端');
    expect(out).toContain('install.sh');
    // 关键：不能再出现「请选择」直接接「按回车继续」那种静默退出
    expect(out).not.toMatch(/请选择 \[1\]：[\s\S]{0,40}按回车继续/);
  });

  itBash('不会偷偷 exec </dev/tty 去抢终端（那会挂死喂输入的用法）', () => {
    const s = src();
    expect(s).not.toMatch(/exec\s+0<\/dev\/tty/);
  });

  itBash('喂数字依然能正常走完菜单并退出', () => {
    const out = runBash(src(), '0\n');
    expect(out).toContain('轻语博客 · 部署助手');
    expect(out).not.toContain('读不到终端');
  });

  it('引导脚本把真实终端显式交给 qy.sh', () => {
    const s = readLf(path.resolve('deploy/install.sh'));
    expect(s).toContain('exec bash "$TARGET" "$@" < /dev/tty');
    // 没有终端时也要说清楚，而不是让 qy.sh 读到 EOF 静默退出
    expect(s).toMatch(/当前会话没有可交互的终端/);
  });
});
describe('预构建镜像（GHCR）默认路径', () => {
  const compose = () => readLf(path.resolve('compose.yaml'));
  const override = () => readLf(path.resolve('compose.build.yaml'));

  it('compose.yaml 默认用 GHCR 镜像，且不再自带 build 段', () => {
    const c = compose();
    expect(c).toContain('ghcr.io/kejiland/qingyu-universal:latest');
    // build 段挪到覆盖文件里，否则 compose 会优先现场编译，又变回慢路径
    const app = c.slice(c.indexOf('\n  app:'), c.indexOf('\n  postgres:'));
    expect(app).not.toContain('build:');
  });

  it('源码构建能力没丢，挪到了 compose.build.yaml', () => {
    const o = override();
    expect(o).toContain('dockerfile: deploy/Dockerfile');
    expect(o).toMatch(/^\s{4}build:/m);
  });

  it('安装时是数字选择：预构建镜像 or 源码构建', () => {
    const body = funcBody(src(), 'do_install');
    expect(body).toContain('pick "镜像从哪来？"');
    expect(body).toContain('ghcr.io 上的成品');
  });

  it('默认走 pull，源码模式才 --build', () => {
    const body = funcBody(src(), 'up');
    expect(body).toMatch(/docker compose .*pull app/);
    expect(body).toContain('compose.build.yaml up -d --build');
    expect(body).toMatch(/use_source_build/);
  });

  it('.env 里记录构建方式，默认 0（预构建）', () => {
    const body = funcBody(src(), 'write_env');
    expect(body).toContain('QINGYU_SOURCE_BUILD=$srcbuild');
    expect(body).toContain('QINGYU_IMAGE=ghcr.io/kejiland/qingyu-universal:latest');
    // 只有显式选 2 才置 1，其余一律 0
    const install = funcBody(src(), 'do_install');
    expect(install).toContain('[ "$srcbuild" = "2" ] || srcbuild=0');
  });

  it('拉不到镜像时明确报错，并给出改用源码构建的办法', () => {
    const body = funcBody(src(), 'up');
    expect(body).toContain('拉取预构建镜像失败');
    expect(body).toContain('QINGYU_SOURCE_BUILD');
  });

  it('更新和回滚也走 up()，不再硬编码 --build', () => {
    const s = src();
    for (const fn of ['do_update', 'do_rollback', 'do_domain']) {
      const body = funcBody(s, fn);
      expect(body).not.toMatch(/docker compose up -d --build/);
    }
    expect(funcBody(src(), 'do_update')).toMatch(/^\s+up\s*$/m);
  });
});
describe('已安装检测与卸载', () => {
  const qy = () => src();

  it('主菜单里有第 10 项卸载，且读数上限放宽到 10', () => {
    expect(funcBody(qy(), 'menu')).toContain('10) do_uninstall');
    expect(funcBody(qy(), 'menu_read')).toContain('-le 10');
  });

  it('菜单顶部会显示是否已安装', () => {
    const m = funcBody(qy(), 'menu');
    expect(m).toMatch(/if installed; then[\s\S]{0,200}已安装/);
  });

  it('已安装时点 1 不会闷头重装，而是先问要不要重装', () => {
    const body = funcBody(qy(), 'do_install');
    expect(body).toContain('检测到已经安装过了');
    expect(body).toContain('pick "已经装过了，还要再跑一遍安装吗？"');
    // 卸载路径必须重新确认目录真的没了
    expect(body).toContain('installed && { err "卸载后目录还在');
  });

  it('卸载分两档：保留数据 / 连数据一起删', () => {
    const body = funcBody(qy(), 'do_uninstall');
    expect(body).toContain('只卸载程序，保留数据');
    expect(body).toContain('完全卸载，连数据一起删');
    // 保留数据：不能带 --volumes
    // 从 case 分支切，别从 pick 的选项文案切（那里也出现了同样的字样）
    const branches = body.slice(body.indexOf('\n    1)', body.indexOf('要卸载到什么程度')));
    const keep = branches.slice(0, branches.indexOf('\n    2)'));
    const wipe = branches.slice(branches.indexOf('\n    2)'), branches.indexOf('\n    3)'));
    expect(keep).not.toContain('--volumes');
    expect(keep).toContain('rm -rf "$INSTALL_DIR"');
    expect(wipe).toContain('down --volumes --remove-orphans');
  });

  it('彻底删数据必须手输「删除」两个字才继续', () => {
    const body = funcBody(qy(), 'do_uninstall');
    const wipe = body.slice(body.indexOf('\n    2)', body.indexOf('要卸载到什么程度')), body.indexOf('\n    3)'));
    expect(wipe).toMatch(/\[ "\$word" = "删除" \] \|\| \{ ok "没对上，已取消/);
    expect(wipe.indexOf('确认请输入')).toBeLessThan(wipe.indexOf('--volumes'));
  });

  it('还没装时卸载是安全的空操作', () => {
    const body = funcBody(qy(), 'do_uninstall');
    expect(body).toMatch(/if ! installed; then[\s\S]{0,200}没什么可卸载的/);
  });

  itBash('没安装过就跑卸载，不会误删东西', () => {
    // 指定一个肯定没装过的目录，别被本机残留的 /tmp/qy-fake 干扰
    const out = runBash('export QINGYU_DIR=' + FRESH + '\n' + qy(), '', ['uninstall']);
    expect(out).toContain('还没安装过，没什么可卸载的');
    expect(out).not.toContain('rm -rf');
  });

  it('uninstall 也能当子命令直接跑', () => {
    expect(funcBody(qy(), 'main')).toContain('uninstall|remove) do_uninstall');
  });
});
describe('--profile 必须放在子命令前面（用户实测踩到 unknown flag）', () => {
  it('up() 把 profile 展开到 docker compose 的子命令之前', () => {
    const body = funcBody(src(), 'up');
    // 形如 docker compose "${prof[@]}" ... up -d，不能是 up -d --profile x
    expect(body).toMatch(/docker compose "\$\{prof\[@\]\}"[^\n]*\bup -d/);
    expect(body).not.toMatch(/up -d --profile/);
    expect(body).not.toMatch(/up -d "\$\{@\}".*--profile/);
  });

  it('do_domain 用 up domain 传 profile，而不是把 --profile 塞进 up()', () => {
    const body = funcBody(src(), 'set_domain');
    expect(body).toContain('up domain');
    // --profile 只能出现在子命令前面（如 `dc --profile domain stop caddy`），
    // 绝不能跟在 up 后面
    expect(body).not.toMatch(/up[^\n]*--profile/);
  });

  it('解除域名会先停掉 Caddy，否则它一直占着 80/443', () => {
    const body = funcBody(src(), 'unset_domain');
    const branches = body;
    expect(branches).toContain('stop caddy');
    // 停 Caddy 必须发生在重新 up 之前
    expect(branches.indexOf('stop caddy')).toBeLessThan(branches.lastIndexOf('\n  up'));
  });

  it('域名输入会洗成裸域名并校验点号', () => {
    const body = funcBody(src(), 'set_domain');
    expect(body).toContain('normalize_domain');
    expect(body).toContain('看起来不像域名');
  });

  it('给出 Cloudflare 的具体提示（先灰云签证书，SSL 模式选完全）', () => {
    expect(funcBody(src(), 'set_domain')).toContain('仅 DNS');
  });
});
describe('更换域名', () => {
  const qy = () => src();

  it('菜单按当前状态给不同选项：有域名才出现「更换」', () => {
    const body = funcBody(qy(), 'do_domain');
    // 两条分支各自的 pick
    const branches = body.split('c=$(pick "域名与 HTTPS"');
    expect(branches.length).toBe(3); // 头部 + 有域名 + 没域名
    expect(branches[1]).toContain('更换主域名');
    expect(branches[1]).toContain('set_domain change');
    expect(branches[1]).not.toContain('设置主域名（自动签');
    expect(branches[2]).toContain('设置主域名（自动签');
    expect(branches[2]).not.toContain('更换主域名');
  });

  it('菜单顶部先报当前域名状态', () => {
    const body = funcBody(qy(), 'do_domain');
    expect(body).toContain('read_env SITE_DOMAIN');
    expect(body).toContain('没有域名，用 IP + 端口访问');
  });

  it('set_domain 支持 first 和 change 两种模式', () => {
    const body = funcBody(qy(), 'set_domain');
    expect(body).toContain('mode="$1"');
    expect(body).toContain('[ "$mode" = "change" ]');
    // 更换时会明确告知旧域名要作废、期间会短暂中断
    expect(body).toContain('先解除');
    expect(body).toContain('短暂打不开');
  });

  it('没配域名时误选「更换」会引导去设置，而不是报错', () => {
    const body = funcBody(qy(), 'set_domain');
    expect(body).toMatch(/if \[ -z "\$old" \][\s\S]{0,200}直接走「设置主域名」/);
  });

  it('新域名和当前一样时直接说不用改，不重启容器', () => {
    const body = funcBody(qy(), 'set_domain');
    expect(body).toMatch(/\[ "\$d" = "\$old" \][\s\S]{0,120}不用改/);
    expect(body.indexOf('不用改')).toBeLessThan(body.indexOf('need_root'));
  });

  it('输入框默认填当前域名，回车即保持不变', () => {
    const body = funcBody(qy(), 'set_domain');
    expect(body).toContain('ask "新域名（例如 blog.example.com）" "$old" d');
  });

  it('域名清洗独立成函数：去协议、去路径、去端口、去尾点、转小写', () => {
    const body = funcBody(qy(), 'normalize_domain');
    expect(body).toContain('${d#*://}');
    expect(body).toContain('${d%%/*}');
    expect(body).toContain('${d%%:*}');
    expect(body).toContain('${d%.}');
    expect(body).toContain('${d,,}');
    // set_domain 必须走这个函数，不能各自洗一遍
    expect(funcBody(qy(), 'set_domain')).toContain('normalize_domain "$d"');
  });

  it('解除域名是独立函数，且仍在停止 Caddy 之后才重启', () => {
    const body = funcBody(qy(), 'unset_domain');
    expect(body).toContain('stop caddy');
    expect(body.indexOf('stop caddy')).toBeLessThan(body.lastIndexOf('\n  up'));
    // 注意：函数名 unset_domain 本身就含子串 set_domain，只能查具体调用
    expect(body).not.toMatch(/set_domain (first|change)/);
  });

  it('两条路径都不会把 --profile 放到子命令后面', () => {
    for (const fn of ['set_domain', 'unset_domain']) {
      expect(funcBody(qy(), fn)).not.toMatch(/up[^\n]*--profile/);
    }
    expect(funcBody(qy(), 'set_domain')).toContain('up domain');
  });

  it('更换域名 = 先解除旧域名，再配置新域名', () => {
    const body = funcBody(qy(), 'set_domain');
    const unsetAt = body.indexOf('unset_domain internal');
    const setAt = body.indexOf('SITE_DOMAIN=$d');
    expect(unsetAt).toBeGreaterThan(-1);
    // 顺序不能反：先解除，再写入新域名
    expect(unsetAt).toBeLessThan(setAt);
    // 且新域名和旧域名相同时不该白折腾一场
    expect(body.indexOf('不用改')).toBeLessThan(unsetAt);
  });

  it('内部调用解除域名时沿用当前端口，不重新问用户', () => {
    const body = funcBody(qy(), 'unset_domain');
    expect(body).toContain('[ "$mode" = "internal" ]');
    expect(body).toContain('read_env APP_BIND');
    expect(body).toContain('沿用当前端口');
    // 端口仍然要校验
    expect(body).toContain('端口必须是数字');
  });
});
