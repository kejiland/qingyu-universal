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
#     install（默认） | upgrade | backup | restore <file> | logs | status | info
#     start | stop | restart | rollback | uninstall
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
IMAGE="${QINGYU_IMAGE:-}"
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
DRY_RUN=0            # --dry-run：只打印将要做什么，不实际改动系统
WIZARD_FORCE=0       # --wizard：即使已有参数也强制走一次问答向导
NO_WIZARD=0          # --no-wizard：全新安装也不提问，全用默认值
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

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# 安装过程分步显示：让第一次用脚本的人知道「现在到哪一步了、还剩几步」。
STEP_NO=0
STEP_TOTAL=0
step_begin() {
  [ -n "$STEP_TOTAL" ] || return 0
  STEP_NO=$((STEP_NO + 1))
  printf '\n\033[1;35m┌─ 第 %d/%d 步\033[0m  \033[1m%s\033[0m\n' "$STEP_NO" "$STEP_TOTAL" "$*"
  STEP_NAME="$*"
}
step_end() {
  [ -n "$STEP_TOTAL" ] || return 0
  printf '\033[1;35m└─ 第 %d/%d 步完成\033[0m\n' "$STEP_NO" "$STEP_TOTAL"
}

on_error() {
  local code="${1:-1}" line="${2:-?}" cmd="${3:-}"
  trap - ERR
  echo
  warn "这一步没能完成（退出码 $code）"
  [ -n "$STEP_NAME" ] && warn "当前步骤：$STEP_NAME"
  [ -n "$line" ] && warn "出错位置：install.sh 第 $line 行"
  echo
  echo "  先试这几招（按顺序，成功了就继续）："
  echo
  case "$cmd" in
    *docker*compose*|*"docker compose"*)
      warn "看起来是容器相关命令失败"
      echo "    1) $0 doctor              # 一键体检，看看 Docker / 容器 / 端口哪一项坏了"
      echo "    2) $0 logs                # 看应用自己在报什么"
      echo "    3) docker ps -a           # 确认容器状态"
      ;;
    *pull*|*curl*|*wget*|*fetch*|*clone*|*npm*)
      warn "看起来是「拉代码 / 下载镜像」时网络不通"
      echo "    1) $0 install --mirror    # 国内网络加速（重新走一遍安装即可）"
      echo "    2) curl -I https://ghcr.io  # 测一下能不能连上镜像仓库"
      echo "    3) $0 --help              # 查看全部参数"
      ;;
    *apt*|*yum*|*dnf*|*apk*|*systemctl*)
      warn "看起来是系统包管理器 / 服务没能正常工作"
      echo "    1) 换国内镜像源后重试：sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list"
      echo "    2) 确认网络：ping -c2 mirrors.aliyun.com"
      ;;
    *mkdir*|*mount*|*"touch"*|*"cp "*)
      warn "看起来是文件写入被拒绝"
      echo "    1) 用 root 运行本脚本（sudo bash deploy/install.sh install）"
      echo "    2) 确认磁盘没满：df -h /"
      ;;
    *chmod*|*"chown"*)
      warn "看起来是权限不足"
      echo "    1) 用 root 运行：sudo bash deploy/install.sh install"
      ;;
    *)
      warn "通用排查"
      echo "    1) $0 doctor              # 一键体检"
      echo "    2) $0 logs                # 看详细日志"
      echo "    3) 上一条命令：$cmd"
      ;;
  esac
  echo
  warn "配置和数据都还在（不会因为这次失败被清空），修好后重新执行同一条命令即可"
  if [ "$COMMAND" = "install" ]; then
    echo
    echo "  不用从头再来 —— 已完成并记录下来的步骤会自动跳过"
    echo "  （最慢的两步：装 Docker、构建镜像，重跑时都不会重复做）"
    echo "  想强制从头执行： $0 install --reset"
  fi
  echo
  exit "$code"
}


have() { command -v "$1" >/dev/null 2>&1; }

# 脚本依赖 curl 做三件事：安装 Docker、下载源码包、健康检查。
# 最小化的 Debian/Ubuntu 云镜像默认不带 curl，必须先把这一步补上，
# 否则 `curl ... | sh` 会静默失败（管道里的 sh 收到空输入仍返回 0）。
ensure_curl() {
  have curl && return 0
  if have wget; then
    # 有 wget 没有 curl 时用兼容函数兜底
    curl() {
      local out="" url=""
      while [ $# -gt 0 ]; do
        case "$1" in
          -o) out="$2"; shift 2 ;;
          -fsSL|-fsS|-sS|-fs|-fsS) shift ;;
          *) url="$1"; shift ;;
        esac
      done
      if [ -n "$out" ]; then wget -q -O "$out" "$url"; else wget -q -O - "$url"; fi
    }
    export -f curl
    log "未检测到 curl，已用 wget 兼容层替代"
    return 0
  fi
  log "未检测到 curl，正在安装…"
  case "$(detect_distro)" in
    alpine) $SUDO apk add --no-cache curl ;;
    debian|ubuntu|raspbian) $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl ;;
    fedora|rhel|centos|rocky|almalinux) $SUDO dnf install -y -q curl ;;
    arch|manjaro) $SUDO pacman -Sy --noconfirm curl ;;
    *) die "请先安装 curl 或 wget 后重试" ;;
  esac
  have curl || die "curl 安装失败，请手动安装后重试"
}

# Git 用于「新装时留下版本历史」和「一键回滚」。
# 它不是硬依赖：装不上就退回压缩包方式，回滚走下载历史版本的路，功能不缺失。
ensure_git() {
  have git && return 0
  log "未检测到 git，正在安装…（用于版本管理与一键回滚）"
  case "$(detect_distro)" in
    alpine) $SUDO apk add --no-cache git ;;
    debian|ubuntu|raspbian) $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git ;;
    fedora|rhel|centos|rocky|almalinux) $SUDO dnf install -y -q git ;;
    arch|manjaro) $SUDO pacman -Sy --noconfirm git ;;
    *) warn "当前系统无法自动安装 git，将改用压缩包方式（回滚功能不受影响）"; return 0 ;;
  esac
  have git || warn "git 自动安装失败，将改用压缩包方式（回滚功能不受影响）"
}

# 判断 Docker 是否真的可用：二进制存在不等于守护进程可达
# （例如 WSL 里 PATH 上有 Windows 侧的 docker，但守护进程连不上）
docker_ready() {
  have docker || return 1
  # 非 root 且不在 docker 组时，守护进程只能用 sudo 访问 —— 先试直接访问再试 sudo，
  # 否则会被误判成「Docker 未安装」而重复走安装流程
  if docker info >/dev/null 2>&1; then
    docker compose version >/dev/null 2>&1
    return $?
  fi
  have sudo || return 1
  sudo docker info >/dev/null 2>&1 || return 1
  sudo docker compose version >/dev/null 2>&1
}

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
DATABASE_URL_OPT="${DATABASE_URL_OPT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|backup|restore|logs|status|info|start|stop|restart|rollback|uninstall|help) COMMAND="$1"; COMMAND_SET=1 ;;
    doctor)                 COMMAND="$1"; COMMAND_SET=1 ;;
    autobackup|migrate)     COMMAND="$1"; COMMAND_SET=1 ;;
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
    --image)    IMAGE="${2:-}"; shift ;;
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
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --no-doctor)     SKIP_DOCTOR=1 ;;
    --reset|--fresh) RESET_STATE=1 ;;
    --no-autobackup) NO_AUTOBACKUP=1 ;;
    -h|--help)  COMMAND="help" ;;
    *)          ARGS+=("$1") ;;
  esac
  shift
done

# ------------------------------------------------------------
# 配置档：把一次安装的选择存成文件，之后照着它一键复现
# ------------------------------------------------------------
# 优先级：命令行参数 > 配置档 > 环境变量/内置默认值。
# 所以配置档只补「命令行没给」的项，不会覆盖你手敲的参数。
# 这里定义得早、调用得早，是因为它要在任何函数被调用之前生效。
load_config_file() {
  local f="$1"
  [ -f "$f" ] || die "找不到配置档：$f（--config 后面要跟一个真实存在的文件）"
  log "读取配置档：$f"
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
    # 全部写成 `… || VAR=val`：左侧成功则短路（返回 0），失败才赋值，
    # 整条语句永远返回 0 —— 在 set -e 下不会把脚本打断。
    case "$key" in
      DOMAIN)       [ -n "$DOMAIN" ]        || DOMAIN="$val" ;;
      PORT)         [ -n "$APP_PORT" ]      || APP_PORT="$val" ;;
      DB)           [ -n "$DB_KIND" ]       || DB_KIND="$val" ;;
      DATABASE_URL) [ -n "$DATABASE_URL_OPT" ] || DATABASE_URL_OPT="$val" ;;
      DIR)          [ "$DIR_SET" = "1" ]    || INSTALL_DIR="$val" ;;
      REF)          [ "$REF_SET" = "1" ]    || REF="$val" ;;
      REPO)         REPO="$val" ;;
      EMAIL)        [ -n "$EMAIL" ]         || EMAIL="$val" ;;
      IP)           [ -n "$IP_ADDR" ]       || IP_ADDR="$val" ;;
      TIMEZONE)     [ -n "$TIMEZONE" ]      || TIMEZONE="$val" ;;
      SMTP_HOST)    [ -n "$SMTP_HOST_OPT" ] || SMTP_HOST_OPT="$val" ;;
      SMTP_PORT)    [ -n "$SMTP_PORT_OPT" ] || SMTP_PORT_OPT="$val" ;;
      SMTP_USER)    [ -n "$SMTP_USER_OPT" ] || SMTP_USER_OPT="$val" ;;
      SMTP_PASS)    [ -n "$SMTP_PASS_OPT" ] || SMTP_PASS_OPT="$val" ;;
      SMTP_FROM)    [ -n "$SMTP_FROM_OPT" ] || SMTP_FROM_OPT="$val" ;;
      MIRROR)       if [ "$val" = "1" ]; then MIRROR=1; fi ;;
      KEEP)         [ -z "$val" ] || KEEP_N="$val" ;;
      AT)           [ -z "$val" ] || AT_TIME="$val" ;;
      AUTOBACKUP)
        if [ "$val" = "1" ]; then WIZ_BACKUP=1; fi
        if [ "$val" = "0" ]; then NO_AUTOBACKUP=1; fi
        ;;
    esac
  done < "$f"
}
[ -n "$CONFIG_FILE" ] && load_config_file "$CONFIG_FILE"

usage() {
  cat <<'EOF'
轻语博客 · 自托管通用版 一键部署

  install                 安装并启动（默认）
                          （已部署过且不带子命令运行时，改为弹出数字菜单）
  upgrade                 拉取新版本并重建（保留数据）
  rollback                回滚到上一个版本（回滚前自动备份）
  backup                  生成数据库快照到 data/backups
  autobackup              安装定时备份（每天自动快照，只保留最近 7 份）
  migrate                 打包整站（含数据），用于迁移到新服务器
  restore <快照文件>       从快照恢复（请先 docker compose stop app）
  start                   启动服务（停过之后再拉起来）
  stop                    停止服务（配置和数据都保留）
  restart                 重启应用（改完 .env 后用它生效）
  logs                    查看应用日志
  status                  查看容器与健康状态
  info                    查看部署信息（访问地址、初始化密钥、版本、文章数…）
  doctor                  一键体检：Docker/容器/端口/防火墙/公网地址/磁盘/错误日志
  uninstall               停止并删除容器（数据卷保留，需手动删除）

选项：
  --domain <域名>         对外域名，启用 Caddy + Let's Encrypt 自动 HTTPS
                          （不填则用 http://<服务器IP>:<端口> 直接访问，无证书）
  --port   <端口>         直接对外暴露该端口，走纯 HTTP、不启动 Caddy。
                          80/443 被占用（母鸡开出来的小鸡）时用它，
                          也等于「无域名 / 自定义端口」模式（默认 8080）
  --db     <数据库>       sqlite（默认，单文件备份最省心）
                          | postgres（脚本自动装好内置容器，数据放独立卷）
  --database-url <连接串> 用你自己的云数据库（阿里云 RDS / 腾讯云 / Supabase…），
                          等价于 --db postgres 的「外部数据库」模式
  --ip     <地址>         无域名模式下写入 SITE_URL 的地址（默认自动探测公网 IP）
  -y, --yes               不提问，全部使用默认值（自动化 / CI 用）
  --email  <邮箱>         ACME 证书通知邮箱（可选）
  --dir    <目录>         安装目录，默认 /opt/qingyu-universal
  --ref    <分支/标签>     下载的代码版本，默认 main
  --repo   <owner/repo>    从哪个 GitHub 仓库取代码，默认 kejiland/qingyu-universal
  --image  <镜像>         使用预构建镜像而不是本地构建
  --no-mirror             关闭国内加速（升级时想改回官方源用）
  --mirror            国内网络加速：GitHub 代码、Docker 镜像、npm 依赖都走国内源
                      （国内服务器 / 网络卡时加它；选择会记进 .env，下次升级自动沿用）
  --github-proxy <前缀> 指定自己的 GitHub 加速前缀，例如 https://ghfast.top
  --keep   <份数>        定时备份保留最近几份（默认 7）
  --at     <HH:MM>       定时备份每天几点执行（默认 03:30）
  --off                  关闭定时备份
  --out    <文件>        migrate 生成的 tar.gz 保存路径
  --purge                uninstall 时连数据卷一起删干净

新手向导 / 可配置：
  （全新安装且没给任何参数时，默认会先走一遍问答向导；加 -y 则全程不提问）
  --wizard              强制走一遍问答向导（即使已经给了参数）
  --no-wizard           不提问，全部用默认值
  --config <配置档>      从文件读取选项，照着它装（见 --save-config）
  --save-config <文件>   把本次的选择写成配置档，之后可 --config 复现
  --dry-run             只打印「将要做什么」，不装 Docker、不写 .env、不启容器
  --timezone <时区>      设置系统时区，例如 Asia/Shanghai（定时备份按它执行）
  --smtp-host <地址>     邮件通知（都留空 = 不配置，之后可在后台「设置 → 邮件」里补）
  --smtp-port <端口>
  --smtp-user <用户名>
  --smtp-pass <密码>
  --smtp-from <发件人>
  --no-autobackup       安装后不装定时备份
  --skip-preflight      跳过起飞前检查（端口 / 域名 / 防火墙）
  --no-doctor           安装后不做自动体检
  --reset, --fresh       清除「安装进度记录」，从头执行（断点续跑用）
  -h, --help             查看全部参数

  配置档示例（KEY=VALUE，# 开头是注释）：
      DOMAIN=blog.example.com
      DB=sqlite
      TIMEZONE=Asia/Shanghai
      AUTOBACKUP=1
      AT=03:30
      KEEP=7

  断点续跑：安装中途失败不用重来，原样再跑一次同一条命令即可，
            已完成并记录的步骤会自动跳过（想从头来就加 --reset）。
EOF
}

# ---------- 运行环境检查 ----------
need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    have sudo || die "需要 root 权限（安装 Docker、写入 ${INSTALL_DIR}、绑定端口都需要）。请改用 root，或先安装 sudo。"
    SUDO="sudo"
    # 立刻验证 sudo 是否可用，避免装到一半才卡在密码提示上
    if ! $SUDO -n true 2>/dev/null; then
      if [ -r /dev/tty ]; then
        log "需要 sudo 权限，请输入密码："
        $SUDO -v < /dev/tty || die "sudo 认证失败"
      else
        die "当前用户需要 sudo 密码，但此处无法交互输入。请改用 root 执行，或先执行 sudo -v。"
      fi
    fi
  else
    SUDO=""
  fi
}

# 准备安装目录。
# 用 sudo 创建后**把所有权交给当前用户**：这样后续复制源码、写 .env、
# 读配置都不再需要提权，也不会出现 .env 变成 root 独有（脚本自己要读它）
# 或「非 root 往 /opt 写入刷屏 permission denied」的问题。
prepare_install_dir() {
  if [ "$(id -u)" -ne 0 ]; then
    $SUDO mkdir -p "$INSTALL_DIR"
    $SUDO chown "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
  else
    mkdir -p "$INSTALL_DIR"
  fi
}

# 通过 GitHub 的 Atom feed 取某个分支 / 标签的完整 commit SHA。
# 它走网页，不受 api.github.com 的限流（未认证每小时 60 次，实测经常直接 403）。
# 取不到则返回空串，不影响部署。
#
# 注意：这里先把响应存进变量再解析，**不能**写成
#   curl … | grep -m1 …
# 因为脚本开了 set -o pipefail，而 grep -m1 命中后立即退出会让 curl 收到
# SIGPIPE（141），pipefail 把整条管道判为失败 —— 而且这是竞态：
# curl 先写完就正常，所以单独测试能过、在脚本里却拿到空值。
atom_revision() {
  local ref="${1:-$REF}" body="" sha=""
  [ -n "$ref" ] || return 0
  local u
  while IFS= read -r u; do
    body=$(curl -fsS --max-time 8 -H 'User-Agent: curl' "$u" 2>/dev/null) || body=""
    [ -n "$body" ] && break
  done < <(github_urls "$REPO/commits/$ref.atom")
  if [ -n "$body" ]; then
    sha=$(printf '%s' "$body" | grep -oE 'Grit::Commit/[0-9a-f]{40}' | sed -n '1s|.*/||p') || sha=""
  fi
  printf '%s' "$sha"
}

