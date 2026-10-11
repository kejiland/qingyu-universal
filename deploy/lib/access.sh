# ============================================================
# access.sh —— 访问入口：IP+端口、域名、HTTPS 证书与防火墙
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
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
  resolved=$(domain_resolved_ips "$DOMAIN")
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

ui_ok()   { printf '    %s%s%s %s\n' "$C_GREEN" "${G_OK:-+}" "$C_RESET" "$*"; }

ui_warn() { printf '    %s%s%s %s\n' "$C_YELLOW" "${G_WARN:-!}" "$C_RESET" "$*"; }
# ---------- 域名：查看 / 切换 / 检查 ----------
# 装完之后换域名是这个脚本最常被问到的操作，但它牵扯到 .env 四个字段
# （SITE_URL / SITE_DOMAIN / APP_BIND / COMPOSE_PROFILES）+ TRUST_PROXY、
# 防火墙 80/443 放行、以及 Caddy 是否启用，漏改任何一项都会得到
# 「能打开但没有 HTTPS」或「登录后被踢」这类难查的问题，所以单独做成子命令。
# 用法：
#   domain              查看当前域名与解析/证书状态
#   domain set X        切到 X（自动 HTTPS）
#   domain port [8080]  退回 IP + 端口模式（X 换成 --port）
#   domain off          同 port，但保留原来的端口号

# 域名当前是否解析到本机（拿本机公网 IP 比对，私有网段 / 未探测到时只报解析结果）
# 域名解析到的全部地址（A + AAAA）。getent ahosts 在 Debian/Ubuntu 上都有；
# 个别精简系统上没有，就退回只查 A 记录，至少能看到 IPv4。

domain_resolved_ips() {
  local d="$1" out=""
  out="$(getent ahosts "$d" 2>/dev/null | awk '{print $1}' | sort -u)"
  [ -n "$out" ] || out="$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -n1)"
  printf '%s' "$out"
}

# 只要解析结果里有一个地址指向本机就算过 —— 域名同时有 A 和 AAAA 时，
# 旧写法「取第一条再和 IPv4 比」会因为取到 v6 而误报不一致。

domain_points_here() {
  local d="$1" list ip
  list="$(domain_resolved_ips "$d")"
  [ -n "$list" ] || return 1
  ip="$(detect_ip 2>/dev/null || true)"
  case "$ip" in
    ''|10.*|192.168.*|127.*) return 0 ;;
  esac
  printf '%s\n' "$list" | grep -Fxq "$ip"
}

# 证书到期时间：直接读 Caddy 落在数据卷里的证书文件，不联网、不要求 root。
# 没装 openssl 或证书还没签发时返回空，调用方自己降级显示。

cert_expiry_date() {
  local cert="$1"
  [ -f "$cert" ] && have openssl || return 0
  openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2
}

# 剩余天数（负数 = 已过期）。只有 GNU date 认 -d；读不到就返回空，只显示到期日期。

cert_days_left() {
  local end="${1:-}" end_ts now
  [ -n "$end" ] || return 0
  end_ts="$(date -d "$end" +%s 2>/dev/null || true)"
  case "$end_ts" in ''|*[!0-9]*) return 0 ;; esac
  now="$(date +%s 2>/dev/null || true)"
  case "$now" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s' $(((end_ts - now) / 86400))
}

# 只看不改：当前模式、解析指向、端口占用、证书是否已经签发

