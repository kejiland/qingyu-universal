# ============================================================
# service.sh —— 服务启停、状态、日志与部署信息
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
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

  ui_banner "部署信息" "轻语博客 · 自托管通用版"
  ui_kv "访问地址" "${C_B}${site_url:-（未设置）}${C_RESET}"
  ui_kv "管理后台" "${site_url:-}/admin"
  if [ -n "$setup_key" ]; then
    ui_kv "初始化密钥" "${C_B}${setup_key}${C_RESET}"
    ui_hint "首次打开后台设置管理员密码时需要；重置密码也需要"
  else
    ui_kv "初始化密钥" "（未设置——首次初始化无保护，建议补上）"
  fi
  if [ -n "$write_token" ]; then
    ui_kv "写入令牌" "${write_token:0:8}…（脚本/CI 调用写接口用，完整值见 .env）"
  fi

  ui_section "部署方式"
  if has_profile domain "$profiles"; then
    ui_kv "模式"     "域名 + 自动 HTTPS"
    ui_kv "域名"     "${domain:-（未设置）}"
    ui_kv "对外端口" "80 / 443（由 Caddy 占用）"
  else
    ui_kv "模式" "纯 HTTP（未启用 Caddy / 无证书）"
    ui_kv "端口" "${port:-（未知）}"
    [ -n "$domain" ] && ui_kv "域名" "$domain"
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
    ui_kv "数据库" "${db_kind_label} ${db_host}"
    ui_kv "数据目录" "${INSTALL_DIR}/data（上传 + 备份；数据存 PostgreSQL 卷）"
  else
    ui_kv "数据库" "SQLite"
    ui_kv "数据目录" "${INSTALL_DIR}/data（SQLite + 上传 + 备份；容器内 /data 卷）"
  fi
  [ -n "$deploy_time" ] && ui_kv "部署时间" "${deploy_time}"

  # 运行状态：容器在跑就问 /healthz，否则跳过
  local hp health
  hp="$(local_health_port)"; [ -n "$hp" ] || hp=8787
  health="$(curl -fsS --max-time 3 "http://127.0.0.1:${hp}/healthz" 2>/dev/null)" || health=""
  echo
  if [ -z "$health" ]; then
    ui_section "运行状态"
    doc_warn "服务未响应（容器可能没在运行）" "执行 $0 status 查看"
  else
    ui_section "运行状态"
    local version revision storage database_status posts applied skipped uptime
    version="$(health_string_field version)"
    revision="$(health_string_field revision)"
    storage="$(health_string_field storage)"
    database_status="$(health_string_field databaseStatus)"
    posts="$(health_number_field posts)"
    applied="$(health_number_field applied)"
    skipped="$(health_number_field skipped)"
    uptime="$(health_number_field uptime)"

    [ -n "$version" ] && ui_kv "版本" "${version}"
    [ -n "$revision" ] && [ "$revision" != "null" ] && ui_kv "构建版本" "${revision}"
    [ -n "$posts" ] && ui_kv "文章数" "${posts}"
    if [ -n "$storage" ]; then
      [ "$storage" = "local" ] && storage="本地磁盘" || storage="S3 兼容对象存储"
      ui_kv "存储方式" "${storage}"
    fi
    if [ -n "$applied" ] || [ -n "$skipped" ]; then
      ui_kv "数据库迁移" "已应用 ${applied:-0} / 已跳过 ${skipped:-0}"
    fi
    [ -n "$uptime" ] && ui_kv "运行时长" "$(human_uptime "$uptime")"
    if [ "$database_status" = "error" ]; then
      ui_kv "数据库" "SQLite（异常）"
    else
      ui_kv "数据库" "SQLite（${INSTALL_DIR}/data/qingyu.db）"
    fi
  fi

  # 安全提示
  if [ "$profiles" != "domain" ]; then
    ui_section "安全提示"
    doc_warn "当前为纯 HTTP，管理后台的登录密码是明文传输的。" \
      "让出 80/443 后执行 $0 upgrade --domain 你的域名 可启用 HTTPS"
  fi
  echo
  return 0
}
# ---------- 网络测速 ----------
# 借鉴 kejilion.sh 测试脚本合集里的「网络测速」：先看延迟，再看带宽。
# 全程只发请求不装任何东西；系统里没有 speedtest-cli 时用 curl 拉固定大小文件近似测速，
# 并明确告诉用户这是近似值，免得把估算当精确结果。

# 单个目标的握手 + 首字节 + 总耗时（毫秒）。走 curl 而非 ping，测的是「真实访问」路径。

cmd_status()   { compose ps; echo; curl -fsS "http://127.0.0.1:$(local_health_port)/healthz" || true; echo; }