# 把「分支 / 标签 / commit」统一成可下载的完整 SHA。
# 纯十六进制（用户直接给了 commit）不联网；其余问一次 Atom feed。
ref_to_full() {
  local ref="${1:-}" body=""
  [ -n "$ref" ] || return 0
  case "$ref" in
    *[!0-9a-fA-F]*) body="$(atom_revision "$ref")" ;;
    *)
      if [ "${#ref}" -ge 40 ]; then
        printf '%s' "$ref"
        return 0
      fi
      # 短 SHA：本地有 git 就本地展开，否则原样带回（GitHub 也认短 SHA）
      if [ -d "$INSTALL_DIR/.git" ] && have git; then
        body="$(git -C "$INSTALL_DIR" rev-parse --verify -q "$ref^{commit}" 2>/dev/null || true)"
      elif [ -n "${SOURCE_ROOT:-}" ] && [ -d "$SOURCE_ROOT/.git" ] && have git; then
        body="$(git -C "$SOURCE_ROOT" rev-parse --verify -q "$ref^{commit}" 2>/dev/null || true)"
      fi
      [ -n "$body" ] || body="$ref"
      ;;
  esac
  printf '%s' "$body"
}

# 当前安装对应的完整 SHA（版本记录文件是压缩包安装的「版本账本」）
resolve_revision_full() {
  local sha=""
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    sha=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null) || sha=""
  fi
  if [ -z "$sha" ]; then
    sha="$(head -n1 "$(cur_ref_file)" 2>/dev/null || true)"
    sha="$(printf '%s' "$sha" | tr -d '[:space:]')"
  fi
  if [ -z "$sha" ] && [ -n "${SOURCE_ROOT:-}" ] && [ -d "$SOURCE_ROOT/.git" ] && have git; then
    sha=$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null) || sha=""
  fi
  if [ -z "$sha" ]; then
    sha="$(atom_revision "$REF")"
  fi
  printf '%s' "$sha"
}

# 取构建版本（commit 短 SHA），用于确认「升级到底生效没有」。
resolve_revision() {
  local full=""
  full="$(resolve_revision_full)"
  if [ -n "$full" ]; then
    printf '%.7s' "$full"
  fi
}
# Docker 命令前缀：非 root 且当前用户访问不了守护进程（不在 docker 组）时用 sudo
resolve_docker() {
  if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    DOCKER="docker"
  fi
}

detect_distro() {
  if [ -f /etc/os-release ]; then . /etc/os-release; echo "${ID:-linux}"; else echo linux; fi
}

# ============================================================
# 国内网络加速（--mirror）
# ------------------------------------------------------------
# 只做三件事，而且每件都有「失败就回落官方源」的兜底：
#   1) GitHub 代码：克隆 / 压缩包 / 版本查询先走加速前缀
#   2) Docker Hub：往 /etc/docker/daemon.json 写 registry-mirrors
#   3) npm：构建镜像时把 registry 换成 npmmirror
# 只在显式传 --mirror、或 .env 里记着 QINGYU_MIRROR=1 时生效。
# ============================================================

# 没显式指定时，沿用 .env 里记下的选择（升级时不用重复加 --mirror）
resolve_mirror() {
  if [ -z "$MIRROR" ]; then
    if [ -f "$INSTALL_DIR/.env" ] && grep -q '^QINGYU_MIRROR=1' "$INSTALL_DIR/.env" 2>/dev/null; then
      MIRROR=1
    else
      MIRROR=0
    fi
  fi
  [ "$MIRROR" = "1" ] || return 0
  [ -n "$NPM_REGISTRY_OPT" ] || NPM_REGISTRY_OPT="https://registry.npmmirror.com"
  log "已启用国内加速：GitHub 代码 / Docker Hub 镜像 / npm 依赖"
}

# GitHub 加速前缀（按顺序试；都试不通就用官方直连）
github_proxy_list() {
  if [ -n "$GITHUB_PROXY" ]; then printf '%s\n' "${GITHUB_PROXY%/}"; return 0; fi
  printf '%s\n' "https://ghfast.top" "https://gh-proxy.com" "https://ghproxy.net"
}

# 同一个 GitHub 资源的候选地址。
# 入参既可以是相对路径（owner/repo/archive/...），也可以是完整 URL（自动剥掉域名）。
github_urls() {
  local path="${1#https://github.com/}" p
  if [ "${MIRROR:-0}" = "1" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      printf '%s\n' "${p}/https://github.com/$path"
    done < <(github_proxy_list)
  fi
  printf '%s\n' "https://github.com/$path"
}

# git clone 的候选地址（加速服务对 .git 的支持和普通下载不一样，单独一份）
git_clone_urls() {
  if [ "${MIRROR:-0}" = "1" ]; then
    if [ -n "$GITHUB_PROXY" ]; then
      printf '%s\n' "${GITHUB_PROXY%/}/https://github.com/$REPO.git"
    fi
    printf '%s\n' "https://gitclone.com/github.com/$REPO.git"
  fi
  printf '%s\n' "https://github.com/$REPO.git"
}

# 下载 GitHub 上的资源：逐个候选地址试，成功返回 0，全失败返回 1（由调用方决定要不要报错）
gh_fetch() {
  local path="$1" out="$2" u
  while IFS= read -r u; do
    if curl -fsSL --connect-timeout 8 --max-time 180 "$u" -o "$out" 2>/dev/null; then
      return 0
    fi
    rm -f "$out"
  done < <(github_urls "$path")
  return 1
}

# Debian / Ubuntu 走阿里云的 docker-ce 源（get.docker.com 国内经常超时）。
# 成功返回 0；不适合当前系统或失败返回 1，由调用方回落官方一键脚本。
install_docker_mirror() {
  local distro codename arch
  distro="$(detect_distro)"
  case "$distro" in debian|ubuntu) ;; *) return 1 ;; esac
  [ -r /etc/os-release ] || return 1
  codename="$([ -r /etc/os-release ] && . /etc/os-release; echo "${VERSION_CODENAME:-}")"
  [ -n "$codename" ] || return 1
  arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  log "用阿里云镜像源安装 Docker（${distro} ${codename}）"
  $SUDO apt-get update -qq || return 1
  $SUDO apt-get install -y -qq ca-certificates curl gnupg || return 1
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL --connect-timeout 8 "https://mirrors.aliyun.com/docker-ce/linux/${distro}/gpg" \
    | $SUDO gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg || return 1
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/%s %s stable\n' \
    "$arch" "$distro" "$codename" | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq || return 1
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
  have docker
}

# Docker Hub 镜像加速：写 /etc/docker/daemon.json 的 registry-mirrors。
# 已有配置一律不动（怕把用户自己的加速地址或 runtime 配置弄坏）。
configure_registry_mirror() {
  [ "${MIRROR:-0}" = "1" ] || return 0
  # Docker Desktop 自己管 daemon.json，不碰
  if ${DOCKER:-docker} info 2>/dev/null | grep -qi 'docker desktop'; then
    log "检测到 Docker Desktop，镜像加速请在 Desktop 的设置里配置"
    return 0
  fi
  local dj="/etc/docker/daemon.json"
  if [ -f "$dj" ] && grep -q 'registry-mirrors' "$dj" 2>/dev/null; then
    log "Docker 镜像加速已配置，保持不变"
    return 0
  fi
  if [ -f "$dj" ]; then
    warn "/etc/docker/daemon.json 已存在但没有 registry-mirrors，为不破坏原配置未自动改写"
    warn "  可手动加上：\"registry-mirrors\": [\"https://docker.m.daocloud.io\"] 后重启 Docker"
    return 0
  fi
  $SUDO mkdir -p /etc/docker
  $SUDO tee "$dj" >/dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live",
    "https://mirror.baidubce.com"
  ]
}
EOF
  log "已写入 Docker 镜像加速（/etc/docker/daemon.json）"
  $SUDO systemctl restart docker >/dev/null 2>&1 \
    || $SUDO service docker restart >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 20 ]; do
    if ${DOCKER:-docker} info >/dev/null 2>&1; then
      log "Docker 已重启并就绪"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  warn "Docker 重启后还没就绪，请检查：systemctl status docker"
}

# 升级时把 --mirror 的选择追加进已有的 .env（首次安装由 ensure_env 直接写入）
persist_mirror_env() {
  [ "${MIRROR:-0}" = "1" ] || return 0
  local env_file="$INSTALL_DIR/.env" need=0
  [ -f "$env_file" ] || return 0
  grep -q '^QINGYU_MIRROR=' "$env_file" 2>/dev/null || need=1
  grep -q '^NPM_REGISTRY='  "$env_file" 2>/dev/null || need=1
  [ "$need" = "1" ] || return 0
  local block
  block='
# 国内网络加速（deploy/install.sh --mirror 生成）
'
  grep -q '^QINGYU_MIRROR=' "$env_file" 2>/dev/null || block="${block}QINGYU_MIRROR=1
"
  grep -q '^NPM_REGISTRY='  "$env_file" 2>/dev/null || block="${block}NPM_REGISTRY=${NPM_REGISTRY_OPT}
"
  if [ -w "$env_file" ]; then
    printf '%s' "$block" >> "$env_file"
  else
    printf '%s' "$block" | $SUDO tee -a "$env_file" >/dev/null
  fi
  log "已把国内加速设置写入 .env（下次升级自动沿用）"
}

install_docker() {
  if docker_ready; then
    log "Docker 与 Compose 已就绪（$(docker --version)）"
    return
  fi
  ensure_curl
  log "未检测到可用的 Docker，正在安装…"
  if [ "$(detect_distro)" = "alpine" ]; then
    $SUDO apk add --no-cache docker docker-cli-compose
    $SUDO rc-update add docker default || true
    $SUDO service docker start || true
  else
    # 国内服务器先试阿里云的 docker-ce 源（get.docker.com 国内经常超时），
    # 失败或不是 Debian 系就回落官方一键脚本
    if [ "${MIRROR:-0}" = "1" ] && install_docker_mirror; then
      log "Docker 安装完成（阿里云镜像源）"
    else
      curl -fsSL https://get.docker.com | $SUDO sh
    fi
    $SUDO systemctl enable --now docker || true
  fi
  have docker || die "Docker 安装失败，请手动安装后重试"
  $SUDO docker compose version >/dev/null 2>&1 || warn "未检测到 compose 插件，请确认 docker compose 可用"
}

# ---------- 代码获取 ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd || true)"

# 克隆到临时目录再整树覆盖 —— 安装目录里已有的 .env / data 不会被动到。
# 成功后安装目录就是 git 检出，之后 upgrade / rollback 都走本地历史，又快又稳。
clone_source() {
  have git || return 1
  local tmp
  tmp="$(mktemp -d)"
  log "用 Git 获取代码：$REPO@$REF"
  local git_url cloned=0
  while IFS= read -r git_url; do
    rm -rf "$tmp/src"
    if git clone --quiet "$git_url" "$tmp/src" 2>/dev/null; then cloned=1; break; fi
  done < <(git_clone_urls)
  if [ "$cloned" -ne 1 ]; then
    rm -rf "$tmp"
    return 1
  fi
  if ! git -C "$tmp/src" checkout --quiet "$REF" 2>/dev/null \
     && ! git -C "$tmp/src" checkout --quiet "origin/$REF" 2>/dev/null; then
    rm -rf "$tmp"
    # 用户明确指定了版本就必须精确命中；没指定就用克隆出来的默认分支
    [ "$REF_SET" = "1" ] && die "找不到版本：$REF（请确认分支 / 标签 / commit 是否存在）"
    return 1
  fi
  cp -a "$tmp/src"/. "$INSTALL_DIR/"
  rm -rf "$tmp"
  remember_cur_ref "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  log "代码已就绪（git 检出，支持 upgrade / rollback）"
  return 0
}

fetch_source() {
  prepare_install_dir
  # 情况一：从仓库内运行（本地已有完整代码）→ 直接同步过去
  if [ -n "${SOURCE_ROOT:-}" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ -f "$SOURCE_ROOT/deploy/Dockerfile" ]; then
    log "使用本地代码：$SOURCE_ROOT"
    if [ "$(cd "$SOURCE_ROOT" && pwd)" != "$(cd "$INSTALL_DIR" && pwd)" ]; then
      # 整树复制并排除本地产物。
      # 此前是手写文件清单，加入后台应用后清单没同步，漏掉 admin/ 与 generated/，
      # 会让 Dockerfile 构建后台时直接失败——清单式复制对新增目录太脆弱，改为整树。
      tar -C "$SOURCE_ROOT" -cf - \
        --exclude='./.git' \
        --exclude='./node_modules' \
        --exclude='./admin/node_modules' \
        --exclude='./admin/dist' \
        --exclude='./dist' \
        --exclude='./data' \
        --exclude='./.env' \
        . | tar -C "$INSTALL_DIR" -xf -
    fi
    remember_cur_ref "$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    return
  fi
  # 情况二：已经是 git 检出 → 不重复下载
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    # 例外：用户明确给了 --ref，就按指定版本切换
    if [ "$REF_SET" = "1" ]; then
      update_source
      return
    fi
    remember_cur_ref "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    log "代码已是 git 检出，跳过下载"
    return
  fi
  # 情况三：远程一键安装 → 优先克隆（带回完整历史），失败退回压缩包
  clone_source && return 0
  download_source
}

# 下载指定版本的代码包并覆盖到安装目录。
# 只覆盖代码，不动 .env 与 data —— 压缩包里本来就不含它们。
# 用法：download_source            → 下载 $REF（默认当前分支）
#       download_source <commit>   → 回滚时下载某个历史版本
download_source() {
  local target="${1:-$REF}" full="" exact=0
  log "下载代码：$REPO@$target"
  need_root
  ensure_curl
  full="$(ref_to_full "$target")"
  [ -n "$full" ] || full="$target"
  # 只有拿到精确 commit 才记账；只拿到分支名时宁可不记，
  # 也绝不写一条「回滚到最新版」的假记录
  case "$full" in
    *[!0-9a-fA-F]*) exact=0 ;;
    *) exact=1 ;;
  esac
  local tmp url1 url2 url3
  tmp="$(mktemp -d)"
  case "$full" in
    *[!0-9a-fA-F]*)
      # 分支 / 标签
      url1="$REPO/archive/refs/heads/$full.tar.gz"
      url2="$REPO/archive/refs/tags/$full.tar.gz"
      url3="$REPO/archive/$full.tar.gz"
      ;;
    *)
      # commit（回滚走这里）：GitHub 支持直接按 SHA 打包
      url1="$REPO/archive/$full.tar.gz"
      url2=""
      url3=""
      ;;
  esac
  # gh_fetch 先试加速地址（--mirror），失败自动回落官方直连
  if [ -n "$url2" ]; then
    gh_fetch "$url1" "$tmp/src.tgz" \
      || gh_fetch "$url2" "$tmp/src.tgz" \
      || gh_fetch "$url3" "$tmp/src.tgz" \
      || die "下载失败：https://github.com/$REPO（请确认仓库与分支/标签/版本；国内网络可加 --mirror 或 --github-proxy）"
  else
    gh_fetch "$url1" "$tmp/src.tgz" \
      || die "下载失败：https://github.com/$REPO/archive/$full（版本可能已被删除；国内网络可加 --mirror）"
  fi
  tar -xzf "$tmp/src.tgz" -C "$tmp"
  local extracted
  extracted="$(find "$tmp" -maxdepth 1 -type d -name '*qingyu*' | head -n1)"
  [ -n "$extracted" ] || extracted="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)"
  cp -a "$extracted"/. "$INSTALL_DIR/"
  rm -rf "$tmp"
  if [ "$exact" = "1" ]; then
    remember_cur_ref "$full"
    log "代码已更新到 $(printf '%.7s' "$full")"
  else
    warn "本次没能确认精确版本号，暂不生成回滚记录（下次升级会重新尝试）"
    log "代码已更新到 $full"
  fi
}

# ---------- 版本记录与回滚 ----------
# 版本账本：cur 记「现在是哪版」，prev 记「上一版是哪版」。
# 两个文件都放在安装目录里（已加入 .gitignore，不会污染 git status）。
prev_ref_file() { printf '%s/.qingyu-prev-ref' "$INSTALL_DIR"; }
cur_ref_file()  { printf '%s/.qingyu-cur-ref' "$INSTALL_DIR"; }

read_ref_file() {
  head -n1 "${1:-}" 2>/dev/null | tr -d '[:space:]' || true
}

# 两个版本号是否指向同一个 commit（兼容一长一短的 SHA 写法）
refs_equal() {
  local a b m
  a="$(printf '%s' "${1:-}" | tr 'A-F' 'a-f')"
  b="$(printf '%s' "${2:-}" | tr 'A-F' 'a-f')"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "$a" = "$b" ] && return 0
  m="${#a}"; [ "${#b}" -lt "$m" ] && m="${#b}"
  [ "$m" -ge 7 ] && [ "${a:0:$m}" = "${b:0:$m}" ]
}

# 记录「现在是哪个版本」——压缩包安装没有 git，靠这个小文件当版本账本
remember_cur_ref() {
  local sha="${1:-}"
  [ -n "$sha" ] || return 0
  printf '%s\n' "$sha" > "$(cur_ref_file)"
}

remember_prev_ref() {
  local sha="${1:-}"
  [ -n "$sha" ] || return 0
  printf '%s\n' "$sha" > "$(prev_ref_file)"
}