domain_status() {
  local profiles domain site_url app_bind port caddy=0 resolved cert cert_end cert_left aliases
  profiles="$(env_value COMPOSE_PROFILES)"
  domain="$(env_value SITE_DOMAIN)"
  site_url="$(env_value SITE_URL)"
  app_bind="$(env_value APP_BIND)"
  port="${app_bind##*:}"
  uses_caddy && caddy=1

  ui_banner "域名状态" "轻语博客 · 域名与 HTTPS"
  ui_kv "站点地址" "${C_B}${site_url:-（未设置）}${C_RESET}"
  ui_kv "域名" "${domain:-（无 —— 当前是 IP + 端口模式）}"
  aliases="$(domain_aliases | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  ui_kv "别名域名" "${aliases:-（无）}"
  ui_kv "反向代理" "$([ "$caddy" -eq 1 ] && echo 'Caddy（自动 HTTPS）' || echo '未启用（纯 HTTP）')"
  ui_kv "应用监听" "${app_bind:-（未设置）}"
  ui_kv "本机健康检查端口" "$port"

  if [ -z "$domain" ]; then
    echo
    ui_hint "换成域名 + 自动 HTTPS：敲 qingyu 打开菜单 → 选 14（改域名），按提示填域名即可"
    return 0
  fi

  echo
  ui_section "DNS 解析"
  resolved="$(domain_resolved_ips "$domain" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [ -z "$resolved" ]; then
    ui_warn "解析不到 ${domain}"
    ui_hint "到 DNS 控制台加一条 A 记录指向本机公网 IP；解析生效后再敲 qingyu → 3 复查"
  elif domain_points_here "$domain"; then
    ui_ok "${domain} → ${resolved}（已指向本机）"
  else
    ui_warn "${domain} → ${resolved}（与本机公网 IP 不一致，Let's Encrypt 会签发失败）"
  fi
  # 域名配了 AAAA 但这台机器没有公网 IPv6：证书照样签得下来，
  # 但走 IPv6 的访客会打不开 —— 这种「一半能开一半打不开」最值得提前说。
  case "$resolved" in
    *:*:*)
      if [ -z "$(detect_ip6 2>/dev/null || true)" ]; then
        ui_warn "域名有 IPv6（AAAA）记录，但这台机器探测不到公网 IPv6"
        ui_hint "要么给机器开 IPv6，要么删掉 AAAA 记录，否则部分访客打不开"
      fi
      ;;
  esac

  ui_section "端口与证书"
  if port_in_use_pair; then
    ui_ok "80 / 443 空闲，可签发证书"
  else
    ui_warn "80 或 443 已被占用 —— Caddy / 证书签发会失败"
    ui_hint "排查：./deploy/install.sh doctor"
  fi
  cert="$INSTALL_DIR/data/caddy/certificates/${domain}/${domain}.crt"
  if [ -f "$cert" ]; then
    cert_end="$(cert_expiry_date "$cert")"
    cert_left="$(cert_days_left "$cert_end")"
    if [ -n "$cert_end" ]; then
      if [ -n "$cert_left" ] && [ "$cert_left" -lt 0 ]; then
        ui_warn "证书已于 ${cert_end} 过期（-$((cert_left * -1)) 天）"
      elif [ -n "$cert_left" ] && [ "$cert_left" -le 15 ]; then
        ui_warn "证书 ${cert_end} 到期，只剩 ${cert_left} 天（Caddy 会自动续签）"
      else
        ui_ok "证书已签发，到期时间 ${cert_end}${cert_left:+（还剩 ${cert_left} 天）}"
      fi
    else
      ui_ok "证书已签发"
    fi
  elif [ "$caddy" -eq 1 ]; then
    ui_hint "证书还没签发（Caddy 首次启动后自动申请，DNS 指过来即可）"
  fi
  echo
  ui_hint "改回 IP + 端口：./deploy/install.sh domain port"
}

# 别名域名列表：.env 里用空格分隔（SITE_ALIASES="a.com b.com"）。
# 读出来统一去重 + 去空行，写回时再压成一行，保证 .env 不会越写越乱。

domain_aliases() {
  local v a out=""
  v="$(env_value SITE_ALIASES 2>/dev/null || true)"
  for a in $v; do
    case " $out " in *" $a "*) continue ;; esac
    out="$out $a"
  done
  for a in $out; do
    [ -n "$a" ] && printf '%s\n' "$a"
  done
}

domain_aliases_write() {
  local a out=""
  # 纯 bash 去重：locale 不是 UTF-8 时 tr/sed 会把多字节字符切碎
  for a in $1; do
    case " $out " in *" $a "*) continue ;; esac
    out="$out $a"
  done
  env_set SITE_ALIASES "${out# }"
}

# 把「域名模式」和「端口模式」落到 .env，四个字段必须一起改，否则出现半 HTTPS 半明文的怪状态

