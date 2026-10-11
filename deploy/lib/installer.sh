# ============================================================
# installer.sh —— 安装流程：预检、向导、分步安装与安装后引导
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
interact_mode() {
  # 参数已指定 / 非升级场景已在 resolve_mode 里处理，这里只在「全新安装且未给参数」时提问
  # 走过安装向导后所有选项都已定下来，不再重复问一遍
  # 默认零配置：只有显式 --wizard 才提问，其余一律走自动决策
  [ "$WIZARD_DONE" = "1" ] && return 0
  [ "$WIZARD_FORCE" != "1" ] && return 0
  [ -n "$DOMAIN" ] && return 0
  [ -n "$APP_PORT" ] && return 0
  [ -f "$INSTALL_DIR/.env" ] && return 0

  # ---- 环境报告（无论是否能交互都打印，让用户心里有数）----
  local distro arch ip
  distro=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-未知}") || distro="未知"
  arch="$(uname -m 2>/dev/null || echo '未知')"
  ip="$(detect_ip)"

  ui_section "环境检查"
  ui_kv "系统"     "${distro} / ${arch}"
  ui_kv "公网 IP"  "${ip}"
  ui_kv "curl"     "$(have curl && echo '已安装' || echo '未安装，将自动安装')"
  ui_kv "Docker"   "$(docker_ready && echo '已就绪' || echo '未安装，将自动安装')"
  local avail
  avail=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')
  [ -n "$avail" ] && ui_kv "可用磁盘" "$((avail / 1024)) MB"

  # ---- 端口检测 ----
  local ports_free=1
  port_in_use 80 && ports_free=0
  port_in_use 443 && ports_free=0
  if [ "$ports_free" -eq 1 ]; then
    ui_kv "端口 80/443" "空闲（可启用自动 HTTPS）"
  else
    ui_kv "端口 80/443" "已被占用"
  fi

  can_ask || {
    # 非交互：沿用自动决策，只说明会怎么做
    echo
    if [ "$ports_free" -eq 1 ]; then
      log "未指定域名，将按 IP + 端口部署（之后可在后台改站点地址）"
    else
      log "80/443 被占用，将按自定义端口部署"
    fi
    return 0
  }

  echo
  if [ "$ports_free" -eq 1 ]; then
    log "请选择部署方式"
    ui_opt 1 "域名 + 自动 HTTPS" "推荐；需要域名解析到 ${ip}"
    ui_opt 2 "IP + 端口" "无需域名，纯 HTTP"
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
  # 默认零配置：数据库直接用 SQLite，其余交给后台设置
  [ "$WIZARD_DONE" = "1" ] && return 0
  [ "$WIZARD_FORCE" != "1" ] && return 0
  [ -n "$DB_KIND" ] && return 0
  [ -n "$DATABASE_URL_OPT" ] && return 0
  [ -f "$INSTALL_DIR/.env" ] && return 0

  if ! can_ask; then
    DB_KIND="sqlite"
    log "数据库：默认 SQLite（需要换 PostgreSQL 可加 --db postgres）"
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

wizard_probe() {
  WIZ_DISTRO="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-未知}")" || WIZ_DISTRO="未知"
  WIZ_ARCH="$(uname -m 2>/dev/null || echo '未知')"
  WIZ_IP="$(detect_ip 2>/dev/null || true)"
  [ -n "$WIZ_IP" ] || WIZ_IP="未探测到（不影响安装）"
  WIZ_DISK="$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024}')"
  [ -n "$WIZ_DISK" ] || WIZ_DISK="?"
  # 80/443 一起判断（port_in_use_pair 返回 0 = 两个都空闲）
  if port_in_use_pair; then WIZ_PORTS=1; else WIZ_PORTS=0; fi
}