# upgrade 专用的取码逻辑：
#   安装目录是 git 仓库 → git pull
#   从本地 checkout 运行  → 复制本地代码
#   压缩包安装（默认）    → 下载最新代码包
# 此前 upgrade 只做「重建容器」，对压缩包安装等于原地重建旧版本，
# 用户执行了 upgrade 却拿不到新代码。
update_source() {
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    # 显式给了 --ref：切到那个版本（分支 / 标签 / commit 都行），并记下回滚点
    if [ "$REF_SET" = "1" ]; then
      log "切换到指定版本 $REF…"
      git -C "$INSTALL_DIR" fetch --quiet origin --tags || warn "拉取远端失败，改用本地已有的版本"
      local target=""
      target="$(git -C "$INSTALL_DIR" rev-parse --verify -q "$REF^{commit}" 2>/dev/null || true)"
      [ -n "$target" ] || target="$(git -C "$INSTALL_DIR" rev-parse --verify -q "origin/$REF^{commit}" 2>/dev/null || true)"
      [ -n "$target" ] || die "找不到版本：$REF（请确认分支 / 标签是否存在）"
      local cur
      cur="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
      if [ "$cur" != "$target" ]; then
        remember_prev_ref "$cur"
        git -C "$INSTALL_DIR" reset --hard "$target" >/dev/null
        remember_cur_ref "$target"
        log "已切换到 ${target:0:7}（可用 rollback 回到 ${cur:0:7}）"
      else
        log "当前已经是 $REF"
      fi
      return 0
    fi
    log "从 git 拉取最新代码…"
    local before after
    before="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull 失败，继续用现有代码重建"
    after="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    remember_cur_ref "$after"
    if [ "$before" != "$after" ]; then
      remember_prev_ref "$before"
      log "版本已更新 ${before:0:7} → ${after:0:7}（不满意可用 rollback 退回）"
    fi
    return 0
  fi
  # 本地 checkout 运行 → 复制本地代码，并记好回滚点
  if [ -n "${SOURCE_ROOT:-}" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ "$SOURCE_ROOT" != "$INSTALL_DIR" ]; then
    local before_local after_local
    before_local="$(read_ref_file "$(cur_ref_file)")"
    fetch_source
    after_local="$(read_ref_file "$(cur_ref_file)")"
    if [ -n "$before_local" ] && [ -n "$after_local" ] && ! refs_equal "$before_local" "$after_local"; then
      remember_prev_ref "$before_local"
      log "版本已更新（不满意可用 rollback 退回）"
    fi
    return 0
  fi

  # 压缩包安装：先记下「升级前」的版本，再取新代码
  local before after
  before="$(read_ref_file "$(cur_ref_file)")"
  # 装过 git 之后，升级顺手把它变成 git 检出（以后升级更快、可精确回滚）
  if [ ! -d "$INSTALL_DIR/.git" ] && have git && clone_source; then
    after="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  else
    download_source
    after="$(read_ref_file "$(cur_ref_file)")"
  fi
  if [ -n "$before" ] && [ -n "$after" ] && ! refs_equal "$before" "$after"; then
    remember_prev_ref "$before"
    log "版本已更新 ${before:0:7} → ${after:0:7}（不满意可用 rollback 退回）"
  elif [ -z "$before" ] && [ -n "$after" ]; then
    log "已记录当前版本 ${after:0:7}（从下一次升级起可用 rollback）"
  fi
}

# ---------- 数据库选择 ----------
# 归一化成三种形态：
#   sqlite   内置 SQLite 文件（默认，零依赖）
#   postgres 启动 compose 里的 PostgreSQL 容器
#   external 用户自己的云数据库，只填 DATABASE_URL
resolve_database() {
  # --database-url 直接给出连接串 → 外部托管库
  if [ -n "$DATABASE_URL_OPT" ]; then
    DB_KIND="external"
    return 0
  fi
  # --db postgres://… 这种写法也算给出连接串
  case "$DB_KIND" in
    postgres://*|postgresql://*)
      DATABASE_URL_OPT="$DB_KIND"
      DB_KIND="external"
      return 0
      ;;
  esac
  # 没给任何参数 → 默认 SQLite（重复执行 / 升级时也保持原样）
  [ -n "$DB_KIND" ] || { DB_KIND="sqlite"; return 0; }
  case "$DB_KIND" in
    sqlite|postgres) ;;
    *) die "不支持的数据库类型：$DB_KIND（可选 sqlite / postgres，或直接给 --database-url）" ;;
  esac
}

# ---------- 配置生成 ----------
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# 探测对外 IP：云主机通常在 NAT 后，本地网卡看到的只是内网地址，
# 所以优先问外部回显服务，失败再退回第一块网卡。
detect_ip() {
  local ip=""
  ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [ -z "$ip" ] && ip=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)
  [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${ip:-127.0.0.1}"
}
rand_short() { head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ensure_env() {
  local env_file="$INSTALL_DIR/.env"
  if [ -f "$env_file" ]; then
    log "已存在 .env，保持不覆盖（如需重配请手动编辑）"
    if [ -n "${DATABASE_URL_OPT:-}" ] || { [ -n "${DB_KIND:-}" ] && [ "$DB_KIND" != "sqlite" ]; }; then
      warn "本次指定了数据库参数，但 .env 已存在 —— 数据库配置以现有 .env 为准，本次不改动"
    fi
    return
  fi
  local setup_key write_token site_url app_bind compose_profiles trust_proxy
  local mirror_flag=0 npm_registry=""
  if [ "${MIRROR:-0}" = "1" ]; then
    mirror_flag=1
    npm_registry="$NPM_REGISTRY_OPT"
  fi
  local database_url postgres_db postgres_user postgres_password
  setup_key="qy-$(rand_short)"
  write_token="$(rand)"
  database_url=""
  postgres_db="qingyu"
  postgres_user="qingyu"
  postgres_password=""

  # 数据库形态由 resolve_database() 决定；交互选择在 interact_mode() 里完成
  if [ "$DB_KIND" = "postgres" ]; then
    # 连接串里的密码是 64 位十六进制，天然 URL 安全，不需要转义
    postgres_password="$(rand)"
    database_url="postgres://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}"
  elif [ "$DB_KIND" = "external" ]; then
    database_url="$DATABASE_URL_OPT"
  fi

  if [ -n "$DOMAIN" ] && [ -z "$APP_PORT" ]; then
    # 模式一：域名 + 自动 HTTPS
    # Caddy 反代，app 只绑本机不对外暴露；证书走 Let's Encrypt
    site_url="https://$DOMAIN"
    app_bind="127.0.0.1:8787"
    compose_profiles="domain"
    trust_proxy="1"
  else
    # 模式二 / 三：纯 HTTP，不启 Caddy、不涉及证书
    #   · --domain X --port 8080 → http://X:8080（80/443 被占用时的退路）
    #   · 无 --domain --port 8080 → http://<IP>:8080
    #   · 无 --domain 且未给端口 → 默认 8080
    [ -n "$APP_PORT" ] || APP_PORT=8080
    if [ -n "$DOMAIN" ]; then
      site_url="http://${DOMAIN}:${APP_PORT}"
    else
      [ -n "$IP_ADDR" ] || IP_ADDR="$(detect_ip)"
      site_url="http://${IP_ADDR}:${APP_PORT}"
    fi
    app_bind="0.0.0.0:${APP_PORT}"
    compose_profiles=""
    # 没有反向代理时不能信任 X-Forwarded-For —— 否则限流标识可被伪造绕过
    trust_proxy="0"
  fi

  # 内置 PostgreSQL 时追加 postgres profile，compose 才会把数据库容器一起拉起
  [ "$DB_KIND" = "postgres" ] && add_profile postgres

  log "生成 .env 与随机密钥"
  cat > "$env_file" <<EOF
# 由 deploy/install.sh 于 $(date -u +"%Y-%m-%dT%H:%M:%SZ") 生成
PORT=8787
HOST=0.0.0.0
SITE_URL=$site_url
SITE_DOMAIN=$DOMAIN
DATA_DIR=./data
# 数据库：留空使用 SQLite 文件；填写连接串则切换到 PostgreSQL
# 数据库类型由 deploy/install.sh 决定（--db sqlite|postgres 或交互选择）
DATABASE_URL=$database_url
# 仅内置 PostgreSQL 容器需要；使用外部数据库时留空
POSTGRES_DB=$postgres_db
POSTGRES_USER=$postgres_user
POSTGRES_PASSWORD=$postgres_password
# 可选：Redis / Valkey 限流与去重；留空使用数据库 KV
REDIS_URL=
APP_BIND=$app_bind
COMPOSE_PROFILES=$compose_profiles
TRUST_PROXY=$trust_proxy

# 首次打开 /admin 时需要填写的安装密钥
BLOG_ADMIN_SETUP_KEY=$setup_key
# 脚本 / CI 长期写入令牌
BLOG_WRITE_TOKEN=$write_token

# 对象存储（留空 = 本地磁盘）
S3_ENDPOINT=
S3_REGION=auto
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_MEDIA_BUCKET=
S3_MEDIA_PUBLIC_BASE=
S3_MUSIC_BUCKET=
S3_MUSIC_PUBLIC_BASE=
S3_BACKUP_BUCKET=

# 邮件（留空 = 关闭订阅通知；也可安装后在后台「设置 → 邮件」里填）
SMTP_HOST=${SMTP_HOST_OPT}
SMTP_PORT=${SMTP_PORT_OPT:-587}
SMTP_USER=${SMTP_USER_OPT}
SMTP_PASS=${SMTP_PASS_OPT}
SMTP_SECURE=0
RESEND_API_KEY=
BLOG_MAIL_FROM=${SMTP_FROM_OPT}

# AI（留空 = 关闭）
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
# 国内网络加速（deploy/install.sh --mirror 生成；1 = 启用）
QINGYU_MIRROR=$mirror_flag
# 构建镜像时 npm 使用的源，留空 = 官方源
NPM_REGISTRY=$npm_registry
# 系统时区（--timezone 设置；影响定时备份的执行时间）
TZ=${TIMEZONE}
EOF
  chmod 600 "$env_file"
  SETUP_KEY_SHOWN="$setup_key"
}

# 读取 .env 中的值（install.sh 生成的配置以 .env 为准，避免两处真值）
env_value() {
  local key="$1"
  [ -f "$INSTALL_DIR/.env" ] || return 0
  grep -E "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# COMPOSE_PROFILES 是逗号分隔的列表（如 "domain,postgres"）。
# 判断某个 profile 是否启用时按整词匹配，不能用字符串相等，
# 否则「域名 + PostgreSQL」会被误判成没有 Caddy。
has_profile() {
  local needle="$1" profiles="$2"
  case ",${profiles}," in
    *",${needle},"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 往逗号列表里追加一个 profile（已存在则不重复）
add_profile() {
  local needle="$1"
  if has_profile "$needle" "$compose_profiles"; then return 0; fi
  compose_profiles="${compose_profiles:+$compose_profiles,}${needle}"
}

# 是否启用 Caddy（即 HTTPS 模式）。
# .env 已存在时必须以里面的 COMPOSE_PROFILES 为准：
# 那时 APP_BIND=127.0.0.1:8787 会被误判成「自定义端口」。
uses_caddy() {
  local profiles; profiles="$(env_value COMPOSE_PROFILES)"
  if [ -n "$profiles" ]; then
    has_profile domain "$profiles"
    return
  fi
  [ -n "$DOMAIN" ] && [ -z "$APP_PORT" ]
}

# app 在本机的监听端口：从 APP_BIND（形如 127.0.0.1:8787 / 0.0.0.0:8080）里取
local_health_port() {
  local bind; bind="$(env_value APP_BIND)"
  printf '%s' "${bind##*:}"
}

# ------------------------------------------------------------
# 起飞前检查
# ------------------------------------------------------------
# 真实 VPS 上最常见的三种失败是：端口被占、防火墙没放行、DNS 没指过来。
# 当前实现里它们分别表现为 compose 报错、Caddy 静默失败、证书反复重试，
# 排查成本都很高。这里提前检查，把问题在动手之前说清楚。
port_in_use() {
  local port="$1"
  have ss || return 1
  ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -qE "[:.]${port}$"
}

check_port_free() {
  local port="$1" who="$2"
  if port_in_use "$port"; then
    warn "端口 ${port} 已被占用（${who}需要）"
    ss -ltnp 2>/dev/null | grep -E "[:.]${port}$" | head -n2 | sed 's/^/      /'
    return 1
  fi
  return 0
}

# ------------------------------------------------------------
# 人性化交互：先检测，再报告，最后让用户选
# ------------------------------------------------------------
# 关键陷阱：`curl … | bash` 时 stdin 是**脚本本身**，
# 普通 read 会把脚本内容当成用户输入吃掉。必须从 /dev/tty 读。
# /dev/tty 不可读（CI、无终端、--yes）时自动退回非交互模式。
can_ask() {
  [ "$ASSUME_YES" -eq 1 ] && return 1
  [ -r /dev/tty ] || return 1
  return 0
}

ask() {
  # $1=提示文案  $2=默认值；结果写入 REPLY（空输入取默认值）
  local prompt="$1" default="$2" answer=""
  printf '  %s' "$prompt" > /dev/tty
  [ -n "$default" ] && printf ' [%s]' "$default" > /dev/tty
  printf ': ' > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  REPLY="${answer:-$default}"
}

port_in_use_pair() {
  local free=1
  port_in_use 80 && free=0
  port_in_use 443 && free=0
  return $(( 1 - free ))
}

interact_mode() {
  # 参数已指定 / 非升级场景已在 resolve_mode 里处理，这里只在「全新安装且未给参数」时提问
  # 走过安装向导后所有选项都已定下来，不再重复问一遍
  [ "$WIZARD_DONE" = "1" ] && return 0
  [ -n "$DOMAIN" ] && return 0
  [ -n "$APP_PORT" ] && return 0
  [ -f "$INSTALL_DIR/.env" ] && return 0

  # ---- 环境报告（无论是否能交互都打印，让用户心里有数）----
  local distro arch ip
  distro=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-未知}") || distro="未知"
  arch="$(uname -m 2>/dev/null || echo '未知')"
  ip="$(detect_ip)"

  echo
  log "环境检查"
  echo "    系统          ${distro} / ${arch}"
  echo "    公网 IP       ${ip}"
  echo "    curl          $(have curl && echo '已安装' || echo '未安装，将自动安装')"
  echo "    Docker        $(docker_ready && echo '已就绪' || echo '未安装，将自动安装')"
  local avail
  avail=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$avail" ] && echo "    可用磁盘      $((avail / 1024)) MB"

  # ---- 端口检测 ----
  local ports_free=1
  port_in_use 80 && ports_free=0
  port_in_use 443 && ports_free=0
  if [ "$ports_free" -eq 1 ]; then
    echo "    端口 80/443   空闲（可启用自动 HTTPS）"
  else
    echo "    端口 80/443   已被占用"
  fi

  can_ask || {
    # 非交互：沿用自动决策，只说明会怎么做
    echo
    if [ "$ports_free" -eq 1 ]; then
      log "非交互模式：未指定域名，将按 IP + 端口部署"
    else
      log "非交互模式：80/443 被占用，将按自定义端口部署"
    fi
    return 0
  }

  echo
  if [ "$ports_free" -eq 1 ]; then
    log "请选择部署方式"
    echo "    1) 域名 + 自动 HTTPS   （推荐；需要域名解析到 ${ip}）"
    echo "    2) IP + 端口           （无需域名，纯 HTTP）"
    ask "选择" "1"

    if [ "$REPLY" = "1" ]; then
      ask "域名（如 blog.example.com，留空则改用 IP + 端口）" ""
      if [ -n "$REPLY" ]; then
        DOMAIN="$REPLY"
        IP_ADDR="$ip"
        log "将部署为 https://${DOMAIN}（自动申请证书）"
        return 0
      fi
      log "未填域名，改用 IP + 端口"
    fi
    APP_PORT="$(pick_free_port)"
    IP_ADDR="$ip"
    log "将部署为 http://${ip}:${APP_PORT}"
    return 0
  fi

  # 80/443 被占用
  log "80/443 已被占用，无法申请 Let's Encrypt 证书"
  echo "    （HTTP-01 验证固定走 80，TLS-ALPN 固定走 443 —— 这是协议限制，不是本项目的限制）"
  echo "    可选：腾出端口后重跑可启用 HTTPS；或继续用自定义端口（纯 HTTP）"
  echo
  ask "自定义端口（留空自动选空闲端口）" ""
  if [ -n "$REPLY" ]; then
    APP_PORT="$REPLY"
  else
    APP_PORT="$(pick_free_port)"
  fi
  IP_ADDR="$ip"
  log "将部署为 http://${ip}:${APP_PORT}（纯 HTTP，登录后台时密码为明文传输）"
}

# 数据库选择：默认 SQLite，但把选择权显式交出来。
# 和部署模式一样，curl|bash 时 stdin 是脚本本身，必须从 /dev/tty 读。
interact_database() {
  # 已用参数指定 → 尊重参数；已部署过 → 不打扰现有配置；走过向导 → 已经问过了
  [ "$WIZARD_DONE" = "1" ] && return 0
  [ -n "$DB_KIND" ] && return 0
  [ -n "$DATABASE_URL_OPT" ] && return 0
  [ -f "$INSTALL_DIR/.env" ] && return 0

  if ! can_ask; then
    log "数据库：默认 SQLite（可用 --db postgres 改用 PostgreSQL，或 --database-url 接自己的云数据库）"
    DB_KIND="sqlite"
    return 0
  fi

  echo
  log "请选择数据库"
  echo "    1) SQLite                  （推荐；零依赖，备份就是一个文件）"
  echo "    2) PostgreSQL · 内置容器    （脚本自动装好，多进程/高并发更稳）"
  echo "    3) PostgreSQL · 我有自己的库 （阿里云 RDS / 腾讯云 / Supabase…）"
  ask "选择" "1"
  case "$REPLY" in
    2)
      DB_KIND="postgres"
      log "将内置 PostgreSQL 容器（端口只在容器网络内开放，不占用宿主机 5432）"
      ;;
    3)
      ask "PostgreSQL 连接串（postgres://用户:密码@主机:5432/库名）" ""
      if [ -z "$REPLY" ]; then
        warn "未填连接串，回退到 SQLite"
        DB_KIND="sqlite"
      else
        DATABASE_URL_OPT="$REPLY"
        DB_KIND="external"
        log "将连接你自己的 PostgreSQL"
      fi
      ;;
    *)
      DB_KIND="sqlite"
      log "将使用 SQLite（数据文件在数据目录里，单文件备份最省心）"
      ;;
  esac
}

