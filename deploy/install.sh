#!/usr/bin/env bash
# ============================================================
# 轻语博客 · 自托管通用版 —— 一键部署脚本
# ------------------------------------------------------------
# 用法：
#   从仓库运行：
#     ./deploy/install.sh --domain blog.example.com
#   远程一键（仓库发布后）：
#     curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash -s -- --domain blog.example.com
#
# 常用子命令：
#   install（默认） | update | check-update | upgrade | rollback
#   backup | restore <file> | logs | status | info | sysinfo | speedtest | tune | clean | doctor
#   start | stop | restart | uninstall | autobackup | migrate
#
# 设计原则：可重复执行；已存在的 .env 与数据库绝不覆盖。
# ============================================================
set -euo pipefail

REPO="${QINGYU_REPO:-kejiland/qingyu-universal}"
REF="${QINGYU_REF:-main}"
INSTALL_DIR="${QINGYU_DIR:-/opt/qingyu-universal}"
DOMAIN="${SITE_DOMAIN:-}"
IP_ADDR=""
APP_PORT=""
ASSUME_YES=0
EMAIL="${ACME_EMAIL:-}"
# 预构建镜像：发布新版本时改这一行就够了（脚本里所有提示都引用它）
PREBUILT_IMAGE="${QINGYU_PREBUILT_IMAGE:-ghcr.io/kejiland/qingyu-universal:latest}"
IMAGE="${QINGYU_IMAGE:-}"
# 选了 --image 但没给镜像名 → 用上面这个默认的预构建镜像（等价于 --prebuilt）
IMAGE_SET=0
# 低内存构建模式：auto（按内存自动判断，默认） / on / off（等价于 --lowmem / --no-lowmem）
LOWMEM="${QINGYU_LOWMEM:-auto}"
# 国内网络加速（--mirror）：GitHub 代码 / Docker Hub 镜像 / npm 依赖。
# 留空 = 先看 .env 里是否记着上次的选择，保证升级时自动沿用。
MIRROR="${QINGYU_MIRROR:-}"
GITHUB_PROXY="${QINGYU_GITHUB_PROXY:-}"
NPM_REGISTRY_OPT="${QINGYU_NPM_REGISTRY:-}"
# 定时备份（autobackup）：--keep 保留最近几份，--at 每天几点跑，--off 关闭
KEEP_N=7
AT_TIME="03:30"
AUTOBACKUP_OFF=0
# migrate：把整站打成一个 tar.gz（含 .env + 数据卷），用于换服务器
BUNDLE_OUT=""
PURGE=0
# ---- 安装向导 / 配置档 / 演练 / 断点续跑 ----
# tune：--apply 直接调优 / --restore 撤销。不带参数则先看状态再询问
TUNE_APPLY=0
TUNE_RESTORE=0
DRY_RUN=0            # --dry-run：只打印将要做什么，不实际改动系统
WIZARD_FORCE=0       # --wizard：即使已有参数也强制走一次问答向导
NO_WIZARD=1          # 默认零配置不提问；--wizard 才走问答向导（--no-wizard 保留为兼容写法）
SKIP_PREFLIGHT=0     # --skip-preflight：跳过起飞前检查
SKIP_DOCTOR=0        # --no-doctor：安装后不做自动体检
RESET_STATE=0        # --reset：清除断点续跑进度，从头执行
CONFIG_FILE=""       # --config <文件>：从配置档读取选项
SAVE_CONFIG=""       # --save-config <文件>：把本次选择写成配置档
TIMEZONE=""          # --timezone <Asia/Shanghai>：设定系统时区（定时备份按它走）
SMTP_HOST_OPT=""     # --smtp-*：邮件通知（留空 = 不配置，之后可在后台「设置 → 邮件」里填）
SMTP_PORT_OPT=""
SMTP_USER_OPT=""
SMTP_PASS_OPT=""
SMTP_FROM_OPT=""
ADMIN_EMAIL_OPT=""   # --admin-email：管理员邮箱（通知 / 找回密码用）
DATA_DIR_OPT=""      # --data-dir：数据目录（上传、SQLite、备份都放这儿）
LOG_LEVEL_OPT=""     # --log-level：日志级别 error|warn|info|debug
REDIS_OPT=""         # --redis <连接串>：Redis / Valkey（留空 = 用数据库 KV）
AI_BASE_OPT=""       # --ai-base-url / --ai-key / --ai-model：AI 摘要（留空 = 之后在后台配）
AI_KEY_OPT=""
AI_MODEL_OPT=""
S3_ENDPOINT_OPT=""   # --s3-*：S3 / R2 兼容对象存储（留空 = 存本地磁盘）
S3_REGION_OPT=""
S3_KEY_ID_OPT=""
S3_SECRET_OPT=""
S3_BUCKET_OPT=""
S3_PUBLIC_BASE_OPT=""
SHORTCUT_KEY="k"    # 快捷键：装完后在终端里敲这个字母就能打开运维菜单（大小写都行）
SHORTCUT_OFF=0       # --no-shortcut：不要写快捷键
NO_AUTOBACKUP=0      # --no-autobackup：不安装定时备份
WIZ_BACKUP=0         # 向导里选了「要自动备份」
WIZARD_DONE=0        # 本次已经走过向导（用于让 interact_* 不再重复提问）
# 向导 / 版本对比的中间状态（脚本开了 set -u，先用空值占位）
WIZ_MODE=""          # domain | port
WIZ_ACT="next"       # 向导每步执行后的去向：next / back / jump:N
WIZ_IP=""            # 探测到的公网 IP
WIZ_PORTS=1          # 80/443 是否空闲（1=空闲）
WIZ_DISTRO=""        # 系统名称
WIZ_ARCH=""          # CPU 架构
WIZ_DISK=""          # 可用磁盘 MB
UPGRADE_FROM=""      # 升级前的版本（用于升级后对比）
# update / check-update 的比对结果（脚本开了 set -u，先占位）
UPDATE_CUR=""        # 本地当前版本（完整 SHA）
UPDATE_REMOTE=""     # 远端最新版本（完整 SHA）
UPDATE_STATE=""      # latest | behind | unknown
CHECK_ONLY=0         # --check：只查有没有新版，不做任何改动