wiz_access() {
  # 命令行已经给了 --domain 或 --port → 不再问
  if [ -n "$DOMAIN" ] || [ -n "$APP_PORT" ]; then WIZ_ACT=next; return 0; fi
  echo
  ui_section "第 1 问 · 别人怎么访问你的博客？"
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
  ui_section "第 2 问 · 域名是什么？"
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
  ui_section "第 4 问 · 要不要每天自动备份？"
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
  ui_section "第 5 问 · 配置邮件通知吗？（文章订阅 / 评论提醒）"
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

# 第 6 问：AI 摘要与对象存储。都可留空跳过（留空 = 之后在后台「设置」里补）。

wiz_extra() {
  if [ -n "$AI_BASE_OPT" ] && [ -n "$AI_KEY_OPT" ]; then WIZ_ACT=next; return 0; fi
  ui_section "第 6 问 · 现在配 AI 摘要吗？（可留空跳过）"
  ui_hint "AI 用来自动生成文章摘要；留空也能用，之后到后台「设置 → AI」随时补。"
  ask "AI 接口地址（留空跳过，例如 https://api.deepseek.com/v1）" ""
  [ -z "${REPLY:-}" ] && { WIZ_ACT=next; return 0; }
  AI_BASE_OPT="$REPLY"
  ask "API Key" ""
  AI_KEY_OPT="${REPLY:-}"
  if [ -z "$AI_KEY_OPT" ]; then
    warn "没填 Key，AI 暂不启用（之后可在后台补）"
    WIZ_ACT=next
    return 0
  fi
  ask "模型名" "deepseek-chat"
  AI_MODEL_OPT="${REPLY:-deepseek-chat}"
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
  ui_kv "访问方式" "${mode}"
  ui_kv "数据库"   "${db}"
  ui_kv "定时备份" "${backup}"
  ui_kv "邮件通知" "${mail}"
  ui_kv "安装目录" "${INSTALL_DIR}"
  ui_kv "代码版本" "${REPO}@${REF}"
  [ -n "$TIMEZONE" ] && ui_kv "系统时区" "${TIMEZONE}"
  [ -n "$AI_BASE_OPT" ] && [ -n "$AI_KEY_OPT" ] && ui_kv "AI 摘要" "${AI_MODEL_OPT:-未指定模型}（${AI_BASE_OPT}）"
  [ -n "$S3_ENDPOINT_OPT" ] && ui_kv "对象存储" "S3 ${S3_ENDPOINT_OPT}"
  # 必须以 0 结束：上面那行是 `[ ... ] && ...`，条件为假时整条语句返回 1，
  # 函数返回值就变成 1 —— 在 set -e 下会把调用方直接打断（向导走到复核页就静默退出）。
  return 0
}

wiz_confirm() {
  echo
  ui_section "最后一步 · 确认一下"
  wizard_summary
  echo
  echo "    回车 = 开始安装      b = 改上一题      q = 放弃"
  echo "    1 = 访问方式   2 = 数据库   3 = 备份   4 = 邮件   5 = AI / 存储"
  ask "你的选择" ""
  case "${REPLY:-}" in
    q|Q)      die "已放弃安装（随时可以重新运行本脚本）" ;;
    b|B)      WIZ_ACT=back ;;
    1)        WIZ_ACT="jump:0" ;;
    2)        WIZ_ACT="jump:2" ;;
    3)        WIZ_ACT="jump:3" ;;
    4)        WIZ_ACT="jump:4" ;;
    5)        WIZ_ACT="jump:5" ;;
    *)        WIZ_ACT=next ;;
  esac
}