# ============================================================
# 安装进度记录（断点续跑）
# ============================================================
# 中途失败（网络断、Docker 装到一半、构建超时）是最常见的挫败点。
# 之前重跑等于从头再来一次，最慢的两步（装 Docker、构建镜像）要重做。
# 这里把「已经做完的步骤」记进安装目录里的小文件，重跑时自动跳过。
state_file()  { printf '%s/.qingyu-install-state' "$INSTALL_DIR"; }
state_has()   { [ -f "$(state_file)" ] && grep -qx "$1" "$(state_file)" 2>/dev/null; }
state_mark()  {
  local f; f="$(state_file)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  if ! grep -qx "$1" "$f" 2>/dev/null; then printf '%s\n' "$1" >> "$f"; fi
}
state_clear() { rm -f "$(state_file)" 2>/dev/null || true; }

# 按步骤执行：$1=步骤代号 $2=步骤名称 其余=要执行的命令
# 已完成 → 只打印「跳过」，不重复做。
run_step() {
  local key="$1" desc="$2"; shift 2
  step_begin "$desc"
  if state_has "$key"; then
    log "这一步上次已经完成，直接跳过（想从头执行请加 --reset）"
    step_end
    return 0
  fi
  "$@"
  state_mark "$key"
  step_end
}

# ============================================================
# 安装向导：一次问答走完全流程
# ============================================================
# 面向第一次用的人：先探测环境，再用大白话问几个问题，每个都给好推荐答案，
# 直接回车就是推荐方案；输入 b 回到上一题，输入 q 放弃。
# 所有问题只在「全新安装 + 能交互」时出现，CI / curl|bash / -y 一律不打扰。
WIZ_STEPS=(access domain db backup mail confirm)

wizard_probe() {
  WIZ_DISTRO="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-未知}")" || WIZ_DISTRO="未知"
  WIZ_ARCH="$(uname -m 2>/dev/null || echo '未知')"
  WIZ_IP="$(detect_ip 2>/dev/null || true)"
  [ -n "$WIZ_IP" ] || WIZ_IP="未探测到（不影响安装）"
  WIZ_DISK="$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}')"
  [ -n "$WIZ_DISK" ] || WIZ_DISK="?"
  if port_in_use 80 || port_in_use 443; then WIZ_PORTS=0; else WIZ_PORTS=1; fi
}

is_valid_domain() {
  local d="$1"
  [ -n "$d" ] || return 1
  [ "${#d}" -le 253 ] || return 1
  case "$d" in
    *[!A-Za-z0-9.-]*) return 1 ;;
    .*|*.|-*|*-|*..*) return 1 ;;
    *.*) ;;
    *) return 1 ;;
  esac
  # 最后一段必须是字母（排除 1.2.3.4 这种纯数字写法）
  case "${d##*.}" in ''|*[!A-Za-z]*) return 1 ;; esac
  return 0
}

wiz_access() {
  # 命令行已经给了 --domain 或 --port → 不再问
  if [ -n "$DOMAIN" ] || [ -n "$APP_PORT" ]; then WIZ_ACT=next; return 0; fi
  echo
  echo "  ── 第 1 问：别人怎么访问你的博客？"
  if [ "$WIZ_PORTS" = "1" ]; then
    echo "    1) 域名 + 自动 HTTPS  【推荐】"
    echo "       需要一个已经解析到本机的域名；证书脚本自动申请、自动续期。"
    echo "    2) IP + 端口"
    echo "       不用域名，地址形如 http://${WIZ_IP}:8080；登录密码明文传输。"
    ask "选 1 还是 2" "1"
    case "$REPLY" in
      2) WIZ_MODE="port" ;;
      *) WIZ_MODE="domain" ;;
    esac
  else
    echo "    检测到本机 80/443 已被占用 —— Let's Encrypt 验证固定走这两个端口，"
    echo "    （这是协议限制，不是本项目的限制），所以只能用自定义端口。"
    echo "    1) 仍然填域名（你有自己的反代、或稍后会腾出端口）"
    echo "    2) 自定义端口访问  【推荐】"
    ask "选 1 还是 2" "2"
    case "$REPLY" in
      1) WIZ_MODE="domain" ;;
      *) WIZ_MODE="port" ;;
    esac
  fi
}

wiz_domain() {
  [ "$WIZ_MODE" = "domain" ] || { WIZ_ACT=next; return 0; }
  [ -n "$DOMAIN" ] && { WIZ_ACT=next; return 0; }
  echo
  echo "  ── 第 2 问：域名是什么？"
  echo "    只写域名本身，不要带 http://，例如 blog.example.com"
  echo "    请确认它已解析到 ${WIZ_IP}（还没解析也可以先填，之后补上即可）"
  local tries=0 d
  while [ $tries -lt 3 ]; do
    ask "域名（留空改用 IP + 端口）" ""
    d="$(printf '%s' "${REPLY:-}" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')"
    if [ -z "$d" ]; then
      WIZ_MODE="port"; log "已改用 IP + 端口"
      WIZ_ACT=next; return 0
    fi
    if is_valid_domain "$d"; then
      DOMAIN="$d"; WIZ_ACT=next; return 0
    fi
    warn "「${d}」不像一个合法域名（示例：blog.example.com）"
    tries=$((tries + 1))
  done
  warn "三次都没填对，先按 IP + 端口 装（之后可随时 upgrade --domain 你的域名 切换）"
  WIZ_MODE="port"
  WIZ_ACT=next
}

wiz_db() {
  if [ -n "$DB_KIND" ] || [ -n "$DATABASE_URL_OPT" ]; then WIZ_ACT=next; return 0; fi
  echo
  echo "  ── 第 3 问：数据存哪里？"
  echo "    1) SQLite  【推荐】"
  echo "       零配置，整个博客就是一个文件，备份最省心，个人博客完全够用。"
  echo "    2) PostgreSQL · 内置容器"
  echo "       脚本自动装好，多进程 / 高并发更稳，多占约 100MB 内存。"
  echo "    3) PostgreSQL · 我自己的库"
  echo "       填连接串（云数据库 / Supabase / 已有的 PostgreSQL）。"
  ask "选 1 / 2 / 3" "1"
  case "$REPLY" in
    2)
      DB_KIND="postgres"
      log "将内置 PostgreSQL 容器（端口只在容器网络内开放，不占宿主机 5432）"
      ;;
    3)
      ask "连接串（postgres://用户:密码@主机:5432/库名）" ""
      if [ -z "${REPLY:-}" ]; then
        warn "没填连接串，改用 SQLite"
        DB_KIND="sqlite"
      else
        DATABASE_URL_OPT="$REPLY"
        DB_KIND="external"
        log "将连接你自己的 PostgreSQL"
      fi
      ;;
    *)
      DB_KIND="sqlite"
      log "将使用 SQLite（数据文件在数据目录里，单文件备份最省心）"
      ;;
  esac
  WIZ_ACT=next
}

wiz_backup() {
  [ "$NO_AUTOBACKUP" = "1" ] && { WIZ_ACT=next; return 0; }
  echo
  echo "  ── 第 4 问：要不要每天自动备份？"
  echo "    1) 要  【推荐】每天自动快照，只保留最近几份，服务器坏了能救回来。"
  echo "    2) 不要，我自己手动备份"
  ask "选 1 还是 2" "1"
  case "$REPLY" in
    2) WIZ_BACKUP=0; WIZ_ACT=next; return 0 ;;
    *) WIZ_BACKUP=1 ;;
  esac
  ask "每天几点备份（HH:MM）" "$AT_TIME"
  if printf '%s' "${REPLY:-}" | grep -qE '^[0-9]{1,2}:[0-9]{2}$'; then
    AT_TIME="$(printf '%02d:%s' "$(printf '%s' "${REPLY%%:*}")" "${REPLY##*:}")"
  else
    warn "时间格式不对，沿用 ${AT_TIME}"
  fi
  ask "保留最近几份" "$KEEP_N"
  if printf '%s' "${REPLY:-}" | grep -qE '^[0-9]+$' && [ "${REPLY:-0}" -ge 1 ]; then
    KEEP_N="$REPLY"
  else
    warn "份数不对，沿用 ${KEEP_N}"
  fi
  WIZ_ACT=next
}

wiz_mail() {
  [ -n "$SMTP_HOST_OPT" ] && { WIZ_ACT=next; return 0; }
  echo
  echo "  ── 第 5 问：配置邮件通知吗？（文章订阅 / 评论提醒）"
  echo "    直接回车跳过 —— 之后随时可以在后台「设置 → 邮件」里配。"
  ask "SMTP 服务器地址（留空跳过）" ""
  [ -z "${REPLY:-}" ] && { WIZ_ACT=next; return 0; }
  SMTP_HOST_OPT="$REPLY"
  ask "SMTP 端口" "587";                            SMTP_PORT_OPT="${REPLY:-587}"
  ask "SMTP 用户名（通常是邮箱地址）" "";             SMTP_USER_OPT="${REPLY:-}"
  ask "SMTP 密码 / 授权码" "";                        SMTP_PASS_OPT="${REPLY:-}"
  ask "发件人地址（如 noreply@example.com）" "$SMTP_USER_OPT"; SMTP_FROM_OPT="${REPLY:-}"
  WIZ_ACT=next
}

# 复核页：把「已经定下来的东西」摆出来，给反悔的机会
wizard_summary() {
  local mode db backup mail
  if [ -n "$DOMAIN" ] && [ -z "$APP_PORT" ]; then
    mode="https://${DOMAIN}（自动 HTTPS 证书）"
  elif [ -n "$DOMAIN" ]; then
    mode="http://${DOMAIN}:${APP_PORT}"
  else
    mode="http://${IP_ADDR:-<自动探测 IP>}:${APP_PORT:-8080}（纯 HTTP）"
  fi
  case "$DB_KIND" in
    postgres) db="PostgreSQL（内置容器）" ;;
    external) db="PostgreSQL（外部：$(printf '%s' "$DATABASE_URL_OPT" | sed -E 's#^[^:]+://[^@]*@##')）" ;;
    *)        db="SQLite（单文件，备份最省心）" ;;
  esac
  if [ "$WIZ_BACKUP" = "1" ]; then
    backup="每天 ${AT_TIME}，保留最近 ${KEEP_N} 份"
  else
    backup="未启用（可随时 $0 autobackup 开启）"
  fi
  if [ -n "$SMTP_HOST_OPT" ]; then mail="${SMTP_HOST_OPT}:${SMTP_PORT_OPT}（发件人 ${SMTP_FROM_OPT:-未填}）"
  else mail="未配置（之后可在后台「设置 → 邮件」里补）"; fi
  echo
  echo "    访问方式    ${mode}"
  echo "    数据库      ${db}"
  echo "    定时备份    ${backup}"
  echo "    邮件通知    ${mail}"
  echo "    安装目录    ${INSTALL_DIR}"
  echo "    代码版本    ${REPO}@${REF}"
  [ -n "$TIMEZONE" ] && echo "    系统时区    ${TIMEZONE}"
  # 必须以 0 结束：上面那行是 `[ ... ] && ...`，条件为假时整条语句返回 1，
  # 函数返回值就变成 1 —— 在 set -e 下会把调用方直接打断（向导走到复核页就静默退出）。
  return 0
}

wiz_confirm() {
  echo
  echo "  ── 最后一步：确认一下"
  wizard_summary
  echo
  echo "    回车 = 开始安装      b = 改上一题"
  echo "    1 = 改访问方式   2 = 改数据库   3 = 改备份   4 = 改邮件     q = 放弃"
  ask "你的选择" ""
  case "${REPLY:-}" in
    q|Q)      die "已放弃安装（随时可以重新运行本脚本）" ;;
    b|B)      WIZ_ACT=back ;;
    1)        WIZ_ACT="jump:0" ;;
    2)        WIZ_ACT="jump:2" ;;
    3)        WIZ_ACT="jump:3" ;;
    4)        WIZ_ACT="jump:4" ;;
    *)        WIZ_ACT=next ;;
  esac
}

run_wizard() {
  wizard_probe
  {
    echo
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │  轻语博客 · 安装向导                                      │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo
    echo "    这台机器：${WIZ_DISTRO} / ${WIZ_ARCH}   可用磁盘 ${WIZ_DISK} MB"
    echo "    公网 IP ：${WIZ_IP}"
    echo
    echo "    接下来几个问题，每个都给好了推荐答案 —— 直接回车就是推荐方案。"
    echo "    输入 b 回到上一题，输入 q 放弃安装。"
  } > /dev/tty 2>/dev/null || true

  local i=0 n=${#WIZ_STEPS[@]}
  WIZ_MODE=""
  while [ "$i" -lt "$n" ]; do
    WIZ_ACT=next
    "wiz_${WIZ_STEPS[$i]}"
    case "$WIZ_ACT" in
      back)   i=$((i - 1)); [ "$i" -lt 0 ] && i=0 ;;
      jump:*) i="${WIZ_ACT#jump:}" ;;
      *)      i=$((i + 1)) ;;
    esac
  done
  WIZARD_DONE=1
  # 「IP + 端口」模式：挑一个空闲端口，别让用户自己猜
  if [ "$WIZ_MODE" = "port" ] && [ -z "$APP_PORT" ]; then
    APP_PORT="$(pick_free_port)"
    log "已选择端口 ${APP_PORT}"
  fi
  [ -n "$IP_ADDR" ] || IP_ADDR="$(detect_ip)"
  log "配置确认完毕，开始安装"
}

# 是否该走向导：全新安装 + 有终端 + 没被显式关掉
wizard_maybe() {
  [ "$NO_WIZARD" = "1" ] && { WIZARD_DONE=0; return 0; }
  can_ask || return 0
  [ -f "$INSTALL_DIR/.env" ] && return 0
  run_wizard
}

# ============================================================
# 演练模式 / 时区 / 配置档导出
# ============================================================
dry_run_report() {
  echo
  echo "  ┌──────────────────────────────────────────────────────────┐"
  echo "  │  演练模式（--dry-run）：只打印将要做什么，不实际执行       │"
  echo "  └──────────────────────────────────────────────────────────┘"
  wizard_summary
  echo
  echo "  将要执行的步骤："
  echo "    1) 检查并准备系统环境（curl / git / Docker）"
  echo "    2) 获取代码：${REPO}@${REF}"
  echo "    3) 生成 ${INSTALL_DIR}/.env（含随机密钥）"
  echo "    4) 起飞前检查（资源 / 端口 / 域名 / 防火墙）"
  echo "    5) 构建镜像并启动容器"
  [ "$WIZ_BACKUP" = "1" ] && echo "    6) 安装定时备份（每天 ${AT_TIME}，保留 ${KEEP_N} 份）"
  echo
  echo "  现在不会做：不装 Docker、不下载代码、不写 .env、不启动容器。"
  echo "  确认无误后去掉 --dry-run 再跑一次即可。"
  return 0
}

apply_timezone() {
  [ -n "$TIMEZONE" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then log "演练：将把系统时区设为 ${TIMEZONE}"; return 0; fi
  if have timedatectl && timedatectl set-timezone "$TIMEZONE" >/dev/null 2>&1; then
    log "已将系统时区设为 ${TIMEZONE}（定时备份按此时间执行）"
  elif [ -f "/usr/share/zoneinfo/$TIMEZONE" ]; then
    if ln -sf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime 2>/dev/null; then
      log "已将系统时区设为 ${TIMEZONE}"
    else
      warn "设置时区失败（需要 root）：${TIMEZONE}"
    fi
  else
    warn "无法设置时区 ${TIMEZONE}：这台机器既没有 timedatectl，也找不到 /usr/share/zoneinfo/${TIMEZONE}"
    warn "常见写法：Asia/Shanghai、Asia/Tokyo、America/New_York、UTC"
  fi
}

# 把向导里补填的邮件 / 时区写进已存在的 .env（.env 是新建的则 ensure_env 已经写好）
env_set() {
  local key="$1" val="$2" f="$INSTALL_DIR/.env"
  [ -f "$f" ] || return 0
  if grep -qE "^${key}=" "$f" 2>/dev/null; then
    # 值里可能含 / 与 &，sed 用 | 做分隔符，并对 & 做转义
    local esc; esc="$(printf '%s' "$val" | sed -e 's/[&|]/\\&/g')"
    sed -i "s|^${key}=.*|${key}=${esc}|" "$f"
  else
    printf '%s=%s\n' "$key" "$val" >> "$f"
  fi
}

apply_env_extras() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  local n=0
  if [ -n "$SMTP_HOST_OPT" ]; then
    env_set SMTP_HOST "$SMTP_HOST_OPT"; n=$((n + 1))
  fi
  [ -n "$SMTP_PORT_OPT" ] && { env_set SMTP_PORT "$SMTP_PORT_OPT"; n=$((n + 1)); }
  [ -n "$SMTP_USER_OPT" ] && { env_set SMTP_USER "$SMTP_USER_OPT"; n=$((n + 1)); }
  [ -n "$SMTP_PASS_OPT" ] && { env_set SMTP_PASS "$SMTP_PASS_OPT"; n=$((n + 1)); }
  [ -n "$SMTP_FROM_OPT" ] && { env_set BLOG_MAIL_FROM "$SMTP_FROM_OPT"; n=$((n + 1)); }
  [ -n "$TIMEZONE" ]      && { env_set TZ "$TIMEZONE"; n=$((n + 1)); }
  [ "$n" -gt 0 ] && log "已把邮件 / 时区配置写入 .env（${n} 项；改完执行 $0 restart 生效）"
  return 0
}

