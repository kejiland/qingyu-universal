#!/usr/bin/env bash
# ============================================================
# 轻语博客 · 自托管通用版 —— 一键部署脚本
# ------------------------------------------------------------
# 用法：
#   从仓库运行：
#     ./deploy/install.sh --domain blog.example.com
#   远程一键（仓库发布后）：
#     curl -fsSL https://raw.githubusercontent.com/<owner>/qingyu-universal/main/deploy/install.sh | bash -s -- --domain blog.example.com
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
EMAIL="${ACME_EMAIL:-}"
IMAGE="${QINGYU_IMAGE:-}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

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
  --domain <域名>         对外域名，用于自动 HTTPS（如 blog.example.com）
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
  if have docker && docker compose version >/dev/null 2>&1; then
    log "Docker 与 Compose 已就绪（$(docker --version)）"
    return
  fi
  log "未检测到 Docker，正在安装…"
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
      for item in package.json package-lock.json tsconfig.json compose.yaml app src scripts deploy LICENSE .env.example; do
        [ -e "$SOURCE_ROOT/$item" ] && cp -a "$SOURCE_ROOT/$item" "$INSTALL_DIR/"
      done
    fi
    return
  fi
  # 情况二：curl | bash → 下载代码包
  log "下载代码：$REPO@$REF"
  need_root
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
rand_short() { head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ensure_env() {
  local env_file="$INSTALL_DIR/.env"
  if [ -f "$env_file" ]; then
    log "已存在 .env，保持不覆盖（如需重配请手动编辑）"
    return
  fi
  local setup_key write_token port site_url
  setup_key="qy-$(rand_short)"
  write_token="$(rand)"
  port="8787"
  if [ -n "$DOMAIN" ]; then site_url="https://$DOMAIN"; else site_url="http://localhost"; fi

  log "生成 .env 与随机密钥"
  cat > "$env_file" <<EOF
# 由 deploy/install.sh 于 $(date -u +"%Y-%m-%dT%H:%M:%SZ") 生成
PORT=$port
HOST=127.0.0.1
SITE_URL=$site_url
SITE_DOMAIN=$DOMAIN
DATA_DIR=./data
TRUST_PROXY=1

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
    if curl -fsS "http://127.0.0.1${HEALTH_PORT:-:8787}/healthz" >/dev/null 2>&1; then
      log "服务已响应"
      return 0
    fi
    i=$((i + 1)); sleep 3
  done
  warn "等待超时，请查看日志：docker compose logs -f app"
  return 0
}

summary() {
  local domain_display="${DOMAIN:-localhost}"
  local scheme="https"
  [ -z "$DOMAIN" ] && scheme="http"
  echo
  echo "  ┌──────────────────────────────────────────────────────────┐"
  echo "  │  轻语博客 · 自托管通用版 部署完成                          │"
  echo "  └──────────────────────────────────────────────────────────┘"
  echo
  echo "    访问地址    ${scheme}://${domain_display}"
  echo "    管理后台    ${scheme}://${domain_display}/admin"
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
  echo "    未配置域名？在 .env 里设置 SITE_DOMAIN 后执行 deploy/install.sh upgrade 即可启用自动 HTTPS。"
  echo
}

# ---------- 各子命令 ----------
cmd_install() {
  need_root
  install_docker
  fetch_source
  ensure_env
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
cmd_status()   { compose ps; echo; curl -fsS "http://127.0.0.1:${PORT:-8787}/healthz" || true; echo; }
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