run_wizard() {
  wizard_probe
  {
    ui_banner "安装向导" "轻语博客 · 自托管通用版"
    ui_kv "这台机器" "${WIZ_DISTRO} / ${WIZ_ARCH}"
    ui_kv "可用磁盘" "${WIZ_DISK} MB"
    ui_kv "公网 IP"  "${WIZ_IP}"
    echo
    ui_hint "接下来几个问题，每个都给好了推荐答案 —— 直接回车就是推荐方案。"
    ui_hint "输入 b 回到上一题，输入 q 放弃安装。"
  } 2>/dev/null > /dev/tty || true

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
  ui_banner "演练模式（--dry-run）" "只打印将要做什么，不实际执行"
  wizard_summary
  echo
  ui_section "将要执行的步骤"
  ui_opt 1 "检查并准备系统环境" "curl / git / Docker"
  ui_opt 2 "获取代码" "${REPO}@${REF}"
  ui_opt 3 "生成配置文件" "${INSTALL_DIR}/.env（含随机密钥）"
  ui_opt 4 "起飞前检查" "资源 / 端口 / 域名 / 防火墙"
  ui_opt 5 "构建镜像并启动容器" ""
  [ "$WIZ_BACKUP" = "1" ] && ui_opt 6 "安装定时备份" "每天 ${AT_TIME}，保留 ${KEEP_N} 份"
  echo
  ui_rule
  ui_hint "现在不会做：不装 Docker、不下载代码、不写 .env、不启动容器。"
  ui_kv "下一步" "去掉 --dry-run 再跑一次即可"
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

post_install_guide() {
  local site_url key
  site_url="$(env_value SITE_URL)"
  [ -n "$site_url" ] || site_url="http://localhost:$(local_health_port)"
  key="$(env_value BLOG_ADMIN_SETUP_KEY)"
  ui_banner "接下来三件事" "部署已经跑起来了，剩下的就是登录看看"
  ui_kv "1) 打开站点" "${site_url}"
  ui_hint   "首次打开可能要等十几秒（容器正在初始化数据库）"
  echo
  ui_kv "2) 设置密码" "${site_url}/admin"
  if [ -n "$key" ]; then
    ui_hint "安装密钥：${C_B}${key}${C_RESET}（已存进 .env，忘了随时跑 $0 info 查看）"
  fi
  ui_hint "设完密码后，到「设置 → 站点」把站名、简介改成你自己的"
  echo
  ui_kv "3) 核对地址" "${site_url}"
  ui_hint "如果是 localhost / 内网 IP，改 ${INSTALL_DIR}/.env 里的 SITE_URL 后执行 $0 restart"
  echo
  ui_rule
  ui_kv "出问题先跑" "$0 doctor"
  ui_hint "Docker / 容器 / 端口 / 证书 / 磁盘 逐项检查"
  ui_kv "看实时日志" "$0 logs"
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
      if lowmem_mode; then
        warn "  已自动启用低内存构建：两个 npm 构建改为串行执行 + 压住 Node 堆上限"
      fi
      warn "  更省的两个办法：① 用现成镜像（不本地构建）："
      warn "                   $0 install --prebuilt"
      warn "                 ② 先在本地 / 大内存机器构建好镜像再传上来"
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
    resolved=$(domain_resolved_ips "$DOMAIN" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
    if [ -z "$resolved" ]; then
      warn "域名 ${DOMAIN} 解析不出来 —— Let's Encrypt 签发证书会失败"
      warn "请先添加 A 记录（指向本机公网 IP）再重新执行；只加 AAAA 记录是不够的"
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

summary() {
  # 以 .env 的 SITE_URL 为准：两种模式（域名 / IP+端口）共用同一段输出
  local site_url; site_url="$(env_value SITE_URL)"
  [ -n "$site_url" ] || site_url="http://localhost:8787"
  ui_banner "部署完成" "轻语博客 · 自托管通用版"
  ui_kv "访问地址"  "${C_B}${site_url}${C_RESET}"
  ui_kv "管理后台"  "${site_url}/admin"
  ui_kv "安装目录"  "${INSTALL_DIR}"
  local db_url; db_url="$(env_value DATABASE_URL)"
  if [ -n "$db_url" ]; then
    local db_host; db_host="$(printf '%s' "$db_url" | sed -E 's#^[^:]+://[^@]*@([^/:]+).*#\1#')"
    if [ -n "$DATABASE_URL_OPT" ] || [ "$DB_KIND" = "external" ]; then
      ui_kv "数据库" "PostgreSQL（外部）${db_host}"
    else
      ui_kv "数据库" "PostgreSQL（内置容器）${db_host}"
    fi
    ui_kv "数据目录" "${INSTALL_DIR}/data（上传 + 备份；数据库在 PostgreSQL 卷里）"
  else
    ui_kv "数据库" "SQLite（${INSTALL_DIR}/data/qingyu.db）"
    ui_kv "数据目录" "${INSTALL_DIR}/data（SQLite + 上传 + 备份）"
  fi
  echo
  if [ -n "${SETUP_KEY_SHOWN:-}" ]; then
    ui_kv "初始化密钥" "${C_B}${SETUP_KEY_SHOWN}${C_RESET}"
    ui_hint "首次打开 /admin 时填写，已保存在 .env 的 BLOG_ADMIN_SETUP_KEY"
  else
    ui_kv "初始化密钥" "见 ${INSTALL_DIR}/.env 中的 BLOG_ADMIN_SETUP_KEY"
  fi
  echo
  ui_section "常用操作"
  echo "      docker compose -f ${INSTALL_DIR}/compose.yaml logs -f app"
  echo "      ${INSTALL_DIR}/deploy/install.sh upgrade"
  echo "      ${INSTALL_DIR}/deploy/install.sh backup"
  echo "      ${INSTALL_DIR}/deploy/install.sh info      # 随时查看访问地址、初始化密钥和版本"
  echo "      ${INSTALL_DIR}/deploy/install.sh shortcut  # 设置终端快捷键（默认敲 k 打开运维菜单）"
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
  compose_build
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
  # 默认零配置：不提问，脚本自己决定域名 / 端口 / 数据库；加--wizard 才逐项确认
  step_begin "确定访问方式"
  if [ "$DRY_RUN" = "1" ] && [ "$WIZARD_FORCE" != "1" ] && ! can_ask; then
    log "演练模式：不提问，使用默认值"
  else
    wizard_maybe
  fi
  [ "$WIZARD_FORCE" != "1" ] && ui_hint "零配置模式：其余选项（站名 / 密码 / AI / 邮件 / 图床）装完在后台「设置」里填"
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
  shortcut_maybe
  summary
  post_install_guide
}

# ---------- 更新：先查远端有没有新代码，有才动 ----------
# 远端最新 commit 的完整 SHA。
# git 检出优先用 `git ls-remote`（直连仓库、能拿到分支真实 HEAD）；
# 没有 git 就退回 Atom feed 里的第一条（压缩包安装的老路径）。
# 两个来源都试过还拿不到 → 返回空，调用方要能区分「已是最新」和「查不到」。