# ---------- 终端排版原语 ----------
# 一套 UI 元素贯穿全脚本，避免各处手工拼 ╭─╮ 盒子导致风格不统一。
# 非终端（重定向到文件、CI）或设了 NO_COLOR 时自动去掉颜色，只留结构。
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_RESET=$'\033[0m'; C_B=$'\033[1m'; C_DIM=$'\033[2m'
  C_CYAN=$'\033[1;36m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'; C_BLUE=$'\033[1;34m'; C_GREY=$'\033[90m'
else
  C_RESET=''; C_B=''; C_DIM=''
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''; C_GREY=''
fi
# ---------- 载入功能模块 ----------
# 所有具体功能都放在 lib/ 下按职责拆分，这里只负责按顺序载入，
# 保证「脚本执行到任何一行时，用到的函数都已经定义」。
_qy_self="${BASH_SOURCE[0]:-$0}"
_qy_dir="$(cd -- "$(dirname -- "$_qy_self")" >/dev/null 2>&1 && pwd)"
_qy_lib="$_qy_dir/lib"
if [ ! -d "$_qy_lib" ]; then
  # 兼容 curl ... | bash 的用法：脚本本身没有旁边的 lib/，先取一份完整仓库再继续。
  echo "未找到模块目录，正在获取完整部署包……" >&2
  _qy_tmp="$(mktemp -d)" || { echo "无法创建临时目录" >&2; exit 1; }
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "${QINGYU_REPO:-kejiland/qingyu-universal}" "$_qy_tmp/repo" >&2
  else
    echo "需要 git 才能通过管道方式安装；也可以先下载仓库再运行 deploy/install.sh" >&2
    exit 1
  fi
  exec bash "$_qy_tmp/repo/deploy/install.sh" "$@"
fi
for _qy_m in common.sh detect.sh docker.sh config.sh security.sh source.sh access.sh version.sh upgrade.sh installer.sh backup.sh service.sh doctor.sh extras.sh menu.sh; do
  # shellcheck source=/dev/null
  # 列表里写的就是完整文件名（含 .sh），这里不要再拼一次后缀
  . "$_qy_lib/$_qy_m"
