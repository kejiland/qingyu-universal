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
#     install（默认） | upgrade | backup | restore <file> | logs | status | info | uninstall
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

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

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
COMMAND="install"
ARGS=()
# 数据库选择（脚本开了 set -u，未设置的变量必须先给默认值）
DB_KIND="${DB_KIND:-}"
DATABASE_URL_OPT="${DATABASE_URL_OPT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|backup|restore|logs|status|info|uninstall|help) COMMAND="$1" ;;
    --domain)   DOMAIN="${2:-}"; shift ;;
    --email)    EMAIL="${2:-}"; shift ;;
    --dir)      INSTALL_DIR="${2:-}"; shift ;;
    --ref)      REF="${2:-}"; shift ;;
    --repo)     REPO="${2:-}"; shift ;;
    --port)     APP_PORT="${2:-}"; shift ;;
    --db)       DB_KIND="${2:-}"; shift ;;
    --database-url) DATABASE_URL_OPT="${2:-}"; shift ;;
    -y|--yes)   ASSUME_YES=1 ;;
    --ip)       IP_ADDR="${2:-}"; shift ;;
    --image)    IMAGE="${2:-}"; shift ;;
    -h|--help)  COMMAND="help" ;;
    *)          ARGS+=("$1") ;;
  esac
  shift
done

usage() {
  cat <<'EOF'
轻语博客 · 自托管通用版 一键部署

  install                 安装并启动（默认）
  upgrade                 拉取新版本并重建（保留数据）
  backup                  生成数据库快照到 data/backups
  restore <快照文件>       从快照恢复（请先 docker compose stop app）
  logs                    查看应用日志
  status                  查看容器与健康状态
  info                    查看部署信息（访问地址、初始化密钥、版本、文章数…）
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
  --image  <镜像>         使用预构建镜像而不是本地构建
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

# 取构建版本（commit 短 SHA），用于确认「升级到底生效没有」。
# 优先本地 git；否则读 GitHub 的 Atom feed —— 它走网页，不受 api.github.com
# 的限流（未认证每小时 60 次，实测经常直接 403）。
# 都取不到则返回空串，不影响部署。
#
# 注意：这里先把响应存进变量再解析，**不能**写成
#   curl … | grep -m1 …
# 因为脚本开了 set -o pipefail，而 grep -m1 命中后立即退出会让 curl 收到
# SIGPIPE（141），pipefail 把整条管道判为失败 —— 而且这是竞态：
# curl 先写完就正常，所以单独测试能过、在脚本里却拿到空值。
resolve_revision() {
  local sha="" body=""
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    sha=$(git -C "$INSTALL_DIR" rev-parse --short=7 HEAD 2>/dev/null) || sha=""
  fi
  if [ -z "$sha" ]; then
    body=$(curl -fsS --max-time 8 -H 'User-Agent: curl' \
           "https://github.com/$REPO/commits/$REF.atom" 2>/dev/null) || body=""
    if [ -n "$body" ]; then
      sha=$(printf '%s' "$body" | grep -oE 'Grit::Commit/[0-9a-f]{40}' | sed -n '1s|.*/||p') || sha=""
      sha="${sha:0:7}"
    fi
  fi
  printf '%s' "$sha"
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
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker || true
  fi
  have docker || die "Docker 安装失败，请手动安装后重试"
  $SUDO docker compose version >/dev/null 2>&1 || warn "未检测到 compose 插件，请确认 docker compose 可用"
}

# ---------- 代码获取 ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd || true)"

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
    return
  fi
  # 情况二：curl | bash → 下载代码包
  download_source
}

# 下载最新代码包并覆盖到安装目录。
# 只覆盖代码，不动 .env 与 data —— 压缩包里本来就不含它们。
# 供两种场景使用：curl|bash 首次安装，以及 upgrade（安装目录不是 git 仓库时）。
download_source() {
  log "下载代码：$REPO@$REF"
  need_root
  ensure_curl
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" -o "$tmp/src.tgz" \
    || curl -fsSL "https://github.com/$REPO/archive/refs/tags/$REF.tar.gz" -o "$tmp/src.tgz" \
    || die "下载失败：https://github.com/$REPO（请确认仓库与分支/标签）"
  tar -xzf "$tmp/src.tgz" -C "$tmp"
  local extracted
  extracted="$(find "$tmp" -maxdepth 1 -type d -name '*qingyu*' | head -n1)"
  [ -n "$extracted" ] || extracted="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)"
  cp -a "$extracted"/. "$INSTALL_DIR/"
  rm -rf "$tmp"
  log "代码已更新到 $REF"
}

