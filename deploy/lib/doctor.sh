# ============================================================
# doctor.sh —— 系统体检：分级诊断与修复建议
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
doc_head() {
  ui_section "$1"
}

doc_ok() {
  printf '    %s%s%s %s\n' "$C_GREEN" "$G_OK" "$C_RESET" "$1"
  DOCTOR_OK=$((DOCTOR_OK + 1))
}

doc_warn() {
  printf '    %s%s%s %s\n' "$C_YELLOW" "$G_WARN" "$C_RESET" "$1"
  DOCTOR_WARN=$((DOCTOR_WARN + 1))
  if [ -n "${2:-}" ]; then
    printf '        %s→ %s%s\n' "$C_GREY" "$2" "$C_RESET"
  fi
}

doc_fail() {
  printf '    %s%s%s %s\n' "$C_RED" "$G_FAIL" "$C_RESET" "$1"
  DOCTOR_FAIL=$((DOCTOR_FAIL + 1))
  if [ -n "${2:-}" ]; then
    printf '        %s→ %s%s\n' "$C_GREY" "$2" "$C_RESET"
  fi
}

doc_info() {
  printf '      %s%s%s\n' "$C_GREY" "$1" "$C_RESET"
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
    local domain resolved probe cert cert_end cert_left
    domain="$(env_value SITE_DOMAIN)"
    if [ -z "$domain" ]; then
      doc_warn "没有配置域名" "用 bash ${install_script} domain set 你的域名 启用 HTTPS"
    else
      # doctor 里也要用「A + AAAA 全量比对」：域名同时有 v4/v6 记录时，
      # 只看第一条会误判成解析不一致（老逻辑的坑）
      if domain_points_here "$domain"; then
        doc_ok "域名 ${domain} 解析到 $(domain_resolved_ips "$domain" | tr '\n' ' ' | sed 's/[[:space:]]*$//')，与本机一致"
      else
        resolved="$(domain_resolved_ips "$domain" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
        if [ -z "$resolved" ]; then
          doc_fail "域名 ${domain} 解析不到（证书也签发不了）" "到 DNS 控制台加 A 记录指向 ${ip}"
        else
          doc_warn "域名 ${domain} 解析到 ${resolved}，本机公网 IP 是 ${ip}" "确认 A 记录指向 ${ip}"
        fi
      fi
      # AAAA 有记录但机器没有 v6 出口：证书照签，但走 v6 的访客打不开
      if domain_resolved_ips "$domain" | grep -q ':'; then
        if [ -z "$(detect_ip6 2>/dev/null || true)" ]; then
          doc_warn "域名有 AAAA 记录，但这台机器没有公网 IPv6" "给机器开 IPv6，或删掉 AAAA 记录，否则部分访客打不开"
        else
          doc_ok "IPv6 记录与本机 IPv6 出口都正常"
        fi
      fi
      probe="$(curl -ksS --max-time 6 "https://${domain}/healthz" 2>/dev/null || true)"
      if [ -n "$probe" ]; then
        doc_ok "HTTPS 对外可访问"
      else
        doc_warn "HTTPS 从本机探测不到（证书未签发，或安全组没放行 443）" "docker logs --tail 30 qingyu-caddy"
      fi
      # 别名域名同样要各自解析到本机、各自证书有效 —— 少了 alias 检查，
      # 「主域名正常但备用域名 502」这类问题只能靠用户自己撞出来
      local alias
      for alias in $(domain_aliases); do
        if [ "$alias" = "$domain" ]; then
          doc_warn "别名 ${alias} 与主域名重复" "domain rm ${alias} 把它摘掉"
          continue
        fi
        if ! domain_points_here "$alias"; then
          doc_warn "别名域名 ${alias} 没解析到本机" "到 DNS 控制台加 A 记录指向 ${ip}；否则这个域名打不开"
        elif ! curl -ksS --max-time 6 -o /dev/null "https://${alias}/healthz" 2>/dev/null; then
          doc_warn "别名域名 ${alias} 的 HTTPS 探测失败" "证书可能还没签发：docker logs --tail 30 qingyu-caddy"
        else
          doc_ok "别名域名 ${alias} 正常"
        fi
      done
      # 证书到期时间：签发成功不等于长期有效，到期前 15 天就要提醒
      cert="$INSTALL_DIR/data/caddy/certificates/${domain}/${domain}.crt"
      cert_end="$(cert_expiry_date "$cert")"
      cert_left="$(cert_days_left "$cert_end")"
      if [ -n "$cert_end" ] && [ -n "$cert_left" ]; then
        if [ "$cert_left" -lt 0 ]; then
          doc_fail "HTTPS 证书已于 ${cert_end} 过期" "确认 80/443 通畅后执行：bash ${install_script} restart"
        elif [ "$cert_left" -le 15 ]; then
          doc_warn "HTTPS 证书 ${cert_end} 到期，只剩 ${cert_left} 天" "Caddy 会自动续签；若未更新看：docker logs --tail 30 qingyu-caddy"
        else
          doc_ok "HTTPS 证书有效，${cert_end} 到期（还剩 ${cert_left} 天）"
        fi
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
  # 磁盘紧张时要能指出「是谁吃掉的」：备份只占一点，真正的大头往往是 Docker 构建缓存
  local reclaim_gb=0
  # 只报构建缓存：它全额可回收，doctor 的提示才准
  reclaim_gb="$(clean_build_cache_gb)"
  [ -n "$reclaim_gb" ] || reclaim_gb=0
  local fix_hint="清理 ${INSTALL_DIR}/data/backups，或扩容"
  if [ -n "$reclaim_gb" ] && awk -v a="$reclaim_gb" 'BEGIN{exit !(a>=0.5)}'; then
    fix_hint="bash $0 clean 可回收约 ${reclaim_gb} GB 的构建缓存（外加部分悬空镜像），数据不动"
  fi
  if [ -n "$avail_kb" ]; then
    if [ "$avail_kb" -lt 204800 ]; then
      doc_fail "磁盘只剩 $((avail_kb / 1024)) MB，随时会写满" "$fix_hint"
    elif [ "$avail_kb" -lt 1048576 ]; then
      doc_warn "磁盘可用 $((avail_kb / 1024)) MB" "$fix_hint"
    else
      doc_ok "磁盘可用 $((avail_kb / 1024)) MB（构建缓存可回收 ${reclaim_gb} GB）"
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