domain_apply() {
  local d="$1" p="${2:-}" profiles port
  profiles="$(env_value COMPOSE_PROFILES)"
  port="${p:-8080}"
  if [ -n "$d" ]; then
    env_set SITE_DOMAIN "$d"
    env_set SITE_URL "https://$d"
    env_set APP_BIND "127.0.0.1:8787"
    env_set TRUST_PROXY "1"
    # 保留 postgres 这类与域名无关的 profile，只把 domain 摘掉或加上
    profiles="${profiles//,domain/}"; profiles="${profiles//domain,/}"; profiles="${profiles//domain/}"
    profiles="${profiles:+$profiles,}domain"
    env_set COMPOSE_PROFILES "$profiles"
  else
    env_set SITE_DOMAIN ""
    # 端口模式没有 Caddy，别名域名无处可用；留着会让下次切回域名时莫名多出几个站点标签
    env_set SITE_ALIASES ""
    env_set SITE_URL "http://$(detect_ip):$port"
    env_set APP_BIND "0.0.0.0:$port"
    env_set TRUST_PROXY "0"
    profiles="${profiles//,domain/}"; profiles="${profiles//domain,/}"; profiles="${profiles//domain/}"
    profiles="${profiles%,}"; profiles="${profiles# ,}"
    env_set COMPOSE_PROFILES "$profiles"
  fi
}

# 输入域名（或把用户贴的整段网址压成域名本身）

domain_normalize() {
  local d="$1"
  d="${d#https://}"; d="${d#http://}"
  d="${d%%/*}"; d="${d%%:*}"
  d="${d,,}"
  printf '%s' "$d"
}

# 没有参数时交互式问一个合法的域名，最多三次；非交互直接报错退出

domain_ask() {
  local d
  [ -n "$ASSUME_YES" ] && return 1
  can_ask || return 1
  local i=0
  while [ "$i" -lt 3 ]; do
    i=$((i + 1))
    # UI 输出必须直接写到 tty：本函数的返回值要用 $(...) 捕获，混进提示文字会污染域名
    ui_section "第 1 问 · 域名是什么？" > /dev/tty
    ui_hint "只写域名本身，不要带 https:// 和路径，例如 blog.example.com" > /dev/tty
    ask "域名" ""
    d="$(domain_normalize "$REPLY")"
    if [ -z "$d" ]; then
      ui_warn "没填域名，已放弃" > /dev/tty
      return 1
    fi
    if is_valid_domain "$d"; then
      printf '%s' "$d"
      return 0
    fi
    ui_warn "「${d}」不像一个合法域名（示例：blog.example.com）" > /dev/tty
  done
  return 1
}

# 证书是否已经签好：直接打一次 HTTPS 健康检查，比翻 Caddy 的数据目录可靠

domain_https_ok() {
  local d="$1"
  have curl || return 1
  curl -fsS --max-time 8 -o /dev/null "https://${d}/healthz" 2>/dev/null
}

cmd_domain() {
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR —— 先 install，或用 --dir 指定"
  [ -f "$INSTALL_DIR/.env" ] || die "未找到 $INSTALL_DIR/.env —— 这个目录还没有部署过？"

  set -- $SUBCMD_ARGS
  local action="${1:-status}" target="${2:-}"

  # status 只是读 .env + 查 DNS，完全不碰 Docker
  [ "$action" = status ] || [ -z "$action" ] || { need_root; resolve_docker; }

  case "$action" in
    status|"") domain_status ;;

    set) domain_set "$target" ;;
    add|alias) domain_alias_add "$target" ;;
    rm|unalias) domain_alias_rm "$target" ;;
    port|off) domain_port "$target" "$action" ;;
    *) usage; die "未知用法：domain ${action}（可用：status / set <域名> / add <别名> / rm <别名> / port [端口] / off）" ;;
  esac
}

# ---------------- 别名域名：一个站点绑多个域名 ----------------
# 借鉴 kejilion 的「为现有站点再关联一个新域名」：主域名负责对外形象，
# 别名域名（老域名、备用域名、www 和不带 www 同时存在）都指向同一个站点，各自带一张证书。
# SITE_ALIASES 在 .env 里空格分隔，Caddy 会为每个域名都自动签发。