save_config_maybe() {
  [ -n "$SAVE_CONFIG" ] || return 0
  local f="$SAVE_CONFIG"
  cat > "$f" <<EOF
# 轻语博客部署配置档 —— 由 deploy/install.sh 于 $(date -u +"%Y-%m-%dT%H:%M:%SZ") 生成
# 用法： bash deploy/install.sh install --config $f
# 命令行参数优先于本文件；本文件只补命令行没给的项。
DOMAIN=$DOMAIN
PORT=$APP_PORT
DB=$DB_KIND
DATABASE_URL=$DATABASE_URL_OPT
DIR=$INSTALL_DIR
REF=$REF
REPO=$REPO
EMAIL=$EMAIL
TIMEZONE=$TIMEZONE
SMTP_HOST=$SMTP_HOST_OPT
SMTP_PORT=$SMTP_PORT_OPT
SMTP_USER=$SMTP_USER_OPT
SMTP_PASS=$SMTP_PASS_OPT
SMTP_FROM=$SMTP_FROM_OPT
MIRROR=${MIRROR:-0}
KEEP=$KEEP_N
AT=$AT_TIME
AUTOBACKUP=$WIZ_BACKUP
EOF
  chmod 600 "$f" 2>/dev/null || true
  log "配置档已保存到 ${f}（含 SMTP 密码，权限已设为 600）"
  echo "    下次复用： bash deploy/install.sh install --config ${f}"
}

# ============================================================
# 安装后引导 + 自动体检
# ============================================================
post_install_guide() {
  local site_url key
  site_url="$(env_value SITE_URL)"
  [ -n "$site_url" ] || site_url="http://localhost:$(local_health_port)"
  key="$(env_value BLOG_ADMIN_SETUP_KEY)"
  echo
  echo "  ┌──────────────────────────────────────────────────────────┐"
  echo "  │  接下来三件事                                            │"
  echo "  └──────────────────────────────────────────────────────────┘"
  echo
  echo "    1) 打开 ${site_url}"
  echo "       首次打开可能要等十几秒（容器正在初始化数据库）"
  echo
  echo "    2) 打开 ${site_url}/admin 设置管理员密码"
  if [ -n "$key" ]; then
    echo "       安装密钥：${key}"
    echo "       （已存在 .env 里，忘了随时跑 $0 info 查看）"
  fi
  echo "       设完密码后，到「设置 → 站点」把站名、简介改成你自己的"
  echo
  echo "    3) 确认 SITE_URL 是真实域名"
  echo "       现在是 ${site_url}"
  echo "       如果是 localhost / 内网 IP，改 ${INSTALL_DIR}/.env 里的 SITE_URL 后执行 $0 restart"
  echo
  echo "  出问题先跑： $0 doctor        （Docker / 容器 / 端口 / 证书 / 磁盘逐项检查）"
  echo "  看实时日志： $0 logs"
  echo
  if [ "$SKIP_DOCTOR" = "1" ]; then
    log "已跳过自动体检（--no-doctor）"
    return 0
  fi
  log "正在做一次自动体检…"
  cmd_doctor || true
}

# ------------------------------------------------------------
# 傻瓜式：自动决定部署模式
# ------------------------------------------------------------
# 原则：能满足 HTTPS 条件就上 HTTPS；不满足就自动降级为「自定义端口 + 纯 HTTP」，
# **绝不因为端口或 DNS 问题中止安装**。用户不需要理解这些取舍，
# 脚本自己选好并在最后说清楚为什么。
pick_free_port() {
  local p
  for p in 8080 8081 8082 8088 8090 8095 3000; do
    if ! port_in_use "$p"; then printf '%s' "$p"; return 0; fi
  done
  printf '%s' 8080
}

resolve_mode() {
  # 升级场景：没给任何参数且已有 .env → 沿用原有模式，不擅自改动线上配置
  if [ -z "$DOMAIN" ] && [ -z "$APP_PORT" ] && [ -f "$INSTALL_DIR/.env" ]; then
    return 0
  fi

  # 无域名 → 一定是 IP + 端口模式，自动挑一个空闲端口
  if [ -z "$DOMAIN" ]; then
    [ -n "$APP_PORT" ] || APP_PORT="$(pick_free_port)"
    return 0
  fi

  # 用户显式指定了端口 → 尊重选择，走 HTTP 模式
  [ -n "$APP_PORT" ] && return 0

  # 有域名且未指定端口 → 检查 HTTPS 的两个前提条件
  local conflict=0
  port_in_use 80 && conflict=1
  port_in_use 443 && conflict=1

  local resolved dns_ok=1
  resolved=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1)
  [ -n "$resolved" ] || dns_ok=0

  if [ "$conflict" -eq 0 ] && [ "$dns_ok" -eq 1 ]; then
    return 0   # 两个条件都满足，走自动 HTTPS
  fi

  # 自动降级并把原因记下来，供摘要展示
  APP_PORT="$(pick_free_port)"
  DOWNGRADE_REASON=""
  [ "$conflict" -eq 1 ] && DOWNGRADE_REASON="端口 80/443 已被占用"
  if [ "$dns_ok" -eq 0 ]; then
    DOWNGRADE_REASON="${DOWNGRADE_REASON:+${DOWNGRADE_REASON}；}域名 ${DOMAIN} 尚未解析到本机"
  fi
  DOWNGRADED_DOMAIN="$DOMAIN"
}

# ----------------------------------------------------------
# 防火墙：检测到 ufw / firewalld 就问一句，同意就代为放行
# ----------------------------------------------------------
# 只做「放行端口」这一件事：不改默认策略、不关防火墙、不动用户已有规则。
# CI / -y 这类不能提问的场合，退回旧行为——只打印该执行的命令。
# 云控制台的安全组是另一层，本机管不了，由 summary / doctor 另外提醒。
ensure_firewall_open() {
  local ports=() p
  # 端口可能来自 --port，也可能只写在 .env 里（升级 / 二次配置场景）
  if [ -z "${APP_PORT:-}" ]; then
    local bind; bind="$(env_value APP_BIND 2>/dev/null || true)"
    APP_PORT="${bind##*:}"
  fi
  if uses_caddy; then
    ports=(80 443)
  elif [ -n "${APP_PORT:-}" ]; then
    ports=("$APP_PORT")
  fi
  [ "${#ports[@]}" -gt 0 ] || return 0

  # ---------- ufw（Ubuntu / Debian 常见） ----------
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    local status need=()
    status="$($SUDO ufw status 2>/dev/null || true)"
    for p in "${ports[@]}"; do
      printf '%s\n' "$status" | grep -qE "^${p}/tcp[[:space:]]+ALLOW" || need+=("$p")
    done
    if [ "${#need[@]}" -eq 0 ]; then
      log "本机防火墙（ufw）已放行端口 ${ports[*]}/tcp"
      return 0
    fi
    echo
    log "检测到 ufw 防火墙已启用，外网访问需要放行：${need[*]}/tcp"
    if can_ask; then
      ask "自动放行这些端口（只新增规则，不动其它设置）" "1"
      case "$REPLY" in
        1|y|Y|yes|YES)
          for p in "${need[@]}"; do
            if $SUDO ufw allow "${p}/tcp" >/dev/null 2>&1; then
              log "已放行 ${p}/tcp"
            else
              warn "放行 ${p}/tcp 失败，请手动执行：ufw allow ${p}/tcp"
            fi
          done
          # Caddy 的 HTTP/3 走 UDP 443，顺手放行（失败不影响主流程）
          if uses_caddy && ! printf '%s\n' "$status" | grep -qE '^443/udp[[:space:]]+ALLOW'; then
            if $SUDO ufw allow 443/udp >/dev/null 2>&1; then
              log "已放行 443/udp（HTTP/3，可选）"
            fi
          fi
          ;;
        *)
          warn "没有自动放行；以后需要时执行：ufw allow <端口>/tcp"
          ;;
      esac
    else
      warn "非交互模式：请手动放行 ufw，否则外网可能打不开："
      for p in "${need[@]}"; do warn "    ufw allow ${p}/tcp"; done
    fi
    return 0
  fi

  # ---------- firewalld（CentOS / RHEL / Fedora 常见） ----------
  if have firewall-cmd && firewall-cmd --state 2>/dev/null | grep -q running; then
    local items=() it need_txt=""
    if uses_caddy; then
      local svcs; svcs="$($SUDO firewall-cmd --list-services 2>/dev/null || true)"
      printf '%s\n' "$svcs" | grep -qw http  || { items+=("service:http");  need_txt="$need_txt http"; }
      printf '%s\n' "$svcs" | grep -qw https || { items+=("service:https"); need_txt="$need_txt https"; }
    else
      local listed; listed="$($SUDO firewall-cmd --list-ports 2>/dev/null || true)"
      if ! printf '%s\n' "$listed" | grep -qE "(^| )${APP_PORT}/tcp( |$)"; then
        items+=("port:${APP_PORT}/tcp")
        need_txt="$need_txt ${APP_PORT}/tcp"
      fi
    fi
    if [ "${#items[@]}" -eq 0 ]; then
      log "本机防火墙（firewalld）已放行所需端口/服务：${ports[*]}${need_txt}"
      return 0
    fi
    echo
    log "检测到 firewalld 防火墙已启用，外网访问需要放行：${need_txt# }"
    if can_ask; then
      ask "自动放行这些服务/端口（只新增规则，不动其它设置）" "1"
      case "$REPLY" in
        1|y|Y|yes|YES)
          local okf=1
          for it in "${items[@]}"; do
            case "$it" in
              service:*) $SUDO firewall-cmd --permanent --add-service="${it#service:}" >/dev/null 2>&1 || okf=0 ;;
              port:*)    $SUDO firewall-cmd --permanent --add-port="${it#port:}" >/dev/null 2>&1 || okf=0 ;;
            esac
          done
          $SUDO firewall-cmd --reload >/dev/null 2>&1 || okf=0
          if [ "$okf" = "1" ]; then
            log "已放行：${need_txt# }"
          else
            warn "放行没成功，请手动执行：firewall-cmd --permanent --add-port=<端口>/tcp && firewall-cmd --reload"
          fi
          ;;
        *)
          warn "没有自动放行；以后需要时用 firewall-cmd --permanent --add-port=<端口>/tcp"
          ;;
      esac
    else
      warn "非交互模式：请手动放行 firewalld，否则外网可能打不开："
      for it in "${items[@]}"; do
        case "$it" in
          service:*) warn "    firewall-cmd --permanent --add-service=${it#service:}" ;;
          port:*)    warn "    firewall-cmd --permanent --add-port=${it#port:}" ;;
        esac
      done
      warn "    firewall-cmd --reload"
    fi
    return 0
  fi

  # 没启用本机防火墙（ufw / firewalld 都没跑）→ 什么都不用做
  return 0
}


# 起飞前的资源体检：CPU / 内存 / 磁盘 / swap
# 目的不是刁难用户，而是「装之前就告诉他这机器跑不跑得动」，
# 免得镜像构建到一半 OOM，或者装完打开页面一片空白。
check_resources() {
  local cores mem_total_kb mem_avail_mb swap_mb warned=0

  cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo '')"
  mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  [ -n "$mem_total_kb" ] || mem_total_kb="$(free -k 2>/dev/null | awk '/^Mem:/ {print $2}')"
  mem_avail_mb="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')"
  swap_mb="$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}')"

  # 一行小结，让人一眼看到这台机器的底子
  local mem_desc="未知"
  [ -n "$mem_total_kb" ] && mem_desc="$((mem_total_kb / 1024)) MB"
  printf '    CPU %s 核 · 内存 %s · 可用内存 %s\n' "${cores:-?}" "$mem_desc" "${mem_avail_mb:-?} MB"

  if [ -n "$cores" ] && [ "$cores" -lt 1 ]; then
    warn "检测不到 CPU 核心数，Docker 构建可能异常"
    warned=1
  fi

  if [ -n "$mem_total_kb" ]; then
    if [ "$mem_total_kb" -lt 524288 ]; then
      warn "内存只有 $((mem_total_kb / 1024)) MB，跑不动 Docker 构建（至少需要 512 MB，建议 1 GB）"
      warned=1
    elif [ "$mem_total_kb" -lt 1048576 ]; then
      warn "内存 $((mem_total_kb / 1024)) MB 偏小，构建镜像时可能被杀进程（OOM）"
      warn "  两个省内存的办法：① 用现成镜像 --image ghcr.io/kejiland/qingyu-universal:v0.8.0（不本地构建）"
      warn "                   ② 先在本地构建好镜像再传上来"
      warned=1
    fi
    # 内存小又没有 swap：构建时更容易被 OOM Killer 直接干掉
    if [ "$mem_total_kb" -lt 1048576 ] && [ "${swap_mb:-0}" -eq 0 ]; then
      warn "并且没有 swap 缓冲区，构建更容易被系统 OOM 杀掉"
      warn "  加 1G swap（不需要重启）："
      warn "    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
      warn "    echo '/swapfile swap swap defaults 0 0' >> /etc/fstab"
    fi
  fi

  # 磁盘：/var/lib 是 Docker 的地盘，装 Docker 之前先看它
  local avail_kb
  avail_kb="$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  [ -n "$avail_kb" ] || avail_kb="$(df -Pk "$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [ -n "$avail_kb" ]; then
    if [ "$avail_kb" -lt 2097152 ]; then
      warn "磁盘可用空间不足 2GB（当前 $((avail_kb / 1024)) MB），装 Docker 和镜像都会失败"
      warned=1
    elif [ "$avail_kb" -lt 5242880 ]; then
      warn "磁盘可用 $((avail_kb / 1024)) MB，够用但不宽裕（以后备份、镜像会占地方）"
      warned=1
    fi
  fi

  if [ "$warned" -eq 1 ]; then
    log "  资源偏紧仍然可以继续；如果构建失败，试试上面提到的 --image 方式"
  fi
}

preflight() {
  local ok=1
  log "起飞前检查…"

  check_resources || true

  # 磁盘：镜像 + 依赖大约需要 1GB，留 2GB 余量避免构建到一半失败
  local avail
  avail=$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$avail" ] || avail=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$avail" ] && [ "$avail" -lt 2097152 ]; then
    warn "磁盘可用空间不足 2GB（当前约 $((avail / 1024)) MB），构建镜像可能失败"
    ok=0
  fi

  # 端口：可能来自 --port，也可能来自已存在的 .env（此时 ensure_env 已提前返回）
  if [ -z "$APP_PORT" ]; then
    local bind; bind="$(env_value APP_BIND)"
    APP_PORT="${bind##*:}"
  fi
  [ -n "$APP_PORT" ] || APP_PORT=8080

  if uses_caddy; then
    # resolve_mode 已确保两个端口空闲，这里只是复核
    check_port_free 80 "Caddy 的 HTTP（证书签发也需要）" || ok=0
    check_port_free 443 "Caddy 的 HTTPS" || ok=0
  else
    # 端口是 resolve_mode 挑出来的；若此刻被抢占，换一个再继续（不中止）
    if port_in_use "$APP_PORT"; then
      warn "端口 $APP_PORT 在安装过程中被占用，自动改用新端口"
      APP_PORT="$(pick_free_port)"
      log "  改用端口 $APP_PORT"
    fi
  fi

  # DNS：域名没指过来时 Caddy 会反复重试，表现是「HTTPS 打不开但日志不直观」
  if [ -n "$DOMAIN" ]; then
    local resolved
    resolved=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1)
    if [ -z "$resolved" ]; then
      warn "域名 ${DOMAIN} 解析不出来 —— Let's Encrypt 签发证书会失败"
      warn "请先添加 A 记录指向本机公网 IP，再重新执行"
      ok=0
    else
      log "  ${DOMAIN} 解析到 ${resolved}"
    fi
  else
    log "  无域名模式：应用监听 0.0.0.0:${APP_PORT}"
  fi

  # 防火墙：检测到就问一句，同意则自动放行（非交互时只打印命令）
  ensure_firewall_open

  if [ "$ok" -ne 1 ]; then
    die "起飞前检查未通过，已中止（避免装到一半才失败）"
  fi
  log "起飞前检查通过"
}

compose() {
  cd "$INSTALL_DIR"
  if [ -n "$IMAGE" ]; then export QINGYU_IMAGE="$IMAGE"; fi
  ${DOCKER:-docker} compose "$@"
}