done
unset _qy_self _qy_dir _qy_lib _qy_m _qy_tmp

# ---------- 以下为入口逻辑（参数解析、执行入口） ----------
if ui_utf8; then
  G_FULL="█"; G_EMPTY="░"; G_OK="✓"; G_WARN="!"; G_FAIL="x"; G_SECT="▌"; G_RULE="─"
else
  G_FULL="#"; G_EMPTY="-"; G_OK="v"; G_WARN="!"; G_FAIL="x"; G_SECT=">"; G_RULE="-"
fi
# 终端太窄（<72 列）时自动去掉边框，避免折行糊成一片
UI_W=72
[ -t 1 ] && UI_W="$( (tput cols 2>/dev/null || echo 72) )"
[ "$UI_W" -lt 60 ] 2>/dev/null && UI_W=60
[ "$UI_W" -gt 78 ] 2>/dev/null && UI_W=78

# 安装过程分步显示：让第一次用脚本的人知道「现在到哪一步了、还剩几步」。
STEP_NO=0
STEP_TOTAL=0

# ---------- 参数解析 ----------
# 记录原始参数，后续如果需要提权重启（如 doctor）可以照原样重跑
ORIG_ARGS=("$@")
COMMAND="install"
# 用户是否显式写了子命令（没写 + 已部署过 + 交互终端 → 弹数字菜单）
COMMAND_SET=0
ARGS=()
# 用户是否显式传了 --ref（REF 本身有默认值，不记一笔区分不出来）
REF_SET="${REF_SET:-0}"
# 用户是否显式传了 --dir（决定配置档里的 DIR 能不能覆盖默认值）
DIR_SET=0
# 数据库选择（脚本开了 set -u，未设置的变量必须先给默认值）
DB_KIND="${DB_KIND:-}"
# 子命令后面跟的额外参数（如 shortcut x / shortcut --remove）
SUBCMD_ARGS=""
DATABASE_URL_OPT="${DATABASE_URL_OPT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|backup|restore|logs|status|info|sysinfo|speedtest|tune|clean|start|stop|restart|rollback|uninstall|help) COMMAND="$1"; COMMAND_SET=1 ;;
    doctor)                 COMMAND="$1"; COMMAND_SET=1 ;;
  domain)                 COMMAND="$1"; COMMAND_SET=1
                                 shift; SUBCMD_ARGS="$*"; break ;;
    update|check-update)    COMMAND="$1"; COMMAND_SET=1 ;;
    autobackup|migrate)     COMMAND="$1"; COMMAND_SET=1 ;;
    shortcut|domain)       COMMAND="$1"; COMMAND_SET=1
                                 shift; SUBCMD_ARGS="$*"; break ;;
    --domain)   DOMAIN="${2:-}"; shift ;;
    --email)    EMAIL="${2:-}"; shift ;;
    --dir)      INSTALL_DIR="${2:-}"; DIR_SET=1; shift ;;
    --ref)      REF="${2:-}"; REF_SET=1; shift ;;
    --repo)     REPO="${2:-}"; shift ;;
    --port)     APP_PORT="${2:-}"; shift ;;
    --db)       DB_KIND="${2:-}"; shift ;;
    --database-url) DATABASE_URL_OPT="${2:-}"; shift ;;
    -y|--yes)   ASSUME_YES=1 ;;
    --ip)       IP_ADDR="${2:-}"; shift ;;
    --image)
      # 后面没跟镜像名、或跟的是别的选项 → 用脚本内置的默认预构建镜像
      if [ -z "${2:-}" ] || [ "${2#-}" != "$2" ]; then
        IMAGE="$PREBUILT_IMAGE"; IMAGE_SET=1
      else
        IMAGE="$2"; IMAGE_SET=1; shift
      fi ;;
    --prebuilt) IMAGE="$PREBUILT_IMAGE"; IMAGE_SET=1 ;;
    --local-build) IMAGE=""; IMAGE_SET=1 ;;
    --lowmem)    LOWMEM=on ;;
    --no-lowmem) LOWMEM=off ;;
    --mirror)         MIRROR=1 ;;
    --no-mirror)      MIRROR=0 ;;
    --github-proxy)   GITHUB_PROXY="${2:-}"; MIRROR=1; shift ;;
    --keep)     KEEP_N="${2:-7}"; shift ;;
    --at)       AT_TIME="${2:-03:30}"; shift ;;
    --off)      AUTOBACKUP_OFF=1 ;;
    --out)      BUNDLE_OUT="${2:-}"; shift ;;
    --purge)    PURGE=1 ;;
    # ---- 向导 / 配置档 / 演练 / 断点续跑 ----
    --config)        CONFIG_FILE="${2:-}"; shift ;;
    --save-config)   SAVE_CONFIG="${2:-}"; shift ;;
    --timezone)      TIMEZONE="${2:-}"; shift ;;
    --smtp-host)     SMTP_HOST_OPT="${2:-}"; shift ;;
    --smtp-port)     SMTP_PORT_OPT="${2:-}"; shift ;;
    --smtp-user)     SMTP_USER_OPT="${2:-}"; shift ;;
    --smtp-pass)     SMTP_PASS_OPT="${2:-}"; shift ;;
    --smtp-from)     SMTP_FROM_OPT="${2:-}"; shift ;;
    --wizard)        WIZARD_FORCE=1 ;;
    --no-wizard)     NO_WIZARD=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    --apply)         TUNE_APPLY=1 ;;
    --restore)       TUNE_RESTORE=1 ;;
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --no-doctor)     SKIP_DOCTOR=1 ;;
    --reset|--fresh) RESET_STATE=1 ;;
    --key)      SHORTCUT_KEY="${2:-k}"; shift ;;
    --no-shortcut) SHORTCUT_OFF=1 ;;
    --check)          CHECK_ONLY=1 ;;
    --all)            UPDATE_ALL=1 ;;
    --no-autobackup) NO_AUTOBACKUP=1 ;;
    # ---- 站点与运行参数（都能写进配置档，一键复现）----
    --admin-email)  ADMIN_EMAIL_OPT="${2:-}"; shift ;;
    --data-dir)     DATA_DIR_OPT="${2:-}"; DIR_SET=1; shift ;;
    --log-level)    LOG_LEVEL_OPT="${2:-}"; shift ;;
    --redis)        REDIS_OPT="${2:-}"; shift ;;
    --ai-base-url)  AI_BASE_OPT="${2:-}"; shift ;;
    --ai-key)       AI_KEY_OPT="${2:-}"; shift ;;
    --ai-model)     AI_MODEL_OPT="${2:-}"; shift ;;
    --s3-endpoint)  S3_ENDPOINT_OPT="${2:-}"; shift ;;
    --s3-region)    S3_REGION_OPT="${2:-}"; shift ;;
    --s3-key-id)    S3_KEY_ID_OPT="${2:-}"; shift ;;
    --s3-secret)    S3_SECRET_OPT="${2:-}"; shift ;;
    --s3-bucket)    S3_BUCKET_OPT="${2:-}"; shift ;;
    --s3-public-base) S3_PUBLIC_BASE_OPT="${2:-}"; shift ;;
    -h|--help)  COMMAND="help" ;;
    *)          ARGS+=("$1") ;;
  esac
  shift
