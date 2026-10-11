#!/usr/bin/env bash
# ============================================================
# 轻语博客 · 部署助手
# ------------------------------------------------------------
# 设计目标只有一条：不认识命令的人也能把服务器部署好。
# 所以交互全是数字菜单，每一步都有默认值，一路回车就能装完。
#
# 两种用法：
#   1) 菜单（推荐）：bash deploy/qy.sh
#   2) 单条命令：  bash deploy/qy.sh install / update / doctor / logs ...
#
# 菜单和子命令调用的是同一批函数，行为完全一致。
# ============================================================
set -euo pipefail

REPO="kejiland/qingyu-universal"
BRANCH="main"
INSTALL_DIR="${QINGYU_DIR:-/opt/qingyu-universal}"
ENV_FILE="$INSTALL_DIR/.env"

# ---------- 显示 ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=''; C_G=''; C_Y=''; C_R=''; C_C=''; C_0=''
fi
step() { printf '%s==>%s %s\n' "$C_C" "$C_0" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$*"; }
die()  { err "$*"; exit 1; }
pause() { printf '\n按回车继续...'; read -r _ || exit 0; }

# 问一个问题，带默认值：ask 问题 默认值 变量名
ask() {
  local q="$1" def="${2:-}" var="$3" ans=""
  if [ -n "$def" ]; then printf '%s [%s]：' "$q" "$def"; else printf '%s：' "$q"; fi
  read -r ans || ans=""
  printf -v "$var" '%s' "${ans:-$def}"
}

# 数字菜单：pick 问题 选项... ，返回选中项的编号（1 起）
pick() {
  local q="$1"; shift
  printf '%s\n' "$q" >&2
  local i=1 opt
  for opt in "$@"; do printf '  %d) %s\n' "$i" "$opt" >&2; i=$((i + 1)); done
  local ans=""
  while :; do
    printf '请选择 [1]：' >&2
    read -r ans || ans="1"
    case "$ans" in
      "") ans=1 ;;
      *[!0-9]*) err "请输入数字" >&2; continue ;;
      *) if [ "$ans" -ge 1 ] && [ "$ans" -le $# ]; then printf '%s' "$ans"; return 0; fi ;;
    esac
    err "没有 $ans 这个选项"
  done
}

# 主菜单读法：没有选项列表，直接校验 0..9。
# 单独写一个函数而不是复用 pick —— pick 按「选项个数」校验，
# 主菜单传不了选项，混用会变成死循环（出过一次）。
# 输入流结束时（EOF，比如管道喂完）必须退出，否则会无限刷屏。
menu_read() {
  local ans=""
  while :; do
    printf '请选择 [1]：' >&2
    if ! read -r ans; then echo >&2; exit 0; fi
    ans="${ans:-1}"
    case "$ans" in
      *[!0-9]*) err "请输入数字" >&2; continue ;;
    esac
    if [ "$ans" -le 9 ]; then printf '%s' "$ans"; return 0; fi
    err "没有 $ans 这个选项" >&2
  done
}

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 环境检查 ----------
need_root() { [ "$(id -u)" = "0" ] || die "这一步需要 root，请用 root 跑（或 sudo bash deploy/qy.sh）"; }
installed() { [ -f "$ENV_FILE" ]; }
dc() { ( cd "$INSTALL_DIR" && docker compose "$@" ); }

check_docker() {
  have docker || die "没装 Docker，请先装好 Docker"
  docker info >/dev/null 2>&1 || die "Docker 没在运行，或当前用户没有权限"
  docker compose version >/dev/null 2>&1 || die "缺少 docker compose（Compose v2）"
}

ensure_dir() {
  [ -d "$INSTALL_DIR" ] && return 0
  need_root
  mkdir -p "$INSTALL_DIR"
  ok "已创建 $INSTALL_DIR"
}

fetch_code() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    step "更新代码"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" >/dev/null
  else
    step "获取代码到 $INSTALL_DIR"
    need_root
    local tmp; tmp="$(mktemp -d)"
    git clone --depth 1 "https://github.com/$REPO.git" "$tmp/repo" >&2
    cp -a "$tmp/repo/." "$INSTALL_DIR/"
    rm -rf "$tmp"
  fi
}

public_ip() {
  local ip
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "${ip:-你的服务器IP}"
}

# ---------- .env ----------
write_env() {
  local port="$1" domain="$2" db="$3" dburl="$4"
  local profiles="" pg_block=""
  case "$db" in
    2) pg_block="POSTGRES_DB=qingyu