wait_healthy() {
  log "等待服务就绪…"
  local i=0 port
  port="$(local_health_port)"
  while [ $i -lt 60 ]; do
    # 只认 app 这一个容器：`compose ps` 不带服务名会把 postgres/redis/caddy
    # 的 healthy 也算进来，数据库刚起来时会误判成「应用已就绪」。
    if ${DOCKER:-docker} compose ps app --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
      log "服务已健康"
      return 0
    fi
    # 最终以应用自己应答为准：/healthz 通了才代表迁移跑完、数据库连上了
    if [ -n "$port" ] && curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log "服务已响应"
      return 0
    fi
    i=$((i + 1)); sleep 3
  done
  warn "等待超时，请查看日志：docker compose logs -f app"
  return 0
}

summary() {
  # 以 .env 的 SITE_URL 为准：两种模式（域名 / IP+端口）共用同一段输出
  local site_url; site_url="$(env_value SITE_URL)"
  [ -n "$site_url" ] || site_url="http://localhost:8787"
  echo
  echo "  ┌──────────────────────────────────────────────────────────┐"
  echo "  │  轻语博客 · 自托管通用版 部署完成                          │"
  echo "  └──────────────────────────────────────────────────────────┘"
  echo
  echo "    访问地址    ${site_url}"
  echo "    管理后台    ${site_url}/admin"
  echo "    安装目录    ${INSTALL_DIR}"
  local db_url; db_url="$(env_value DATABASE_URL)"
  if [ -n "$db_url" ]; then
    local db_host; db_host="$(printf '%s' "$db_url" | sed -E 's#^[^:]+://[^@]*@([^/:]+).*#\1#')"
    if [ -n "$DATABASE_URL_OPT" ] || [ "$DB_KIND" = "external" ]; then
      echo "    数据库      PostgreSQL（外部）${db_host}"
    else
      echo "    数据库      PostgreSQL（内置容器）${db_host}"
    fi
    echo "    数据目录    ${INSTALL_DIR}/data（上传 + 备份；数据库在 PostgreSQL 卷里）"
  else
    echo "    数据库      SQLite（${INSTALL_DIR}/data/qingyu.db）"
    echo "    数据目录    ${INSTALL_DIR}/data（SQLite + 上传 + 备份）"
  fi
  echo
  if [ -n "${SETUP_KEY_SHOWN:-}" ]; then
    echo "    初始化密钥  ${SETUP_KEY_SHOWN}"
    echo "                （首次打开 /admin 时填写，已保存在 .env 的 BLOG_ADMIN_SETUP_KEY）"
  else
    echo "    初始化密钥  见 ${INSTALL_DIR}/.env 中的 BLOG_ADMIN_SETUP_KEY"
  fi
  echo
  echo "    常用操作："
  echo "      docker compose -f ${INSTALL_DIR}/compose.yaml logs -f app"
  echo "      ${INSTALL_DIR}/deploy/install.sh upgrade"
  echo "      ${INSTALL_DIR}/deploy/install.sh backup"
  echo "      ${INSTALL_DIR}/deploy/install.sh info      # 随时查看访问地址、初始化密钥和版本"
  echo
  if has_profile domain "$(env_value COMPOSE_PROFILES)"; then
    echo "    已启用自动 HTTPS。证书首次签发通常需要十几秒，可通过 deploy/install.sh logs 查看。"
  else
    echo "    当前为纯 HTTP 模式（未启用 Caddy / 无证书）。"
    if [ -n "${DOWNGRADE_REASON:-}" ]; then
      echo
      echo "    未能启用自动 HTTPS 的原因：${DOWNGRADE_REASON}"
      echo "    已自动改用端口 ${APP_PORT:-$(local_health_port)} 继续部署，无需你处理。"
      echo "    条件具备后可一条命令切换："
      echo "      ./deploy/install.sh upgrade --domain ${DOWNGRADED_DOMAIN:-your.domain.com}"
    fi
    echo
    echo "    ⚠ 注意：此模式下管理后台的登录密码是明文传输的。"
    echo "      若在公共网络登录后台，建议改为下面任一方式："
    echo "        · 让出 80/443 后重新部署：./deploy/install.sh upgrade --domain your.domain.com"
    echo "        · 用现有 Web 服务器反代（可继续用它的证书），见 README「与现有 Web 服务器共存」"
    echo "        · 端口被上游封禁时，用反向隧道（Cloudflare Tunnel / Tailscale Funnel）对外提供 HTTPS"
  fi
  echo
}

# ---------- 各子命令 ----------
# 每一步都拆成独立函数，配合 run_step 才能「失败后重跑只补没做的部分」
install_step_sysenv() {
  resolve_docker
  resolve_mirror
  ensure_curl
  ensure_git
  install_docker
  configure_registry_mirror
}
install_step_source() { fetch_source; }
install_step_config() { ensure_env; persist_mirror_env; apply_env_extras; }
install_step_preflight() { preflight; }
install_step_build() {
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "构建并启动容器…（版本 $BUILD_REVISION）"
  compose up -d --build
  wait_healthy
}

cmd_install() {
  STEP_TOTAL=6
  need_root

  # 已经完整装过 → 直接转升级，避免重复构建把线上配置顶掉
  if [ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/compose.yaml" ] \
     && state_has build && [ "$RESET_STATE" != "1" ]; then
    log "检测到 ${INSTALL_DIR} 已经安装完成，自动改为执行升级"
    log "（想推倒重来： $0 install --reset -- 会保留 .env 与数据，只重跑安装流程）"
    cmd_upgrade
    return 0
  fi
  if [ "$RESET_STATE" = "1" ]; then
    state_clear
    log "已清除安装进度记录，本次从头执行"
  fi

  prepare_install_dir
  # 向导要用 detect_ip，得先有 curl；演练模式下不装任何东西
  [ "$DRY_RUN" = "1" ] || ensure_curl

  # 第 1 步：把选项一次性问清楚（向导）或沿用默认值
  step_begin "确认安装选项"
  if [ "$DRY_RUN" = "1" ] && [ "$WIZARD_FORCE" != "1" ] && ! can_ask; then
    log "演练模式：不提问，使用默认值"
  else
    wizard_maybe
  fi
  interact_mode
  interact_database
  resolve_mode
  resolve_database
  # 非交互 / 向导都没设 IP 时补一次探测，否则演练摘要里只能显示占位符
  if [ -z "$DOMAIN" ] && [ -z "$IP_ADDR" ]; then IP_ADDR="$(detect_ip)"; fi
  step_end

  apply_timezone

  # 演练到此为止：后面的步骤才会真正改动系统
  if [ "$DRY_RUN" = "1" ]; then
    STEP_TOTAL=0
    dry_run_report
    save_config_maybe
    return 0
  fi

  run_step sysenv    "检查并准备系统环境（curl / git / Docker）"  install_step_sysenv
  run_step source    "获取博客代码"                              install_step_source
  run_step config    "生成配置文件（.env）"                       install_step_config
  if [ "$SKIP_PREFLIGHT" = "1" ]; then
    log "已跳过起飞前检查（--skip-preflight）"
  else
    run_step preflight "起飞前检查（资源 / 端口 / 域名 / 防火墙）" install_step_preflight
  fi
  run_step build     "构建镜像并启动服务"                         install_step_build

  # 进度记录**保留**：下次再跑 install 会被上面的路由送到 upgrade，
  # 不会重复走一遍完整安装流程（想推倒重来用 --reset）。
  save_config_maybe

  # 向导里选了自动备份 → 立刻装上
  if [ "$WIZ_BACKUP" = "1" ]; then
    log "安装定时备份（每天 ${AT_TIME}，保留最近 ${KEEP_N} 份）"
    cmd_autobackup || warn "定时备份安装失败，可稍后手动执行：$0 autobackup"
  fi

  STEP_TOTAL=0
  summary
  post_install_guide
}

# 升级前先把「从哪个版本升到哪个版本」说清楚，中间隔了多少个提交也一并列出
show_version_diff() {
  local after
  after="$(resolve_revision)"
  if [ -z "${UPGRADE_FROM:-}" ] || [ -z "$after" ]; then
    [ -n "$after" ] && log "当前版本：$after"
    return 0
  fi
  if refs_equal "$UPGRADE_FROM" "$after"; then
    log "版本未变化：$after（已经是最新的代码）"
    return 0
  fi
  echo
  log "版本变化：${UPGRADE_FROM} → ${after}"
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    local n
    n="$(git -C "$INSTALL_DIR" rev-list --count "${UPGRADE_FROM}..HEAD" 2>/dev/null || true)"
    case "$n" in ''|*[!0-9]*) n="" ;; esac
    [ -n "$n" ] && echo "    新增 ${n} 个提交"
    git -C "$INSTALL_DIR" log --oneline --no-decorate "${UPGRADE_FROM}..HEAD" 2>/dev/null \
      | head -n 8 | sed 's/^/      /' || true
  fi
  echo
  return 0
}

cmd_upgrade() {
  STEP_TOTAL=4
  need_root

  step_begin "检查系统环境与网络加速"
  resolve_docker
  resolve_mirror
  configure_registry_mirror
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  ensure_git
  # 记下升级前的版本，拉完代码后好对比
  UPGRADE_FROM="$(resolve_revision)"
  step_end

  apply_timezone

  step_begin "拉取最新代码并备份当前数据"
  update_source
  show_version_diff
  resolve_mode
  persist_mirror_env
  apply_env_extras
  # 先备份，再升级
  backup_now || warn "升级前备份失败，继续升级"
  step_end

  step_begin "重建容器并等待服务就绪"
  # 注入构建版本（git 短 SHA），让 /healthz 能回答「升级到底生效没有」
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "重建容器…（版本 $BUILD_REVISION）"
  compose pull --ignore-pull-failures 2>/dev/null || true
  compose up -d --build
  wait_healthy
  step_end

  step_begin "复查防火墙放行"
  ensure_firewall_open
  step_end

  STEP_TOTAL=0
  log "升级完成（版本 $BUILD_REVISION）"
}

# ---------- 日常运维：启动 / 停止 / 重启 / 回滚 ----------
cmd_start() {
  need_root
  resolve_docker
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  log "启动服务…"
  compose up -d
  wait_healthy
  log "已启动：$(env_value SITE_URL)"
}

cmd_stop() {
  need_root
  resolve_docker
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  log "停止服务（配置与数据全部保留）…"
  compose stop
  log "已停止。重新启动：$0 start"
}

cmd_restart() {
  need_root
  resolve_docker
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  log "重启应用（改完 .env 后用它生效）…"
  compose restart app
  wait_healthy
  log "已重启：$(env_value SITE_URL)"
}

# 回滚到「上一次升级之前」的代码版本。
# 两种安装形态都支持：
#   · git 检出 → 本地 reset（不联网）
#   · 压缩包   → 按版本号重新下载那个历史代码包
# 注意：只回滚代码，数据库表结构不会自动倒退 —— 所以先备份。
cmd_rollback() {
  need_root
  resolve_docker
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"

  local prev cur
  prev="$(read_ref_file "$(prev_ref_file)")"
  [ -n "$prev" ] || die "还没有可回滚的版本记录。
  提示：这份安装升级过一次之后才会生成记录。
  如果你从未执行过 upgrade，先运行一次：$0 upgrade"

  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    cur="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  else
    cur="$(read_ref_file "$(cur_ref_file)")"
  fi
  if [ -n "$cur" ] && refs_equal "$cur" "$prev"; then
    die "当前已经是记录中的版本 $(printf '%.7s' "$prev")，无需回滚"
  fi
  [ -n "$cur" ] || warn "未记录当前版本号，回滚后将无法一键滚回（建议回滚前先 backup）"

  # 升级时数据库已经迁移过，回滚代码不会把表结构退回去，先留个快照
  backup_now || warn "备份失败，继续回滚 —— 请自行确认数据安全"

  warn "准备把代码回滚到 $(printf '%.7s' "$prev")${cur:+（当前 $(printf '%.7s' "$cur")）}。"
  warn "数据库表结构保持现状，不会自动回退；回滚后若报错，可用 restore 恢复快照。"
  if [ "$ASSUME_YES" != "1" ]; then
    if [ ! -r /dev/tty ]; then
      die "当前不是交互环境，确认无误后加 -y 执行：$0 rollback -y"
    fi
    ask "确认回滚？" "n"
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) die "已取消回滚" ;;
    esac
  fi

  # 先把「回滚前」的版本记下来，回滚完还能再滚回去
  [ -n "$cur" ] && remember_prev_ref "$cur"
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    git -C "$INSTALL_DIR" reset --hard "$prev" >/dev/null
    remember_cur_ref "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  else
    download_source "$prev"
  fi
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "回滚到 ${BUILD_REVISION}，重建容器…"
  compose up -d --build
  wait_healthy
  log "回滚完成（版本 $BUILD_REVISION）。再执行一次 rollback 可回到回滚前的版本。"
}

cmd_backup() {
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  compose exec -T app node dist/cli/backup.js /data/backups
}

# ----------------------------------------------------------
# 备份：快照 + 清理旧文件 + 定时备份（systemd timer）
# ----------------------------------------------------------

# 快照都在容器内 /data/backups（宿主机的 docker 数据卷里）
# 列出快照文件名（新 → 旧），只认 .db
list_backups() {
  compose exec -T app sh -c 'ls -1t /data/backups 2>/dev/null' 2>/dev/null | grep -E '\.db$' || true
}

# 只保留最近 $1 份快照（默认 7）。容器没跑时只提示、不报错。
prune_backups() {
  local keep="${1:-7}" n=0 f total
  case "$keep" in (''|*[!0-9]*) keep=7 ;; esac
  [ "$keep" -gt 0 ] || return 0
  total="$(list_backups | wc -l | tr -d ' ')"
  [ -n "$total" ] || return 0
  if [ "$total" -le "$keep" ]; then
    log "当前共 ${total} 份快照，未超过保留上限（${keep} 份），无需清理"
    return 0
  fi
  log "清理旧快照：保留最近 ${keep} 份，共 ${total} 份"
  while IFS= read -r f; do
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    if ${DOCKER:-docker} exec qingyu-app rm -f "/data/backups/$f"; then
      log "    已删除旧快照 $f"
    else
      warn "    删除失败（容器可能已停止）：$f"
      return 0
    fi
  done <<EOF
$(list_backups)
EOF
}

# 立刻备份一次 + 清理旧快照。autobackup 的 systemd 也调用 backup --keep。
backup_now() {
  cmd_backup
  prune_backups "${1:-$KEEP_N}"
}

# 数据卷名字（qingyu-data）。
# 优先问「正在跑的容器」——它的挂载信息最准；
# 容器没起来时再按名字找，并且只在唯一匹配时才敢用，
# 否则宁可报错让你手动确认，也绝不猜错卷把别人的数据删了。
data_volume_name() {
  local v matches
  v="$(${DOCKER:-docker} inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' qingyu-app 2>/dev/null | head -n1)"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi

  matches="$(${DOCKER:-docker} volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)qingyu-data$' || true)"
  case "$matches" in
    '') printf '' ;;
    *"
"*) return 1 ;;   # 多个候选：无法确定，交给调用方报错
    *) printf '%s' "$matches" ;;
  esac
}

# 定时备份：优先 systemd timer，没有 systemd 退回 cron，再没有就打印命令
cmd_autobackup() {
  need_root
  resolve_docker
  [ -f "$INSTALL_DIR/.env" ] || die "未找到 $INSTALL_DIR/.env —— 这个目录还没有部署过？"

  local timer_unit="qingyu-backup.timer" service_unit="qingyu-backup.service"
  local script_path="$INSTALL_DIR/deploy/install.sh"
  [ -f "$script_path" ] || die "找不到 $script_path（$INSTALL_DIR 是不是完整的安装目录？）"

  # ---- 关闭 ----
  if [ "$AUTOBACKUP_OFF" = "1" ]; then
    log "关闭定时备份…"
    if have systemctl; then
      systemctl disable --now "$timer_unit" >/dev/null 2>&1 || true
      rm -f "/etc/systemd/system/$timer_unit" "/etc/systemd/system/$service_unit"
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if have crontab; then
      crontab -l 2>/dev/null | grep -v 'qingyu-backup' | crontab - 2>/dev/null || true
    fi
    log "已关闭定时备份（手动备份仍然可用：$0 backup）"
    return 0
  fi

  # ---- 参数校验 ----
  case "$KEEP_N" in (''|*[!0-9]*) KEEP_N=7 ;; esac
  # 允许用户写 3:30 这种简写，补零后校验范围（只查格式的话 systemd 会报 bad unit file）
  if [[ "$AT_TIME" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then
    AT_TIME="$(printf '%02d:%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")"
  fi
  case "$AT_TIME" in
    [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;;
    *) die "时间要写成 00:00-23:59 之间的 HH:MM，例如 03:30（你写的是：$AT_TIME）" ;;
  esac
    case "$AT_TIME" in
    [0-9][0-9]:[0-9][0-9]) ;;
    *) die "时间格式不对：$AT_TIME —— 请写成 HH:MM，例如 03:30" ;;
  esac

  chmod +x "$script_path" 2>/dev/null || true
  log "设置定时备份：每天 ${AT_TIME} 执行，保留最近 ${KEEP_N} 份"

  if have systemctl && [ -d /run/systemd/system ]; then
    cat > "/etc/systemd/system/$service_unit" <<EOF
[Unit]
Description=Qingyu blog data backup
# Docker 服务通常由 docker.service 提供，但用 Requires 会让没装 systemd 单元的环境直接失败
After=docker.service
# 只做顺序提示，不 Requires：Docker Desktop / 精简镜像没有 docker.service 也能跑

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $script_path backup --keep $KEEP_N
EOF
    cat > "/etc/systemd/system/$timer_unit" <<EOF