done
[ -n "$CONFIG_FILE" ] && load_config_file "$CONFIG_FILE"

# ---------- 代码获取 ----------
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd || true)"

# ============================================================
# 安装向导：一次问答走完全流程
# ============================================================
# 面向第一次用的人：先探测环境，再用大白话问几个问题，每个都给好推荐答案，
# 直接回车就是推荐方案；输入 b 回到上一题，输入 q 放弃。
# 所有问题只在「全新安装 + 能交互」时出现，CI / curl|bash / -y 一律不打扰。
WIZ_STEPS=(access domain db backup mail extra confirm)

# 低内存时的 Node 堆上限：压到 384 MB，让 V8 更早回收而不是无限增长到被内核杀掉。
LOWMEM_NODE_OPTIONS="--max-old-space-size=384"

# ----------------------------------------------------------
# 「这次远端更新跟博客本身有没有关系」
#
# 远端每次提交都来自本仓库，所以不存在混进别的项目的问题；真正需要判断的是
# 另一件事：有些提交只动了 README、tests、CI 配置 —— 它们对**正在运行的站点**
# 没有任何影响。按「与博客无关就不必更新」的要求，这类提交不提示、也不执行，
# 免得为了改个错别字去备份 + 重建 + 重启一次服务。
#
# 判定方式：看本地 → 远端之间实际改了哪些文件。
#   返回 0 = 有影响站点运行的改动，该更新
#   返回 1 = 只有文档 / 测试 / CI 改动，可以跳过
#   返回 2 = 判断不了（压缩包安装、没有 git 历史等）→ 一律按「该更新」处理，绝不误杀
# ----------------------------------------------------------