POSTGRES_USER=qingyu
POSTGRES_PASSWORD=$(rand)
";;
  esac

  local app_bind site_url trust
  if [ -n "$domain" ]; then
    app_bind="127.0.0.1:8787"
    site_url="https://$domain"
    trust=1
    profiles="domain"
  else
    app_bind="0.0.0.0:$port"
    site_url="http://$(public_ip):$port"
    # 无域名直连暴露时必须关掉 TRUST_PROXY，否则客户端能伪造
    # X-Forwarded-For 绕过登录锁定和频控
    trust=0
  fi
  [ "$db" = "2" ] && profiles="$profiles postgres"

  cat >"$ENV_FILE" <<EOF
# 轻语博客 · 由 deploy/qy.sh 生成
# 改完执行：cd $INSTALL_DIR && docker compose up -d

SITE_URL=$site_url
SITE_DOMAIN=$domain
PORT=$port
HOST=127.0.0.1
DATA_DIR=./data
TRUST_PROXY=$trust
APP_BIND=$app_bind
COMPOSE_PROFILES=$profiles

BLOG_ADMIN_SETUP_KEY=$(rand)
BLOG_PREVIEW_SECRET=$(rand)
BLOG_WRITE_TOKEN=$(rand)

DATABASE_URL=$dburl

$pg_block
EOF
  ok "已生成 .env"
}

read_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    if dc exec -T app node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      ok "网站已就绪"; return 0
    fi
    sleep 2
  done
  return 1
}

print_access() {
  echo
  printf '  %s部署完成%s\n' "$C_G$C_B" "$C_0"
  printf '  访问地址：%s\n' "$(read_env SITE_URL)"
  printf '  后台地址：%s/admin\n' "$(read_env SITE_URL)"
  printf '  管理员初始化密钥：%s\n' "$(read_env BLOG_ADMIN_SETUP_KEY)"
  printf '  %s密钥只显示这一次，请立刻抄下来%s\n' "$C_Y" "$C_0"
  echo
}

# ---------- 1. 安装 ----------
do_install() {
  installed && warn "已经装过了，继续跑只是重新生成 .env（数据不会丢）"
  step "安装"
  check_docker

  local domain="" port=8787 db dburl=""

  db=$(pick "用哪个数据库？" \
    "SQLite（推荐，零依赖，备份就是一个文件）" \
    "PostgreSQL（内置容器，多进程/高并发更稳）" \
    "我有自己的云数据库（阿里云 RDS / Supabase 等）")
  if [ "$db" = "3" ]; then
    ask "数据库连接串 postgres://用户:密码@主机:5432/库名" "" dburl
    [ -n "$dburl" ] || die "连接串不能为空"
  fi

  ensure_dir
  fetch_code
  [ -f "$INSTALL_DIR/compose.yaml" ] || die "没拿到 compose.yaml，请检查网络"

  write_env "$port" "$domain" "$db" "$dburl"
  echo
  warn "先用 IP + 端口 $port 访问。想绑自定义域名和 HTTPS，装完走菜单第 7 项"

  step "构建并启动（第一次要下载依赖，可能几分钟）"
  ( cd "$INSTALL_DIR" && docker compose up -d --build )
  wait_healthy || warn "暂时没通过健康检查，可以用菜单第 8 项体检排查"
  print_access
}

# ---------- 2. 更新 ----------
do_update() {
  installed || die "还没安装过，请先用菜单第 1 项安装"
  check_docker
  step "更新"
  do_backup quiet || warn "备份失败，仍继续（更新本身不动数据）"
  fetch_code
  step "重建容器"
  ( cd "$INSTALL_DIR" && docker compose up -d --build )
  wait_healthy || warn "健康检查没通过，跑一下菜单第 8 项体检"
  ok "更新完成。出问题用菜单第 3 项回滚"
}

# ---------- 3. 回滚 ----------
do_rollback() {
  installed || die "还没安装过"
  [ -d "$INSTALL_DIR/.git" ] || die "当前不是用 git 装的，没法回滚"
  step "最近的版本"
  git -C "$INSTALL_DIR" log --oneline -n 8 | sed 's/^/  /'
  local target=""
  ask "要回滚到哪个版本（留空取消）" "" target
  [ -n "$target" ] || { ok "已取消"; return 0; }
  do_backup quiet || warn "备份失败，仍继续"
  git -C "$INSTALL_DIR" checkout --quiet "$target"
  ( cd "$INSTALL_DIR" && docker compose up -d --build )
  ok "已回滚到 $target（表结构迁移是幂等的，不会回退数据表）"
}