# upgrade 专用的取码逻辑：
#   安装目录是 git 仓库 → git pull
#   从本地 checkout 运行  → 复制本地代码
#   压缩包安装（默认）    → 下载最新代码包
# 此前 upgrade 只做「重建容器」，对压缩包安装等于原地重建旧版本，
# 用户执行了 upgrade 却拿不到新代码。
update_source() {
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    log "从 git 拉取最新代码…"
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull 失败，继续用现有代码重建"
    return 0
  fi
  if [ -n "${SOURCE_ROOT:-}" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ "$SOURCE_ROOT" != "$INSTALL_DIR" ]; then
    fetch_source
    return 0
  fi
  download_source
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

# 邮件（留空 = 关闭订阅通知）
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=0
RESEND_API_KEY=
BLOG_MAIL_FROM=

# AI（留空 = 关闭）
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
EOF
  chmod 600 "$env_file"
  SETUP_KEY_SHOWN="$setup_key"
}

# 读取 .env 中的值（install.sh 生成的配置以 .env 为准，避免两处真值）
env_value() {
  local key="$1"
  [ -f "$INSTALL_DIR/.env" ] || return 0
  grep -E "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null | head -n1 | cut -d= -f2-
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
  # 已用参数指定 → 尊重参数；已部署过 → 不打扰现有配置
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

preflight() {
  local ok=1
  log "起飞前检查…"

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

  # 防火墙：不阻断，只给出该执行的命令（各家发行版工具不同，不宜代为修改）
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    warn "检测到 ufw 已启用，若部署后无法访问请放行端口："
    if [ -n "$DOMAIN" ]; then warn "    ufw allow 80,443/tcp"
    else warn "    ufw allow ${APP_PORT}/tcp"; fi
  elif have firewall-cmd && firewall-cmd --state 2>/dev/null | grep -q running; then
    warn "检测到 firewalld 已启用，若部署后无法访问请放行端口："
    if [ -n "$DOMAIN" ]; then
      warn "    firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload"
    else
      warn "    firewall-cmd --permanent --add-port=${APP_PORT}/tcp && firewall-cmd --reload"
    fi
  fi

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
cmd_install() {
  need_root
  resolve_docker
  ensure_curl
  install_docker
  fetch_source
  interact_mode
  interact_database
  resolve_mode
  resolve_database
  ensure_env
  preflight
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "构建并启动容器…（版本 $BUILD_REVISION）"
  compose up -d --build
  wait_healthy
  summary
}

cmd_upgrade() {
  need_root
  resolve_docker
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  update_source
  resolve_mode
  # 先备份，再升级
  cmd_backup || warn "升级前备份失败，继续升级"
  # 注入构建版本（git 短 SHA），让 /healthz 能回答「升级到底生效没有」
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "重建容器…（版本 $BUILD_REVISION）"
  compose pull --ignore-pull-failures 2>/dev/null || true
  compose up -d --build
  wait_healthy
  log "升级完成（版本 $BUILD_REVISION）"
}

cmd_backup() {
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  compose exec -T app node dist/cli/backup.js /data/backups
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
cmd_status()   { compose ps; echo; curl -fsS "http://127.0.0.1:$(local_health_port)/healthz" || true; echo; }
cmd_uninstall() {
  warn "将停止并删除容器（数据卷 qingyu-data 会保留）"
  compose down
  log "如需彻底删除数据：docker volume rm qingyu-universal_qingyu-data"
}

case "$COMMAND" in
  help) usage ;;
  install) cmd_install ;;
  upgrade) cmd_upgrade ;;
  backup) cmd_backup ;;
  restore) cmd_restore ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  info) cmd_info ;;
  uninstall) cmd_uninstall ;;
  *) usage; die "未知命令：$COMMAND" ;;
esac
