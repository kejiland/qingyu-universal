# ============================================================
# config.sh —— .env 生成与读写、配置档、运行状态机
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
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
# 别名域名（空格分隔）：主域名之外再绑几个域名指向同一站点，各自带一张 HTTPS 证书
SITE_ALIASES=
DATA_DIR=${DATA_DIR_OPT:-./data}
# 数据库：留空使用 SQLite 文件；填写连接串则切换到 PostgreSQL
# 数据库类型由 deploy/install.sh 决定（--db sqlite|postgres 或交互选择）
DATABASE_URL=$database_url
# 仅内置 PostgreSQL 容器需要；使用外部数据库时留空
POSTGRES_DB=$postgres_db
POSTGRES_USER=$postgres_user
POSTGRES_PASSWORD=$postgres_password
# 可选：Redis / Valkey 限流与去重；留空使用数据库 KV
REDIS_URL=$REDIS_OPT
APP_BIND=$app_bind
COMPOSE_PROFILES=$compose_profiles
TRUST_PROXY=$trust_proxy

# 管理员邮箱（通知 / 找回密码；留空可之后在后台补）
BLOG_ADMIN_EMAIL=$ADMIN_EMAIL_OPT
# 日志级别 error|warn|info|debug（留空 = 默认）
LOG_LEVEL=$LOG_LEVEL_OPT
# 首次打开 /admin 时需要填写的安装密钥
BLOG_ADMIN_SETUP_KEY=$setup_key
# 脚本 / CI 长期写入令牌
BLOG_WRITE_TOKEN=$write_token

# 对象存储（留空 = 本地磁盘）
S3_ENDPOINT=$S3_ENDPOINT_OPT
S3_REGION=${S3_REGION_OPT:-auto}
S3_ACCESS_KEY_ID=$S3_KEY_ID_OPT
S3_SECRET_ACCESS_KEY=$S3_SECRET_OPT
S3_MEDIA_BUCKET=$S3_BUCKET_OPT
S3_MEDIA_PUBLIC_BASE=$S3_PUBLIC_BASE_OPT
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
AI_BASE_URL=$AI_BASE_OPT
AI_API_KEY=$AI_KEY_OPT
AI_MODEL=$AI_MODEL_OPT
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

port_in_use_pair() {
  local free=1
  port_in_use 80 && free=0
  port_in_use 443 && free=0
  return $(( 1 - free ))
}

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
  [ -n "$ADMIN_EMAIL_OPT" ] && { env_set BLOG_ADMIN_EMAIL "$ADMIN_EMAIL_OPT"; n=$((n + 1)); }
  [ -n "$LOG_LEVEL_OPT" ] && { env_set LOG_LEVEL "$LOG_LEVEL_OPT"; n=$((n + 1)); }
  [ -n "$REDIS_OPT" ]     && { env_set REDIS_URL "$REDIS_OPT"; n=$((n + 1)); }
  [ -n "$AI_BASE_OPT" ]   && { env_set AI_BASE_URL "$AI_BASE_OPT"; n=$((n + 1)); }
  [ -n "$AI_KEY_OPT" ]    && { env_set AI_API_KEY "$AI_KEY_OPT"; n=$((n + 1)); }
  [ -n "$AI_MODEL_OPT" ]  && { env_set AI_MODEL "$AI_MODEL_OPT"; n=$((n + 1)); }
  [ -n "$S3_ENDPOINT_OPT" ] && { env_set S3_ENDPOINT "$S3_ENDPOINT_OPT"; n=$((n + 1)); }
  [ -n "$S3_KEY_ID_OPT" ]   && { env_set S3_ACCESS_KEY_ID "$S3_KEY_ID_OPT"; n=$((n + 1)); }
  [ -n "$S3_SECRET_OPT" ]   && { env_set S3_SECRET_ACCESS_KEY "$S3_SECRET_OPT"; n=$((n + 1)); }
  [ -n "$S3_BUCKET_OPT" ]   && { env_set S3_MEDIA_BUCKET "$S3_BUCKET_OPT"; n=$((n + 1)); }
  [ -n "$S3_PUBLIC_BASE_OPT" ] && { env_set S3_MEDIA_PUBLIC_BASE "$S3_PUBLIC_BASE_OPT"; n=$((n + 1)); }
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
ADMIN_EMAIL=$ADMIN_EMAIL_OPT
DATA_DIR=$DATA_DIR_OPT
LOG_LEVEL=$LOG_LEVEL_OPT
REDIS=$REDIS_OPT
AI_BASE_URL=$AI_BASE_OPT
AI_API_KEY=$AI_KEY_OPT
AI_MODEL=$AI_MODEL_OPT
S3_ENDPOINT=$S3_ENDPOINT_OPT
S3_REGION=$S3_REGION_OPT
S3_KEY_ID=$S3_KEY_ID_OPT
S3_SECRET=$S3_SECRET_OPT
S3_BUCKET=$S3_BUCKET_OPT
S3_PUBLIC_BASE=$S3_PUBLIC_BASE_OPT
EOF
  chmod 600 "$f" 2>/dev/null || true
  log "配置档已保存到 ${f}（含 SMTP 密码，权限已设为 600）"
  echo "    下次复用： bash deploy/install.sh install --config ${f}"
}

# ============================================================
# 安装后引导 + 自动体检
# ============================================================