# ---------- 4. 备份 / 恢复 ----------
do_backup() {
  local quiet="${1:-}"
  installed || die "还没安装过"
  if dc exec -T app node dist/cli/backup.js /data/backups >/dev/null 2>&1; then
    [ -n "$quiet" ] || ok "已备份到 data/backups"
    return 0
  fi
  [ -n "$quiet" ] || err "备份失败"
  return 1
}

list_backups() {
  dc exec -T app sh -c 'ls -1t /data/backups 2>/dev/null | head -20' 2>/dev/null || true
}

restore_wizard() {
  local list; list="$(list_backups)"
  [ -n "$list" ] || { warn "一个备份都没有"; return 0; }
  echo; echo "可选的备份（新的在前）："
  local i=1 line
  while IFS= read -r line; do printf '  %d) %s\n' "$i" "$line"; i=$((i + 1)); done <<<"$list"
  warn "恢复会用备份覆盖当前数据，且不可撤销"
  local n=""
  ask "备份编号（留空取消）" "" n
  [ -n "$n" ] || { ok "已取消"; return 0; }
  local file; file="$(printf '%s\n' "$list" | sed -n "${n}p")"
  [ -n "$file" ] || { err "没有这个编号"; return 1; }
  step "从 $file 恢复"
  dc exec -T app node dist/cli/restore.js "/data/backups/$file"
  ok "恢复完成，请用菜单第 5 项重启服务"
}

do_backup_menu() {
  installed || die "还没安装过"
  local c; c=$(pick "备份与恢复" "马上备份" "从备份恢复" "查看已有备份" "返回")
  case "$c" in
    1) do_backup ;;
    2) restore_wizard ;;
    3) echo; echo "已有备份（新的在前）："; list_backups | sed 's/^/  /'; echo ;;
    4) return 0 ;;
  esac
}

# ---------- 5. 启停与日志 ----------
do_service() {
  installed || die "还没安装过"
  local c; c=$(pick "服务操作" "查看状态" "查看日志" "重启" "停止" "启动" "返回")
  case "$c" in
    1) dc ps ;;
    2) dc logs -f --tail 100 app ;;
    3) step "重启"; ( cd "$INSTALL_DIR" && docker compose restart app ); wait_healthy || warn "健康检查没通过" ;;
    4) step "停止"; dc stop ;;
    5) step "启动"; dc start ;;
    6) return 0 ;;
  esac
}

# ---------- 6. 状态 ----------
do_status() {
  installed || die "还没安装过"
  echo "  目录：$INSTALL_DIR"
  echo "  地址：$(read_env SITE_URL)"
  echo "  版本：$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo 未知)"
  if [ -n "$(read_env DATABASE_URL)" ]; then echo "  数据库：外部 PostgreSQL"; else echo "  数据库：SQLite"; fi
  echo
  dc ps
}

# ---------- 7. 域名与 HTTPS ----------
do_domain() {
  installed || die "还没安装过"
  local c; c=$(pick "域名与 HTTPS" "设置主域名（自动签 HTTPS 证书）" "解除域名（改回 IP+端口）" "返回")
  case "$c" in
    1)
      local d=""
      ask "域名（例如 blog.example.com）" "" d
      [ -n "$d" ] || { err "域名不能为空"; return 1; }
      need_root
      sed -i "s|^SITE_DOMAIN=.*|SITE_DOMAIN=$d|; s|^SITE_URL=.*|SITE_URL=https://$d|" "$ENV_FILE"
      sed -i "s|^APP_BIND=.*|APP_BIND=127.0.0.1:8787|; s|^TRUST_PROXY=.*|TRUST_PROXY=1|" "$ENV_FILE"
      grep -q '^COMPOSE_PROFILES=.*domain' "$ENV_FILE" \
        || sed -i "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=$(read_env COMPOSE_PROFILES) domain|" "$ENV_FILE"
      ( cd "$INSTALL_DIR" && docker compose --profile domain up -d )
      ok "已切换到 https://$d"
      warn "签证书要求域名已解析到本机、且 80/443 连得通，不行就跑体检"
      ;;
    2)
      need_root
      local pc port
      pc=$(pick "改用哪个端口？" "8080" "8787（默认）" "3000" "其他（手动输入）")
      case "$pc" in
        1) port=8080 ;;
        2) port=8787 ;;
        3) port=3000 ;;
        4) ask "端口号" "8080" port ;;
      esac
      case "$port" in
        ''|*[!0-9]*) err "端口必须是数字"; return 1 ;;
      esac
      sed -i "s|^SITE_DOMAIN=.*|SITE_DOMAIN=|; s|^SITE_URL=.*|SITE_URL=http://$(public_ip):$port|" "$ENV_FILE"
      sed -i "s|^APP_BIND=.*|APP_BIND=0.0.0.0:$port|; s|^TRUST_PROXY=.*|TRUST_PROXY=0|" "$ENV_FILE"
      sed -i "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=|" "$ENV_FILE"
      ( cd "$INSTALL_DIR" && docker compose up -d )
      ok "已改回 IP+端口：http://$(public_ip):$port"
      ;;
    3) return 0 ;;
  esac
}