# 与站点运行无关的路径：文档、测试、CI、编辑器配置、许可证
UPDATE_DOCONLY_PATTERNS='(^|/)(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT)([^/]*)$|^docs/|^tests?/|^test/|^\.github/|^\.vscode/|^\.idea/|^\.gitattributes$|^\.gitignore$|^tmp/|\.(md|markdown|rst|txt)$'

# ---------- 服务器调优（可选） ----------
# 借鉴 kejilion 的「内核优化」，但**刻意收窄范围**：只调网络队列和内存策略，
# 绝不碰 SSH 配置、端口、防火墙 —— 部署脚本擅自改登录方式，最容易把自己锁在门外。
# 也不是安装流程的一部分，必须显式执行 tune 才会生效。

TUNE_CONF="/etc/sysctl.d/99-qingyu-tune.conf"
# ---------- 一键体检 ----------
# 用法：./deploy/install.sh doctor
# 把「网站打不开 / 图片传不上去 / 评论报错」这类问题拆成一组可判定的小项，
# 每项给 ✅/⚠️/❌ 加一句怎么修，最后汇总。全程只读，不改任何配置。
DOCTOR_OK=0
DOCTOR_WARN=0
DOCTOR_FAIL=0
# ------------------------------------------------------------
# 快捷键：在终端里敲一个字母就直接打开运维菜单
# ------------------------------------------------------------
# 装完之后不用记脚本路径、不用 cd，敲 k 就能打开菜单。
# 写入 ~/.bashrc（bash）和 ~/.zshrc（zsh，若存在），并给大小写两个别名。
# 之所以用 alias 而不是软链接：脚本要能跟着安装目录走，且 alias 更好清理。
SHORTCUT_MARK_BEGIN="# >>> qingyu 快捷键（deploy/install.sh）>>>"
SHORTCUT_MARK_END="# <<< qingyu 快捷键 <<<"

# ----------------------------------------------------------
# 全局入口：装一个 qingyu 命令到 PATH 里。
# 目的：用户在任何目录（包括 ~ ）直接敲 qingyu 就能打开数字菜单，
# 不用记安装路径、不用先 cd、不用敲 ./deploy/install.sh。
# 用独立的小脚本而不是软链接：软链接在部分精简系统上会被
# 「按脚本真实路径找安装目录」的逻辑坑到，写死绝对路径最稳。
# ----------------------------------------------------------
GLOBAL_LINK_DIRS="/usr/local/bin /usr/bin"

# 出错时自动给出「失败原因 + 可执行解法」，而不是只留一行红字
if [ -z "${QINGYU_NO_ERR_HELP:-}" ]; then
  trap 'on_error $? "$LINENO" "$BASH_COMMAND"' ERR
fi

maybe_show_menu

case "$COMMAND" in
  help) usage ;;
  install) cmd_install ;;
  upgrade) cmd_upgrade ;;
  update)  cmd_update ;;
  check-update) if [ "$CHECK_ONLY" = "1" ]; then cmd_update; else cmd_check_update; fi ;;
  backup)    cmd_backup; prune_backups "$KEEP_N" ;;
  autobackup) cmd_autobackup ;;
  shortcut)   cmd_shortcut ;;
  migrate)   cmd_migrate ;;
  restore) cmd_restore ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  info) cmd_info ;;
  sysinfo) cmd_sysinfo ;;
  speedtest) cmd_speedtest ;;
  tune) cmd_tune ;;
  clean) cmd_clean ;;
  doctor) cmd_doctor ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  rollback) cmd_rollback ;;
  domain)   cmd_domain ;;
  uninstall) cmd_uninstall ;;
  *) usage; die "未知命令：$COMMAND" ;;
esac
