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
#     install（默认） | upgrade | backup | restore <file> | logs | status | uninstall
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
  docker compose version >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

# ---------- 参数解析 ----------
COMMAND="install"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|backup|restore|logs|status|uninstall|help) COMMAND="$1" ;;
    --domain)   DOMAIN="${2:-}"; shift ;;
    --email)    EMAIL="${2:-}"; shift ;;
    --dir)      INSTALL_DIR="${2:-}"; shift ;;
    --ref)      REF="${2:-}"; shift ;;
    --repo)     REPO="${2:-}"; shift ;;
    --port)     APP_PORT="${2:-}"; shift ;;
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
  uninstall               停止并删除容器（数据卷保留，需手动删除）

选项：
  --domain <域名>         对外域名，启用 Caddy + Let's Encrypt 自动 HTTPS
                          （不填则用 http://<服务器IP>:<端口> 直接访问，无证书）
  --port   <端口>         直接对外暴露该端口，走纯 HTTP、不启动 Caddy。
  --                     配合 --domain 时是 80/443 被占用时的退路
  --                     （代价是拿不到自动 HTTPS 证书）；不配合 --domain
  --                     时为 IP+端口模式（默认 8080）
  --ip     <地址>         无域名模式下写入 SITE_URL 的地址（默认自动探测公网 IP）
  --email  <邮箱>         ACME 证书通知邮箱（可选）
  --dir    <目录>         安装目录，默认 /opt/qingyu-universal
  --ref    <分支/标签>     下载的代码版本，默认 main
  --image  <镜像>         使用预构建镜像而不是本地构建
EOF
}

# ---------- 运行环境检查 ----------
need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    have sudo || die "需要 root 权限（或安装 sudo）"
    SUDO="sudo"
  else
    SUDO=""
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
  mkdir -p "$INSTALL_DIR"
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
    return
  fi
  local setup_key write_token site_url app_bind compose_profiles trust_proxy
  setup_key="qy-$(rand_short)"
  write_token="$(rand)"

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

  log "生成 .env 与随机密钥"
  cat > "$env_file" <<EOF
# 由 deploy/install.sh 于 $(date -u +"%Y-%m-%dT%H:%M:%SZ") 生成
PORT=8787
HOST=0.0.0.0
SITE_URL=$site_url
SITE_DOMAIN=$DOMAIN
DATA_DIR=./data
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

# 是否启用 Caddy（即 HTTPS 模式）。
# .env 已存在时必须以里面的 COMPOSE_PROFILES 为准：
# 那时 APP_BIND=127.0.0.1:8787 会被误判成「自定义端口」。
uses_caddy() {
  local profiles; profiles="$(env_value COMPOSE_PROFILES)"
  if [ -n "$profiles" ]; then
    [ "$profiles" = "domain" ]
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
  docker compose "$@"
}

wait_healthy() {
  log "等待服务就绪…"
  local i=0
  while [ $i -lt 60 ]; do
    if docker compose ps --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
      log "服务已健康"
      return 0
    fi
    if curl -fsS "http://127.0.0.1:$(local_health_port)/healthz" >/dev/null 2>&1; then
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
  echo "    数据目录    ${INSTALL_DIR}/data（SQLite + 上传 + 备份）"
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
  echo
  if [ "$(env_value COMPOSE_PROFILES)" = "domain" ]; then
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
  ensure_curl
  install_docker
  fetch_source
  resolve_mode
  ensure_env
  preflight
  log "构建并启动容器…"
  compose up -d --build
  wait_healthy
  summary
}

cmd_upgrade() {
  need_root
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  if [ -n "$SOURCE_ROOT" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ "$SOURCE_ROOT" != "$INSTALL_DIR" ]; then
    fetch_source
  fi
  resolve_mode
  # 先备份，再升级
  cmd_backup || warn "升级前备份失败，继续升级"
  log "拉取镜像 / 重建容器…"
  compose pull --ignore-pull-failures 2>/dev/null || true
  compose up -d --build
  wait_healthy
  log "升级完成"
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
  docker cp "$file" qingyu-app:/data/restore-incoming.db
  compose run --rm --no-deps app node dist/cli/restore.js /data/restore-incoming.db
  compose up -d app
  log "恢复完成"
}

cmd_logs()     { compose logs -f app; }
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
  uninstall) cmd_uninstall ;;
  *) usage; die "未知命令：$COMMAND" ;;
esac