# ---------- 8. 体检 ----------
do_doctor() {
  echo "  项目体检"
  echo
  if have docker && docker info >/dev/null 2>&1; then ok "Docker 在运行"; else err "Docker 没运行或没权限"; fi
  if installed; then ok "已安装（$INSTALL_DIR）"; else err "还没安装"; return 0; fi
  if dc ps --status running 2>/dev/null | grep -q qingyu-app; then ok "容器在跑"; else err "容器没起来"; fi
  if wait_healthy >/dev/null 2>&1; then ok "应用健康检查通过"; else err "应用健康检查失败"; fi
  local d; d=$(df -h / 2>/dev/null | awk 'NR==2{print $4}'); [ -n "$d" ] && ok "磁盘剩余 $d"
  local m; m=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}'); [ -n "$m" ] && ok "可用内存 ${m}MB"
  echo
  warn "网站打不开：先看第 5 项的日志，再试重启"
}

# ---------- 9. 清理 ----------
do_clean() {
  check_docker
  step "可以清理的东西"
  dc system df 2>/dev/null | sed 's/^/  /' || true
  echo
  warn "只清理悬空镜像和构建缓存，不会碰数据库、备份和上传的文件"
  local c; c=$(pick "要清理吗？" "确认清理" "算了")
  [ "$c" = "1" ] || { ok "已取消"; return 0; }
  docker image prune -f --filter "dangling=true"
  docker builder prune -f
  ok "清理完成"
}

# ---------- 入口 ----------
usage() {
  cat <<'EOF'
轻语博客 · 部署助手

  bash deploy/qy.sh            打开菜单（推荐，全程只选数字）
  bash deploy/qy.sh <命令>     直接执行一条命令

命令：
  install    安装（首次部署）
  update     更新到最新版（自动先备份）
  rollback   回滚到指定版本
  backup     备份
  restore    从备份恢复
  logs       看日志
  restart    重启
  status     看部署状态
  domain     配域名和 HTTPS
  doctor     体检（网站打不开先跑这个）
  clean      清理 Docker 缓存
EOF
}

menu() {
  while :; do
    clear 2>/dev/null || true
    cat <<EOF

  ${C_B}轻语博客 · 部署助手${C_0}

  1) 安装         首次部署，什么都不填也能装
  2) 更新         拉到最新版（自动先备份）
  3) 回滚         退回上一个版本
  4) 备份恢复     备份 / 恢复 / 查看备份
  5) 启停与日志   状态 / 日志 / 重启 / 停止 / 启动
  6) 查看状态     当前地址、版本、数据库
  7) 域名与HTTPS  自动签证书，或改回 IP+端口
  8) 体检         网站打不开、传不了图，先跑这个
  9) 清理磁盘     清 Docker 缓存（不碰数据）
  0) 退出

EOF
    local c; c=$(menu_read)
    case "$c" in
      1) do_install ;;
      2) do_update ;;
      3) do_rollback ;;
      4) do_backup_menu ;;
      5) do_service ;;
      6) do_status ;;
      7) do_domain ;;
      8) do_doctor ;;
      9) do_clean ;;
    esac
    pause
  done
}

main() {
  case "${1:-}" in
    "") menu ;;
    install) do_install ;;
    update) do_update ;;
    rollback) do_rollback ;;
    backup) do_backup ;;
    restore) restore_wizard ;;
    logs) dc logs -f --tail 100 app ;;
    restart) installed || die "还没安装过"; dc restart app ;;
    start) installed || die "还没安装过"; dc start ;;
    stop) installed || die "还没安装过"; dc stop ;;
    status) do_status ;;
    domain) do_domain ;;
    doctor) do_doctor ;;
    clean) do_clean ;;
    -h|--help|help) usage ;;
    *) usage; die "不认识「$1」这个命令" ;;
  esac
}

main "$@"