domain_alias_add() {
  local main a
  main="$(env_value SITE_DOMAIN)"
  [ -n "$main" ] || die "当前是 IP + 端口模式，没有域名可加别名 —— 先执行：$0 domain set 你的域名"

  a="$(domain_normalize "${1:-}")"
  if [ -z "$a" ] && can_ask; then
    ui_section "别名域名" > /dev/tty
    ui_hint "只写域名本身，不要带 https://，例如 www.example.com" > /dev/tty
    ask "要绑定的域名" ""
    a="$(domain_normalize "$REPLY")"
  fi
  [ -n "$a" ] || die "没给域名，已取消（也可以写成：$0 domain add www.example.com）"
  is_valid_domain "$a" || die "「$a」不像一个合法域名（示例：www.example.com）"
  if [ "$a" = "$main" ]; then
    die "$a 已经是主域名了，不用再加"
  fi
  if domain_aliases | grep -Fxq "$a"; then
    die "$a 已经是别名域名了（当前别名：$(domain_aliases | tr '\n' ' ')）"
  fi

  ui_kv "主域名" "$main"
  ui_kv "新增别名" "${C_B}${a}${C_RESET}"
  ui_hint "别名同样会自动申请 HTTPS 证书；请先把 ${a} 的 A 记录指向本机 IP"

  domain_aliases_write "$(domain_aliases; echo "$a")"

  # 只重建 Caddy：换别名不影响应用镜像，更不该重新 build
  compose up -d --force-recreate --no-build caddy 2>/dev/null || compose up -d --force-recreate caddy

  local tries=0
  while [ "$tries" -lt 6 ]; do
    domain_https_ok "$a" && break
    tries=$((tries + 1))
    [ "$tries" -ge 6 ] && break
    printf "  等待 ${a} 证书签发…（第 %d/6 次）\n" "$tries"
    sleep 5
  done
  if domain_https_ok "$a"; then
    ui_ok "https://${a} 已可访问"
  else
    ui_warn "https://${a} 暂时不通：多半是 DNS 还没解析到本机"
    ui_hint "解析生效后重跑：$0 domain status"
  fi
  return 0
}

domain_alias_rm() {
  local a found=0 current
  a="$(domain_normalize "${1:-}")"
  [ -n "$a" ] || die "没给域名，已取消（也可以写成：$0 domain rm www.example.com）"
  current="$(domain_aliases)"
  printf '%s\n' "$current" | grep -Fxq "$a" && found=1
  [ "$found" -eq 1 ] || die "${a} 不在别名列表里（当前别名：$(printf '%s' "$current" | tr '\n' ' ')）"

  ui_kv "移除别名" "${C_B}${a}${C_RESET}"
  domain_aliases_write "$(printf '%s\n' "$current" | grep -Fvx "$a")"
  compose up -d --force-recreate --no-build caddy 2>/dev/null || compose up -d --force-recreate caddy
  log "别名 ${a} 已移除（证书文件留在数据卷里，不影响主域名）"
  domain_status
}
# ---------------- 切到域名 + 自动 HTTPS ----------------