[Unit]
Description=Qingyu blog daily backup

[Timer]
OnCalendar=*-*-* ${AT_TIME}:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$timer_unit" >/dev/null
    log "已启用 systemd 定时器：systemctl list-timers | grep qingyu"
    echo
    echo "  下次执行时间："
    systemctl list-timers "$timer_unit" --no-pager 2>/dev/null | sed -n '1,3p' || true
  elif have crontab; then
    local hh="${AT_TIME%%:*}" mm="${AT_TIME##*:}"
    { crontab -l 2>/dev/null | grep -v 'qingyu-backup' || true
      echo "${mm} ${hh} * * * $script_path backup --keep $KEEP_N >/dev/null 2>&1 # qingyu-backup"
    } | crontab -
    log "这台机器没有 systemd，已改用 crontab：每天 ${AT_TIME}（crontab -l 可查看）"
  else
    warn "这台机器既没有 systemd 也没有 cron，无法自动定时。"
    warn "请在外部定时任务里调用：$script_path backup --keep $KEEP_N"
    return 0
  fi

  echo
  echo "  常用操作："
  echo "    systemctl list-timers | grep qingyu      # 看下次执行时间"
  echo "    systemctl start qingyu-backup.service   # 立刻跑一次"
  echo "    $0 autobackup --off                      # 关闭定时备份"
  echo "    $0 autobackup --at 05:00 --keep 14      # 改时间 / 改保留份数"
  echo "    $0 backup                                # 手动备份一次"
  echo
}

# ----------------------------------------------------------
# 迁移：把 .env + 整个数据卷打成一个 tar.gz，拷到新服务器一键恢复
# ----------------------------------------------------------
cmd_migrate() {
  need_root
  resolve_docker
  [ -f "$INSTALL_DIR/.env" ] || die "未找到 $INSTALL_DIR/.env —— 这个目录还没有部署过？"

  local ts vol img out staging size db_label
  ts="$(date +%Y%m%d-%H%M%S)"
  vol="$(data_volume_name)"
    if [ -z "$vol" ]; then
      warn "系统里有多个 qingyu-data 卷，没敢乱删。请确认后手动执行： docker volume ls | grep qingyu-data"
      return 0
    fi
  [ -n "$vol" ] || die "没找到数据卷 qingyu-data（容器没在运行，且系统里有多个同名卷，无法确定）。\n请先 $0 start，或手动执行：docker volume ls | grep qingyu-data"
  # 打包要用带 tar 的镜像：优先用站点自己的镜像（本地已有，不用联网拉）
  img="$(env_value QINGYU_IMAGE)"; [ -n "$img" ] || img="qingyu-universal:local"
  $(${DOCKER:-docker} image inspect "$img" >/dev/null 2>&1) || img="node:22-alpine"

  out="${BUNDLE_OUT:-$HOME/qingyu-migrate-$ts.tar.gz}"
  staging="$(mktemp -d)"
  # 容器里的 node 用户不是 root，mktemp 默认 700 会写不进去，这里放开目录权限（只是临时目录，收尾会删）
  # 容器里的应用用户不是 root，临时目录得可写（收尾会 rm -rf）
  chmod 777 "$staging"
  if [ -n "$(env_value DATABASE_URL)" ]; then db_label="PostgreSQL（连接串已含在 .env 里，数据卷里是上传文件与快照）"; else db_label="SQLite（数据库文件在数据卷里）"; fi

  log "打包数据卷 ${vol}（上传的图片、SQLite 数据库、历史快照）…"
  ${DOCKER:-docker} run --rm \
    -v "$vol":/data:ro \
    -v "$staging":/out \
    --entrypoint sh "$img" -c 'cd /data && tar czf /out/data.tar.gz .' \
    || { rm -rf "$staging"; die "打包数据卷失败（容器里 tar 不可用？）"; }

  log "写入站点配置 .env 与恢复脚本…"
  cp "$INSTALL_DIR/.env" "$staging/.env"
  mkdir -p "$staging/deploy"
  cp "$INSTALL_DIR/deploy/install.sh" "$staging/deploy/install.sh" 2>/dev/null || true

  cat > "$staging/restore-here.sh" <<'RESTORE_EOF'
#!/usr/bin/env bash
# ============================================================
#  在新服务器上恢复轻语博客（本文件由 install.sh migrate 生成）
#  用法：
#     bash restore-here.sh                # 打印步骤 + 把 .env 复制过去
#     bash restore-here.sh --data-only    # 把数据装回数据卷
# ============================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${QINGYU_ROOT:-/opt/qingyu-universal}"

if [ "${1:-}" = "--data-only" ]; then
  VOL=""
  for v in $(docker volume ls --format '{{.Name}}' | grep -E '(^|_)qingyu-data$' || true); do VOL="$v"; break; done
  [ -n "$VOL" ] || { echo "[x] 找不到数据卷 qingyu-data，请先执行 install" >&2; exit 1; }
  IMG="qingyu-universal:local"
  docker image inspect "$IMG" >/dev/null 2>&1 || IMG="node:22-alpine"
  echo "==> 数据卷 $VOL 正在从备份还原…"
  docker run --rm -v "$VOL":/data -v "$HERE":/in:ro --entrypoint sh "$IMG" -c 'cd /data && tar xzf /in/data.tar.gz'
  echo "==> 数据已还原。现在执行： docker compose -f $ROOT/compose.yaml up -d"
  echo "    然后用 $ROOT/.env 里 SITE_URL 那个地址访问新站点。"
  exit 0
fi

echo "==> 恢复目标目录：$ROOT"
mkdir -p "$ROOT/deploy"
cp "$HERE/.env" "$ROOT/.env"
[ -f "$HERE/deploy/install.sh" ] && cp "$HERE/deploy/install.sh" "$ROOT/deploy/install.sh"
chmod +x "$ROOT/deploy/install.sh" 2>/dev/null || true
echo "==> 已复制站点配置（.env）与部署脚本（域名 / 端口 / 密钥都保留原来的）"
echo
echo "  接下来两步："
echo "    1) bash $ROOT/deploy/install.sh install -y      # 装程序（会复用上面的 .env）"
echo "    2) bash $HERE/restore-here.sh --data-only      # 把文章、图片、评论装回去"
echo
RESTORE_EOF
  chmod +x "$staging/restore-here.sh"

  cat > "$staging/README.txt" <<EOF
轻语博客 迁移包
===============
生成时间：$(date -u +"%Y-%m-%d %H:%M:%S") UTC
来源站点：$(env_value SITE_URL)
数据库：  ${db_label}

怎么迁到新服务器
----------------
1. 把这个 tar.gz 传到新服务器（scp / VPS 面板上传都行）
2. 解压：  tar xzf $(basename "$out")
3. 装程序（复用包里的 .env，域名、端口、密钥都不会变）：
     bash qingyu-migrate-$ts/deploy/install.sh install -y
4. 装回数据：
     bash qingyu-migrate-$ts/restore-here.sh --data-only
5. 打开新服务器上的站点，确认文章和上传的图片都在。

提示
----
· 两台服务器不必同时在线：先在旧机器打包，再拷过去即可。
· 建议打包前先执行 stop，防止这期间有新数据写进来。
· .env 里有管理员密钥和数据库密码，打包文件请当作敏感文件保管（已设为 600 权限）。
EOF

  log "生成迁移包…"
  tar czf "$out" -C "$staging" .
  chmod 600 "$out"
  rm -rf "$staging"
  size="$(du -h "$out" 2>/dev/null | cut -f1)"

  echo
  echo "  ┌──────────────────────────────────────────────────────────┐"
  echo "  │  迁移包已生成                                              │"
  echo "  └──────────────────────────────────────────────────────────┘"
  echo
  echo "    文件    ${out}（${size:-未知大小}）"
  echo "    内容    .env 站点配置 + 整个数据卷（文章、评论、上传的图片）"
  echo
  echo "  传到新服务器后按包内 README.txt 三步恢复即可。"
  echo "  提醒：迁移期间旧站点最好先 stop（$0 stop），避免数据不一致。"
  echo
}

cmd_restore() {
  local file="${ARGS[0]:-}"
  [ -n "$file" ] || die "用法：install.sh restore <快照文件>"
  [ -f "$file" ] || die "找不到快照：$file"
  log "停止应用容器…"
  compose stop app
  local name
  name="$(basename "$file")"
  ${DOCKER:-docker} cp "$file" qingyu-app:/data/restore-incoming.db
  compose run --rm --no-deps app node dist/cli/restore.js /data/restore-incoming.db
  compose up -d app
  log "恢复完成"
}

cmd_logs()     { compose logs -f app; }
# 把秒数格式化成「2h 13m」这样的人类可读形式
human_uptime() {
  local s="${1:-0}"
  local d=$((s / 86400)) h=$(((s % 86400) / 3600)) m=$(((s % 3600) / 60))
  if [ "$d" -gt 0 ]; then printf '%dd %dh' "$d" "$h"
  elif [ "$h" -gt 0 ]; then printf '%dh %dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}

# 从 /healthz 的紧凑 JSON 里读取受控字段，避免依赖外部 jq。
health_string_field() {
  printf '%s' "$health" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}

health_number_field() {
  printf '%s' "$health" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p"
}

# 显示这份部署的配置与运行状态。
# 重点是把只在首次部署时打印过一次、之后很容易丢的信息（访问地址、
# 初始化密钥）随时能查回来。
cmd_info() {
  local env_file="$INSTALL_DIR/.env"
  if [ ! -f "$env_file" ]; then
    die "未找到 $env_file —— 这个目录还没有部署过？用 --dir 指定安装目录"
  fi

  local site_url domain app_bind profiles setup_key write_token deploy_time
  site_url="$(env_value SITE_URL)"
  domain="$(env_value SITE_DOMAIN)"
  app_bind="$(env_value APP_BIND)"
  profiles="$(env_value COMPOSE_PROFILES)"
  setup_key="$(env_value BLOG_ADMIN_SETUP_KEY)"
  write_token="$(env_value BLOG_WRITE_TOKEN)"
  deploy_time="$(sed -n '1s/^# 由 deploy\/install.sh 于 \(.*\) 生成$/\1/p' "$env_file" | head -n1)"
  local port="${app_bind##*:}"

  echo
  echo "  轻语博客 · 部署信息"
  echo "  ────────────────────────────────────────────────────"
  echo "    访问地址      ${site_url:-（未设置）}"
  echo "    管理后台      ${site_url:-}/admin"
  if [ -n "$setup_key" ]; then
    echo "    初始化密钥    ${setup_key}"
    echo "                  （首次打开后台设置管理员密码时需要；重置密码也需要）"
  else
    echo "    初始化密钥    （未设置——首次初始化无保护，建议补上）"
  fi
  if [ -n "$write_token" ]; then
    echo "    写入令牌      ${write_token:0:8}…（脚本/CI 调用写接口用，完整值见 .env）"
  fi

  echo
  echo "  部署方式"
  echo "  ────────────────────────────────────────────────────"
  if has_profile domain "$profiles"; then
    echo "    模式          域名 + 自动 HTTPS"
    echo "    域名          ${domain:-（未设置）}"
    echo "    对外端口      80 / 443（由 Caddy 占用）"
  else
    echo "    模式          纯 HTTP（未启用 Caddy / 无证书）"
    echo "    端口          ${port:-（未知）}"
    if [ -n "$domain" ]; then
      echo "    域名          ${domain}"
    fi
  fi
  # 数据库：以 .env 的 DATABASE_URL 为准（有值 = PostgreSQL，空 = SQLite）
  local db_url db_kind_label db_host
  db_url="$(env_value DATABASE_URL)"
  if [ -n "$db_url" ]; then
    db_host="$(printf '%s' "$db_url" | sed -E 's#^[^:]+://[^@]*@([^/:]+).*#\1#')"
    if has_profile postgres "$profiles"; then
      db_kind_label="PostgreSQL（内置容器）"
    else
      db_kind_label="PostgreSQL（外部）"
    fi
    echo "    数据库        ${db_kind_label} ${db_host}"
    echo "    数据目录      ${INSTALL_DIR}/data（上传 + 备份；数据存 PostgreSQL 卷）"
  else
    echo "    数据库        SQLite"
    echo "    数据目录      ${INSTALL_DIR}/data（SQLite + 上传 + 备份；容器内 /data 卷）"
  fi
  [ -n "$deploy_time" ] && echo "    部署时间      ${deploy_time}"

  # 运行状态：容器在跑就问 /healthz，否则跳过
  local hp health
  hp="$(local_health_port)"; [ -n "$hp" ] || hp=8787
  health="$(curl -fsS --max-time 3 "http://127.0.0.1:${hp}/healthz" 2>/dev/null)" || health=""
  echo
  if [ -z "$health" ]; then
    echo "  运行状态"
    echo "  ────────────────────────────────────────────────────"
    echo "    ⚠ 服务未响应（容器可能没在运行）——执行 ./deploy/install.sh status 查看"
  else
    echo "  运行状态"
    echo "  ────────────────────────────────────────────────────"
    local version revision storage database_status posts applied skipped uptime
    version="$(health_string_field version)"
    revision="$(health_string_field revision)"
    storage="$(health_string_field storage)"
    database_status="$(health_string_field databaseStatus)"
    posts="$(health_number_field posts)"
    applied="$(health_number_field applied)"
    skipped="$(health_number_field skipped)"
    uptime="$(health_number_field uptime)"

    [ -n "$version" ] && echo "    版本          ${version}"
    [ -n "$revision" ] && [ "$revision" != "null" ] && echo "    构建版本      ${revision}"
    [ -n "$posts" ] && echo "    文章数        ${posts}"
    if [ -n "$storage" ]; then
      [ "$storage" = "local" ] && storage="本地磁盘" || storage="S3 兼容对象存储"
      echo "    存储方式      ${storage}"
    fi
    if [ -n "$applied" ] || [ -n "$skipped" ]; then
      echo "    数据库迁移    已应用 ${applied:-0} / 已跳过 ${skipped:-0}"
    fi
    [ -n "$uptime" ] && echo "    运行时长      $(human_uptime "$uptime")"
    if [ "$database_status" = "error" ]; then
      echo "    数据库        SQLite（异常）"
    else
      echo "    数据库        SQLite（${INSTALL_DIR}/data/qingyu.db）"
    fi
  fi

  # 安全提示
  if [ "$profiles" != "domain" ]; then
    echo
    echo "  安全提示"
    echo "  ────────────────────────────────────────────────────"
    echo "    ⚠ 当前为纯 HTTP，管理后台的登录密码是明文传输的。"
    echo "      让出 80/443 后执行 ./deploy/install.sh upgrade --domain 你的域名 可启用 HTTPS"
  fi
  echo
}
# ---------- 一键体检 ----------
# 用法：./deploy/install.sh doctor
# 把「网站打不开 / 图片传不上去 / 评论报错」这类问题拆成一组可判定的小项，
# 每项给 ✅/⚠️/❌ 加一句怎么修，最后汇总。全程只读，不改任何配置。
DOCTOR_OK=0
DOCTOR_WARN=0
DOCTOR_FAIL=0

doc_head() {
  printf '\n  \033[1m%s\033[0m\n' "$1"
  printf '  %s\n' "────────────────────────────────────────"
}

doc_ok() {
  printf '    \033[1;32m✅\033[0m %s\n' "$1"
  DOCTOR_OK=$((DOCTOR_OK + 1))
}

doc_warn() {
  printf '    \033[1;33m⚠️ \033[0m %s\n' "$1"
  DOCTOR_WARN=$((DOCTOR_WARN + 1))
  if [ -n "${2:-}" ]; then
    printf '        \033[2m→ %s\033[0m\n' "$2"
  fi
}

doc_fail() {
  printf '    \033[1;31m❌\033[0m %s\n' "$1"
  DOCTOR_FAIL=$((DOCTOR_FAIL + 1))
  if [ -n "${2:-}" ]; then
    printf '        \033[2m→ %s\033[0m\n' "$2"
  fi
}

doc_info() {
  printf '      \033[2m%s\033[0m\n' "$1"
}

cmd_doctor() {
  need_root
  resolve_docker

  # .env 通常只有 root 能读；普通用户直接跑体检会半路失败，这里自动提权重启一次
  if [ ! -r "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env" ]; then
    echo
    warn "读不到 ${INSTALL_DIR}/.env（当前用户 $(id -un) 权限不足）"
    if have sudo && sudo -n test -r "$INSTALL_DIR/.env" 2>/dev/null && [ -f "$0" ]; then
      log "改用 sudo 重新执行体检..."
      exec sudo "$0" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
    fi
    echo "    修复：sudo chown -R $(id -u):$(id -g) ${INSTALL_DIR}"
    return 1
  fi
  DOCTOR_OK=0
  DOCTOR_WARN=0
  DOCTOR_FAIL=0

  local install_script="${INSTALL_DIR}/deploy/install.sh"
  echo
  echo "  轻语博客 · 一键体检"
  echo "  ────────────────────────────────────────────────────"
  echo "    安装目录 ${INSTALL_DIR}"

  if [ ! -f "$INSTALL_DIR/.env" ]; then
    doc_fail "这个目录还没有部署过（找不到 .env）" "先部署：bash ${install_script} install"
    echo
    printf '    ✅ 正常 %s    ⚠️ 需留意 %s    ❌ 需处理 %s\n' "$DOCTOR_OK" "$DOCTOR_WARN" "$DOCTOR_FAIL"
    return 1
  fi

  # ---- 1. Docker ----
  doc_head "Docker 环境"
  if ! have docker; then
    doc_fail "未检测到 Docker" "curl -fsSL https://get.docker.com | sh"
  elif ! docker info >/dev/null 2>&1; then
    doc_fail "Docker 已安装，但服务没有运行" "systemctl enable --now docker"
  else
    doc_ok "Docker 运行中"
    if docker compose version >/dev/null 2>&1; then
      doc_ok "docker compose 可用"
      if [ -f "$INSTALL_DIR/.env" ] && grep -q '^QINGYU_MIRROR=1' "$INSTALL_DIR/.env" 2>/dev/null; then
        doc_ok "已启用国内加速（GitHub / Docker Hub / npm 镜像）"
      fi
    else
      doc_fail "缺少 docker compose 插件" "安装 docker-compose-plugin 后重试"
    fi
  fi

  # ---- 2. 容器 ----
  doc_head "应用容器"
  local container_state="none"
  local container_health="none"
  if have docker && docker info >/dev/null 2>&1; then
    container_state="$(docker inspect -f '{{.State.Status}}' qingyu-app 2>/dev/null || echo none)"
    container_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' qingyu-app 2>/dev/null || echo none)"
    case "$container_state" in
      running)
        if [ "$container_health" = "healthy" ] || [ "$container_health" = "none" ]; then
          doc_ok "应用容器运行中（健康状态 ${container_health}）"
        else
          doc_warn "应用容器在跑，但健康检查是 ${container_health}" "docker logs --tail 50 qingyu-app"
        fi
        ;;
      restarting)
        doc_fail "应用容器在反复重启" "docker logs --tail 50 qingyu-app"
        ;;
      none)
        doc_fail "找不到应用容器 qingyu-app" "docker compose -f ${INSTALL_DIR}/compose.yaml up -d"
        ;;
      *)
        doc_fail "应用容器状态异常：${container_state}" "docker compose -f ${INSTALL_DIR}/compose.yaml up -d"
        ;;
    esac
  else
    doc_fail "Docker 不可用，读不到容器状态" "systemctl enable --now docker"
  fi

  # ---- 3. 服务健康 ----
  doc_head "服务健康检查"
  local hp bind bind_addr health profiles site_url
  hp="$(local_health_port)"
  [ -n "$hp" ] || hp=8787
  bind="$(env_value APP_BIND)"
  [ -n "$bind" ] || bind="127.0.0.1:8787"
  bind_addr="${bind%:*}"
  profiles="$(env_value COMPOSE_PROFILES)"
  site_url="$(env_value SITE_URL)"
  health="$(curl -fsS --max-time 4 "http://127.0.0.1:${hp}/healthz" 2>/dev/null || true)"
  if [ -n "$health" ]; then
    doc_ok "本机健康检查通过（127.0.0.1:${hp}）"
    local version revision posts database
    version="$(health_string_field version)"
    revision="$(health_string_field revision)"
    database="$(health_string_field database)"
    posts="$(health_number_field posts)"
    if [ -n "$version" ]; then doc_info "版本 ${version}"; fi
    if [ -n "$revision" ] && [ "$revision" != "null" ]; then doc_info "构建 ${revision}"; fi
    if [ -n "$database" ]; then doc_info "数据库 ${database}"; fi
    if [ -n "$posts" ]; then doc_info "文章数 ${posts}"; fi
  else
    doc_fail "本机健康检查没有响应（127.0.0.1:${hp}）" "docker logs --tail 50 qingyu-app"
  fi

  # ---- 4. 端口与监听 ----
  doc_head "端口与监听"
  if uses_caddy; then
    if port_in_use 80 && port_in_use 443; then
      doc_ok "Caddy 已监听 80 / 443（HTTPS 模式）"
    else
      doc_warn "80/443 没有全部监听，证书可能签发不了" "docker logs --tail 30 qingyu-caddy"
    fi
  else
    if port_in_use "$hp"; then
      doc_ok "端口 ${hp} 正在监听（${bind}）"
    else
      doc_fail "端口 ${hp} 没有在监听" "docker compose -f ${INSTALL_DIR}/compose.yaml up -d"
    fi
    if [ "$bind_addr" = "127.0.0.1" ] || [ "$bind_addr" = "localhost" ] || [ "$bind_addr" = "::1" ]; then
      doc_fail "应用只绑在 127.0.0.1，外网一定访问不到" "把 ${INSTALL_DIR}/.env 里的 APP_BIND 改成 0.0.0.0:${hp}，再 restart"
    else
      doc_ok "应用对外监听 ${bind}"
    fi
  fi

  # ---- 5. 本机防火墙 ----
  doc_head "本机防火墙"
  local check_port="$hp"
  if uses_caddy; then check_port=80; fi
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    if ufw status 2>/dev/null | grep -qE "^${check_port}(/tcp)?[[:space:]]"; then
      doc_ok "ufw 已放行 ${check_port}/tcp"
    else
      doc_warn "ufw 已启用，但没放行 ${check_port} 端口" "ufw allow ${check_port}/tcp"
    fi
  elif have firewall-cmd && firewall-cmd --state 2>/dev/null | grep -q running; then
    if firewall-cmd --list-ports 2>/dev/null | grep -qE "(^| )${check_port}/tcp( |$)"; then
      doc_ok "firewalld 已放行 ${check_port}/tcp"
    else
      doc_warn "firewalld 已启用，但没放行 ${check_port} 端口" "firewall-cmd --permanent --add-port=${check_port}/tcp && firewall-cmd --reload"
    fi
  else
    doc_ok "没有启用本机防火墙（ufw / firewalld）"
  fi

  # ---- 6. 对外访问 ----
  doc_head "对外访问"
  local ip
  ip="$(detect_ip)"
  if uses_caddy; then
    local domain resolved probe
    domain="$(env_value SITE_DOMAIN)"
    if [ -z "$domain" ]; then
      doc_warn "没有配置域名" "用 bash ${install_script} upgrade --domain 你的域名 启用 HTTPS"
    else
      resolved="$(getent hosts "$domain" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
      if [ -z "$resolved" ]; then
        doc_fail "域名 ${domain} 解析不到（证书也签发不了）" "到 DNS 控制台加 A 记录指向 ${ip}"
      else
        doc_ok "域名 ${domain} 解析到 ${resolved}"
        if [ "$resolved" = "$ip" ]; then
          doc_ok "解析结果与本机公网 IP 一致"
        else
          doc_warn "解析到 ${resolved}，本机公网 IP 是 ${ip}" "确认 A 记录指向 ${ip}"
        fi
      fi
      probe="$(curl -ksS --max-time 6 "https://${domain}/healthz" 2>/dev/null || true)"
      if [ -n "$probe" ]; then
        doc_ok "HTTPS 对外可访问"
      else
        doc_warn "HTTPS 从本机探测不到（证书未签发，或安全组没放行 443）" "docker logs --tail 30 qingyu-caddy"
      fi
    fi
  else
    local probe site_host
    if [ "$ip" = "127.0.0.1" ]; then
      doc_warn "没探测到公网 IP" "用 --ip 手动指定，否则 SITE_URL 可能不准"
    else
      doc_ok "本机公网 IP ${ip}"
      probe="$(curl -fsS --max-time 5 "http://${ip}:${hp}/healthz" 2>/dev/null || true)"
      if [ -n "$probe" ]; then
        doc_ok "从本机访问 http://${ip}:${hp} 正常"
      else
        doc_warn "从本机访问 http://${ip}:${hp} 不通" "去云控制台安全组放行 ${hp}/tcp；本机防火墙也要放行"
      fi
      site_host="$(printf '%s' "$site_url" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
      if [ -z "$site_host" ]; then
        doc_warn "SITE_URL 没有配置" "bash ${install_script} upgrade --ip ${ip}"
      elif [ "$site_host" != "$ip" ] && [ "$site_host" != "localhost" ] && [ "$site_host" != "127.0.0.1" ]; then
        doc_warn "SITE_URL 是 ${site_url}，与本机 IP ${ip} 不一致（图片和分享链接会指向旧地址）" "bash ${install_script} upgrade --ip ${ip}"
      else
        doc_ok "SITE_URL 与本机环境一致（${site_url}）"
      fi
    fi
  fi

  # ---- 7. 磁盘与内存 ----
  doc_head "磁盘与内存"
  local avail_kb mem_free_mb
  avail_kb="$(df -Pk "$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [ -n "$avail_kb" ]; then
    if [ "$avail_kb" -lt 204800 ]; then
      doc_fail "磁盘只剩 $((avail_kb / 1024)) MB，随时会写满" "清理 ${INSTALL_DIR}/data/backups，或扩容"
    elif [ "$avail_kb" -lt 1048576 ]; then
      doc_warn "磁盘可用 $((avail_kb / 1024)) MB"
    else
      doc_ok "磁盘可用 $((avail_kb / 1024)) MB"
    fi
  else
    doc_warn "读不到磁盘容量"
  fi
  mem_free_mb="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}' || true)"
  if [ -n "$mem_free_mb" ]; then
    if [ "$mem_free_mb" -lt 100 ]; then
      doc_warn "可用内存只有 ${mem_free_mb} MB，本地构建镜像可能失败" "用 --image 拉现成镜像，或给机器加内存"
    else
      doc_ok "可用内存 ${mem_free_mb} MB"
    fi
  fi

  # ---- 7.5 定时备份 ----
  doc_head "定时备份"
  if have systemctl && [ -d /run/systemd/system ] && systemctl is-enabled qingyu-backup.timer >/dev/null 2>&1; then
    local next_run snaps
    snaps="$(list_backups | wc -l | tr -d " ")"
    doc_ok "定时备份已启用（systemd timer），现有快照 ${snaps:-0} 份"
    next_run="$(systemctl show qingyu-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)"
    if [ -n "$next_run" ] && [ "$next_run" != "n/a" ]; then
      next_run="${next_run#* }"
      doc_ok "下次执行：$next_run"
    fi
    if [ "${snaps:-0}" -gt 10 ]; then
      doc_warn "快照已经有 ${snaps} 份，可以收紧保留份数：autobackup --keep 7"
    fi
  elif crontab -l 2>/dev/null | grep -q qingyu-backup; then
    doc_ok "定时备份已启用（crontab）"
  else
    doc_warn "没开定时备份（服务器坏掉时会丢数据）" "${INSTALL_DIR}/deploy/install.sh autobackup"
  fi

  # ---- 8. 最近的错误日志 ----
  doc_head "最近 24 小时的错误日志"
  local errs err_count
  errs="$(docker logs --since 24h qingyu-app 2>&1 | grep -iE '"level":(50|60)|\bfatal\b|\berror\b|ECONNREFUSED|ENOENT|unhandled' | tail -n 8 || true)"
  if [ -z "$errs" ]; then
    doc_ok "没有发现明显的错误"
  else
    err_count="$(printf '%s\n' "$errs" | wc -l | tr -d ' ')"
    doc_warn "有 ${err_count} 行错误日志（显示最近 8 行）" "完整日志：docker logs --tail 200 qingyu-app"
    printf '%s\n' "$errs" | sed 's/^/        │ /'
  fi

  # ---- 8.5 界面配色 ----
  doc_head "界面配色可读性"
  local contrast_script="${INSTALL_DIR}/scripts/check-contrast.mjs"
  if [ -f "$contrast_script" ] && have node; then
    if node "$contrast_script" >/tmp/qingyu-contrast.log 2>&1; then
      doc_ok "界面文字与背景的对比度全部达标（WCAG AA）"
    else
      doc_warn "有文字颜色偏淡，看不清" "cd ${INSTALL_DIR} && npm run check:contrast"
      grep -E '^   - ' /tmp/qingyu-contrast.log 2>/dev/null | head -n 5 | sed 's/^/        │ /'
    fi
  else
    doc_info "跳过配色自检（需要源码目录 + Node.js，服务器上通常用不到）"
  fi

  # ---- 汇总 ----
  echo
  printf '  \033[1m体检结果\033[0m\n'
  printf '  %s\n' "────────────────────────────────────────"
  printf '    ✅ 正常 %s    ⚠️ 需留意 %s    ❌ 需处理 %s\n' "$DOCTOR_OK" "$DOCTOR_WARN" "$DOCTOR_FAIL"
  if [ "$DOCTOR_FAIL" -gt 0 ]; then
    printf '    \033[1;31m有 %s 项需要处理：按上面 → 的提示操作，再跑一次 doctor\033[0m\n' "$DOCTOR_FAIL"
    return 1
  fi
  if [ "$DOCTOR_WARN" -gt 0 ]; then
    printf '    \033[1;33m服务可用；上面标 ⚠️ 的项建议找时间处理\033[0m\n'
    return 0
  fi
  printf '    \033[1;32m一切正常\033[0m\n'
  return 0
}

cmd_status()   { compose ps; echo; curl -fsS "http://127.0.0.1:$(local_health_port)/healthz" || true; echo; }
cmd_uninstall() {
  warn "将停止并删除容器（数据卷 qingyu-data 会保留）"
  if [ "$PURGE" = "1" ]; then
    warn "--purge：会连同数据卷一起删除，文章和上传的图片都会消失！"
    if [ "$ASSUME_YES" != "1" ]; then
      if ! can_ask; then die "确认删除请加 -y：$0 uninstall --purge -y"; fi
      ask "确认彻底删除数据？（不可恢复）" "n"
      case "$REPLY" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
    fi
  fi
  compose down
  if [ "$PURGE" = "1" ]; then
    local vol
    vol="$(data_volume_name)"
    if [ -z "$vol" ]; then
      warn "系统里有多个 qingyu-data 卷，没敢乱删。请确认后手动执行： docker volume ls | grep qingyu-data"
      return 0
    fi
    log "删除数据卷 ${vol}…"
    ${DOCKER:-docker} volume rm "$vol" 2>/dev/null || warn "数据卷删除失败，可手动执行： docker volume rm ${vol}"
  fi
  log "如需只删容器、保留数据，直接运行 $0 uninstall"
}

# ----------------------------------------------------------
# 傻瓜式：已经部署过、又没写具体子命令时，弹一个数字菜单
# 只在「交互终端 + 没加 -y + 目录里已有 .env」时出现，
# 所以 CI、管道（curl|bash）、脚本互调都不会被它卡住。
# ----------------------------------------------------------
maybe_show_menu() {
  [ "${COMMAND_SET:-0}" = "0" ] || return 0
  [ -f "$INSTALL_DIR/.env" ] || return 0
  can_ask || return 0
  local site
  site="$(env_value SITE_URL 2>/dev/null || true)"
  {
    echo
    printf '\033[1;36m==> \033[0m%s\n' "检测到 ${INSTALL_DIR} 已经部署过，你想做什么？"
    [ -n "$site" ] && printf '    当前站点：\033[1m%s\033[0m\n' "$site"
    echo
    echo "  1) 升级到最新版    拉新代码并重建，数据保留"
    echo "  2) 一键体检        Docker / 容器 / 端口 / 防火墙 / 公网逐项检查"
    echo "  3) 查看部署信息    访问地址、初始化密钥、版本、文章数"
    echo "  4) 查看运行状态    容器与健康检查"
    echo "  5) 备份数据        数据库快照到 data/backups"
    echo "  6) 查看日志        实时输出应用日志（Ctrl+C 退出）"
    echo "  7) 重启服务        改完 .env 之后用它生效"
    echo "  8) 停止服务        配置和数据都保留"
    echo "  9) 启动服务        把停过的服务再拉起来"
    echo " 10) 回滚到上一版    升级出问题时退回"
    echo " 11) 卸载            删除容器（数据卷保留）"
    echo " 12) 定时备份        每天自动快照，只保留最近 7 份"
    echo " 13) 打包迁移        打成 tar.gz，方便搬到新服务器"
    echo "  0) 退出"
    echo
    echo "  提示：改端口 / 站点地址 → 编辑 ${INSTALL_DIR}/.env 后选 7 生效"
  } > /dev/tty 2>/dev/null || return 0
  ask "请输入数字" "0"
  case "$REPLY" in
    1)  COMMAND="upgrade" ;;
    2)  COMMAND="doctor" ;;
    3)  COMMAND="info" ;;
    4)  COMMAND="status" ;;
    5)  COMMAND="backup" ;;
    6)  COMMAND="logs" ;;
    7)  COMMAND="restart" ;;
    8)  COMMAND="stop" ;;
    9)  COMMAND="start" ;;
    10) COMMAND="rollback" ;;
    11) COMMAND="uninstall" ;;
    12) COMMAND="autobackup" ;;
    13) COMMAND="migrate" ;;
    0)  log "已退出（再次运行本脚本可重新打开菜单）"; exit 0 ;;
    *)  warn "没看懂这个选择（请输入 0-13），先退出"; exit 1 ;;
  esac
}

# 出错时自动给出「失败原因 + 可执行解法」，而不是只留一行红字
if [ -z "${QINGYU_NO_ERR_HELP:-}" ]; then
  trap 'on_error $? "$LINENO" "$BASH_COMMAND"' ERR
fi

maybe_show_menu

case "$COMMAND" in
  help) usage ;;
  install) cmd_install ;;
  upgrade) cmd_upgrade ;;
  backup)    cmd_backup; prune_backups "$KEEP_N" ;;
  autobackup) cmd_autobackup ;;
  migrate)   cmd_migrate ;;
  restore) cmd_restore ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  info) cmd_info ;;
  doctor) cmd_doctor ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  rollback) cmd_rollback ;;
  uninstall) cmd_uninstall ;;
  *) usage; die "未知命令：$COMMAND" ;;
esac