domain_set() {
  local d="$1"

  STEP_TOTAL=5

  step_begin "确认要用的域名"
  if [ -z "$d" ]; then
    d="$(domain_ask)" || { STEP_TOTAL=0; die "没拿到域名，已取消（可以改用 ./deploy/install.sh domain set 你的域名）"; }
  else
    d="$(domain_normalize "$d")"
    is_valid_domain "$d" || die "「$d」不像一个合法域名（示例：blog.example.com）"
  fi
  local old_domain; old_domain="$(env_value SITE_DOMAIN)"
  if [ "$old_domain" = "$d" ]; then
    STEP_TOTAL=0
    log "域名已经是 ${d}，无需切换"; domain_status; return 0
  fi
  ui_kv "原站点地址" "$(env_value SITE_URL)"
  ui_kv "新站点地址" "${C_B}https://${d}${C_RESET}"
  ui_kv "当前模式" "$([ -n "$old_domain" ] && echo "域名模式（${old_domain}）" || echo 'IP + 端口')"
  step_end

  step_begin "检查前提条件（DNS 与 80/443）"
  local ip resolved ok=1
  ip="$(detect_ip)"
  resolved="$(domain_resolved_ips "$d" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  ui_kv "本机公网 IP" "${ip:-（探测失败）}"
  if [ -z "$resolved" ]; then
    ui_warn "${d} 还解析不出 IP"
    ui_hint "到 DNS 控制台加一条 A 记录指向 ${ip:-本机公网 IP}"
    ok=0
  elif domain_points_here "$d"; then
    ui_ok "${d} → ${resolved}，已指向本机"
  else
    ui_warn "${d} → ${resolved}，与本机公网 IP（${ip:-未知}）不一致，证书会签发失败"
    ok=0
  fi
  if port_in_use_pair; then
    ui_ok "80 / 443 空闲，可以签发证书"
  else
    ui_warn "80 或 443 已被占用，Caddy 拿不到端口"
    ui_hint "排查：./deploy/install.sh doctor"
    ok=0
  fi
  if [ "$ok" -eq 0 ]; then
    ui_hint "以上问题不影响配置写入；DNS 补好后敲 qingyu → 14 再走一遍即可签发证书"
    if ! can_ask || [ "$ASSUME_YES" != "1" ]; then
      step_end
      warn "前提条件未满足，仍会继续写入配置（可加 -y 跳过此提示）"
    else
      ask "仍然继续写入配置？" "y"
      case "$REPLY" in
        y|Y|yes|YES) step_end ;;
        *) STEP_TOTAL=0; die "已取消，原配置保持不变" ;;
      esac
    fi
  else
    step_end
  fi

  step_begin "写入配置"
  domain_apply "$d"
  # 别名里如果正好有旧主域名，会和新主域名重复成同一个站点标签 —— 顺手摘掉
  local keep
  keep="$(domain_aliases | grep -Fvx "$d" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  [ "$(env_value SITE_ALIASES)" != "$keep" ] && env_set SITE_ALIASES "$keep"
  ui_kv "SITE_URL" "$(env_value SITE_URL)"
  ui_kv "SITE_DOMAIN" "$(env_value SITE_DOMAIN)"
  ui_kv "SITE_ALIASES" "$(env_value SITE_ALIASES)"
  ui_kv "APP_BIND" "$(env_value APP_BIND)"
  ui_kv "TRUST_PROXY" "$(env_value TRUST_PROXY)"
  ui_kv "COMPOSE_PROFILES" "$(env_value COMPOSE_PROFILES)"
  step_end

  step_begin "放行端口并重启服务（不重新构建镜像）"
  ensure_firewall_open
  # 只重建容器让新配置生效；这里刻意不做 compose build / pull —— 换域名是配置变更，
  # 应用镜像与域名无关，重新构建在 1 GB 内存的小机器上纯属浪费时间和内存。
  compose up -d --force-recreate --no-build app 2>/dev/null || compose up -d --force-recreate app
  step_end

  step_begin "等待服务就绪并确认 HTTPS"
  wait_healthy
  local tries=0
  while [ "$tries" -lt 6 ]; do
    domain_https_ok "$d" && break
    tries=$((tries + 1))
    [ "$tries" -ge 6 ] && break
    printf '  等待证书签发…（第 %d/6 次）\n' "$tries"
    sleep 5
  done
  if domain_https_ok "$d"; then
    ui_ok "https://${d} 已可访问（HTTPS 证书已签发）"
  elif [ -z "$resolved" ]; then
    ui_warn "域名还没解析到本机，证书暂时签不了 —— DNS 生效后敲 qingyu → 14 再走一遍即可"
  else
    ui_warn "HTTPS 还没通，常见原因：80/443 被占或 DNS 尚未生效"
    ui_hint "查看详情：./deploy/install.sh doctor"
  fi
  step_end

  STEP_TOTAL=0
  echo
  log "域名已切换为 https://${d}"
  domain_status
}

# ---------------- 退回 IP + 端口 ----------------

domain_port() {
  local p="$1" action="$2"
  STEP_TOTAL=3

  step_begin "确认要用的端口"
  if [ -z "$p" ]; then
    local bind; bind="$(env_value APP_BIND)"; p="${bind##*:}"
    [ "$p" = "8787" ] && p=8080
  fi
  [ -n "$p" ] || p=8080
  case "$p" in ''|*[!0-9]*) die "端口只能是数字，收到的是「$p」" ;; esac
  ui_kv "原站点地址" "$(env_value SITE_URL)"
  ui_kv "新站点地址" "${C_B}http://$(detect_ip):${p}${C_RESET}"
  ui_hint "该模式没有 HTTPS，登录密码以明文传输；随时可用 domain set 切回来"
  step_end

  step_begin "写入配置并重启服务（不重新构建镜像）"
  domain_apply "" "$p"
  APP_PORT="$p"
  ensure_firewall_open
  compose up -d --force-recreate --no-build app 2>/dev/null || compose up -d --force-recreate app
  step_end

  step_begin "等待服务就绪"
  wait_healthy
  step_end

  STEP_TOTAL=0
  log "已改为 $(env_value SITE_URL)（纯 HTTP，无证书）"
}
# ---------- 日常运维：启动 / 停止 / 重启 / 回滚 ----------
