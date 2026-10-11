# ============================================================
# extras.sh —— 服务器家底、测速、调优与磁盘清理
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
speedtest_probe() {
  local url="$1" label="$2" out
  # curl 失败时也会输出 -w 模板（全 0），所以必须看退出码，否则会把超时显示成「0 ms」
  if ! out="$(curl -o /dev/null -sS --max-time 10 \
    -w '%{time_namelookup} %{time_connect} %{time_starttransfer} %{time_total}' \
    "$url" 2>/dev/null)"; then
    printf '  %-22s 探测失败（超时或不可达）\n' "$label"
    return 0
  fi
  # 只留数字和点再判断是否全是 0（curl 失败时会输出 "0 0 0 0"）
  case "${out//[!0-9.]/}" in
    0000|000) printf '  %-22s 探测失败（无响应）\n' "$label"; return 0 ;;
  esac
  awk -v l="$label" '{
    printf "  %-22s DNS %5.0f ms   建连 %5.0f ms   首字节 %6.0f ms   总耗时 %6.0f ms\n",
           l, $1*1000, $2*1000, $3*1000, $4*1000
  }' <<<"$out"
}

# 下载 n MB 文件的平均速度（字节/秒）。用 3 秒内的实际传输量估算。

speedtest_dl() {
  local url="$1" bytes sec
  sec=3
  bytes="$(curl -sS --max-time "$sec" -o /dev/null -w '%{size_download}' "$url" 2>/dev/null || true)"
  case "$bytes" in ''|*[!0-9]*) return 0 ;; esac
  [ "$bytes" -lt 100000 ] && return 0
  awk -v b="$bytes" -v s="$sec" 'BEGIN{printf "%.2f MB/s（≈ %.0f Mbps）", b/s/1048576, b/s*8/1000000}'
}

# 上行：把 10 MB 内存数据 POST 到 Cloudflare 的公开 __up 端点，同样无需注册。
# 上传内容全在内存里现造，不落盘、不读任何本机文件。

speedtest_up() {
  have curl || return 0
  local posted
  posted="$(head -c 10000000 /dev/zero 2>/dev/null | curl -fsS --max-time 15 -o /dev/null \
    -w '%{size_upload} %{time_total}' -X POST \
    --data-binary @- 'https://speed.cloudflare.com/__up' 2>/dev/null || true)"
  case "$posted" in
    ''|*[!0-9.]*|*" 0"*) printf ''; return 0 ;;
  esac
  awk '{
    if ($2 > 0 && $1 > 0) printf "%.2f MB/s（≈ %.0f Mbps）", $1/$2/1048576, $1/$2*8/1000000
  }' <<<"$posted"
}

# 调优项：键 值 说明
tune_items() {
  printf '%s\t%s\t%s\n' \
    "net.core.default_qdisc"        "fq"        "队列算法；BBR 必须配 fq 才生效" \
    "net.ipv4.tcp_congestion_control" "bbr"     "拥塞控制；高延迟丢包链路上明显更稳" \
    "net.ipv4.tcp_fastopen"         "3"         "1=客户端 2=服务端 3=双向，减少握手往返" \
    "vm.swappiness"                 "10"        "少用 swap；小内存机器更不容易 OOM" \
    "net.ipv4.tcp_max_syn_backlog"  "4096"      "抗突发连接，抗小流量攻击" \
    "net.core.somaxconn"            "4096"      "同上：accept 队列上限"
}

tune_get() { sysctl -n "$1" 2>/dev/null || echo ""; }

tune_status() {
  local key want have_v
  ui_banner "服务器调优" "看看这台机器的网络栈调到什么状态了（只读）"
  ui_section "当前内核参数"
  while IFS="$(printf '\t')" read -r key want note; do
    [ -n "$key" ] || continue
    have_v="$(tune_get "$key")"
    if [ -z "$have_v" ]; then
      ui_kv "$key" "读不到（可能不支持）"
    elif [ "$have_v" = "$want" ]; then
      ui_kv "$key" "${have_v}（已调优）"
    else
      ui_kv "$key" "${have_v}（建议 ${want}）"
    fi
  done < <(tune_items)

  ui_section "支持情况"
  local avail cc
  avail="$(tune_get net.ipv4.tcp_available_congestion_control)"
  cc="$(tune_get net.ipv4.tcp_congestion_control)"
  ui_kv "内核可用算法" "${avail:-读不到}"
  ui_kv "当前算法" "${cc:-读不到}"
  case "$avail" in
    *bbr*) ui_ok "内核支持 BBR，可以调优" ;;
    *) ui_warn "这个内核不支持 BBR（需要 4.9 以上），调优时会跳过拥塞控制那项" ;;
  esac
  if [ -f "$TUNE_CONF" ]; then
    ui_kv "配置文件" "$TUNE_CONF（已生效）"
  else
    ui_kv "配置文件" "还没有（跑 $0 tune 会创建）"
  fi
}

tune_apply() {
  need_root
  if [ -f "$TUNE_CONF" ]; then
    ui_warn "已经调过优了，配置文件在 ${TUNE_CONF}"
    ui_hint "想改回默认：$0 tune --restore"
    return 0
  fi
  have sysctl || die "这台机器没有 sysctl，调不了"

  local avail
  avail="$(tune_get net.ipv4.tcp_available_congestion_control)"

  {
    printf '# 由 %s tune 生成 —— 网络队列与内存策略，不涉及 SSH / 防火墙\n' "$0"
    printf '# 想撤销：%s tune --restore\n' "$0"
    tune_items | while IFS="$(printf '\t')" read -r key want note; do
      case "$key" in
        net.ipv4.tcp_congestion_control)
          case "$avail" in
            *bbr*) printf '%s = %s\n' "$key" "$want" ;;
            *) continue ;;   # 内核不支持就别写，写了 sysctl -p 会报错
          esac
          ;;
        *) printf '%s = %s\n' "$key" "$want" ;;
      esac
    done
  } > "$TUNE_CONF"

  if sysctl -p "$TUNE_CONF" >/dev/null 2>&1; then
    ui_ok "已写入 ${TUNE_CONF} 并立即生效"
  else
    ui_warn "配置写好了，但 sysctl -p 报了错，逐项看一下："
    sysctl -p "$TUNE_CONF" 2>&1 | while IFS= read -r line; do ui_hint "$line"; done
  fi

  echo
  ui_section "调优后"
  local key want
  while IFS="$(printf '\t')" read -r key want note; do
    [ -n "$key" ] || continue
    ui_kv "$key" "$(tune_get "$key")"
  done < <(tune_items)

  echo
  ui_hint "拥塞控制改成 bbr 会立刻生效，但观察期建议至少跑满 24 小时再看效果"
  ui_hint "想撤销：$0 tune --restore"
  return 0
}

tune_restore() {
  need_root
  [ -f "$TUNE_CONF" ] || die "没有调过优（找不到 ${TUNE_CONF}），没什么可撤销的"
  rm -f "$TUNE_CONF"
  # 删掉配置只保证「以后不再加载」；当前内核里的值要显式写回默认才真的变回去
  sysctl -w net.core.default_qdisc=pfifo_fast >/dev/null 2>&1 || true
  sysctl -w net.ipv4.tcp_fastopen=1 >/dev/null 2>&1 || true
  sysctl -w vm.swappiness=60 >/dev/null 2>&1 || true
  sysctl -w net.ipv4.tcp_max_syn_backlog=128 >/dev/null 2>&1 || true
  sysctl -w net.core.somaxconn=128 >/dev/null 2>&1 || true
  ui_ok "已删除 ${TUNE_CONF}，并把上面几项写回内核默认值"
  ui_hint "拥塞控制（tcp_congestion_control）在多数发行版上会保持当前值直到重启"
  ui_hint "重启机器后就彻底回到默认了"
  return 0
}

cmd_tune() {
  if [ "$TUNE_RESTORE" = "1" ]; then
    tune_restore
    return 0
  fi

  tune_status
  echo

  if [ "$TUNE_APPLY" = "1" ]; then
    tune_apply
    return 0
  fi

  ui_section "要现在调优吗"
  ui_hint "只改网络队列和内存策略，不碰 SSH / 端口 / 防火墙"
  ui_hint "随时可以 $0 tune --restore 撤销"
  # can_ask 只看 /dev/tty 的权限位；容器里没有控制终端时权限看着可读、实际 open 会失败，
  # 所以这里再做一次真实探测，避免直接崩在重定向上。
  local tty_ok=0
  : 2>/dev/null > /dev/tty && tty_ok=1
  if [ "$ASSUME_YES" = "1" ]; then
    REPLY="y"
  elif [ "$tty_ok" = "1" ] && can_ask; then
    ui_section "确认" 2>/dev/null > /dev/tty
    ui_hint "输入 y 执行调优，其他任意键跳过" 2>/dev/null > /dev/tty
    ask "要调优吗" "n"
  else
    REPLY="n"
  fi
  case "$REPLY" in
    y|Y|yes|YES) tune_apply ;;
    *) ui_hint "已跳过。想调的时候：$0 tune" ;;
  esac
  return 0
}

cmd_speedtest() {
  local ip
  ui_banner "网络测速" "先看延迟，再看带宽（只发请求，不改任何配置）"

  ip="$(detect_ip 2>/dev/null || true)"
  [ -n "$ip" ] && ui_kv "本机出口 IP" "$ip"
  ui_kv "拥塞控制" "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo '读不到')"

  ui_section "延迟（DNS / 建连 / 首字节）"
  if have curl; then
    speedtest_probe "https://www.cloudflare.com/" "Cloudflare" || ui_warn "Cloudflare 探测失败（可能是网络不通或被墙）"
    speedtest_probe "https://www.google.com/" "Google" || true
    speedtest_probe "https://www.baidu.com/" "百度（国内）" || true
    speedtest_probe "https://mirrors.aliyun.com/" "阿里云镜像" || true
  else
    ui_warn "没装 curl，跳过延迟探测" "apt-get install -y curl"
  fi

  ui_section "下载带宽（近似值）"
  if have speedtest-cli || have speedtest; then
    ui_hint "检测到 speedtest-cli，直接跑官方测速"
    have speedtest-cli && speedtest-cli --simple 2>/dev/null || speedtest --simple 2>/dev/null || ui_warn "speedtest 执行失败"
  else
    ui_hint "系统里没有 speedtest-cli，用 Cloudflare 端点估算（误差可达 20%）"
    ui_hint "想要准确值可自行安装：apt-get install -y speedtest-cli"
    local dl up
    dl="$(speedtest_dl "https://speed.cloudflare.com/__down?bytes=25000000")"
    [ -n "$dl" ] && ui_kv "单线程下载" "$dl" || ui_warn "下载测速失败（出网被限速或 Cloudflare 不可达）"
    up="$(speedtest_up)"
    if [ -n "$up" ]; then
      ui_kv "单线程上传" "$up"
    else
      ui_hint "上传测不出来（很多机房禁了出站 POST，不一定是故障）"
    fi
  fi

  echo
  ui_hint "延迟高不代表网站慢 —— 我们的图片有反代加速，实际观感以真实访问为准"
  ui_hint "服务器本身没问题时，先跑：./deploy/install.sh doctor"
  return 0
}
# ---------- 系统信息查询 ----------
# 借鉴 kejilion.sh 的「系统信息查询」：买机器、机器变卡、或者想知道「这台 VPS 到底什么家底」时，
# 一条命令看完 CPU / 内存 / 磁盘 / 负载 / 网络 / 归属地。
# 全程只读，不装任何东西，也不要求 root；读不到的项直接留空，不会中断。

# CPU 占用：取两次 /proc/stat 的差值算 1 秒内的平均值（读不到就返回空）

sysinfo_cpu_usage() {
  [ -r /proc/stat ] || return 0
  local a b
  a="$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat)"
  sleep 1
  b="$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat)"
  printf '%s\n%s\n' "$a" "$b" | awk '
    function busy(){ return $1+$2+$3+$6+$7+$8 }              # user+nice+system+irq+softirq+steal
    function total(){ return $1+$2+$3+$4+$5+$6+$7+$8 }
    NR==1 { u1=busy(); t1=total(); next }
    { u=busy(); t=total(); d=t-t1; printf "%.0f", (d>0 && t>0) ? (u-u1)*100/d : 0 }'
}

sysinfo_mem() {
  [ -r /proc/meminfo ] || return 0
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{
    if (t>0) printf "%.2f/%.2f GB（已用 %.0f%%）", (t-a)/1048576, t/1048576, (t-a)*100/t }' /proc/meminfo
}

sysinfo_mem_free() {
  [ -r /proc/meminfo ] || return 0
  awk '/^MemAvailable:/{printf "%.0f MB", $2/1024}' /proc/meminfo
}

sysinfo_swap() {
  [ -r /proc/meminfo ] || return 0
  awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{
    if (t==0) printf "无"; else printf "%.0f/%.0f MB（已用 %.0f%%）", (t-f)/1024, t/1024, (t-f)*100/t }' /proc/meminfo
}

sysinfo_disk() {
  local path="$1"
  [ -n "$path" ] && [ -e "$path" ] || return 0
  df -h "$path" 2>/dev/null | awk 'NR==2 {printf "%s / %s（已用 %s）", $3, $2, $5}'
}

sysinfo_net_total() {
  [ -r /proc/net/dev ] || return 0
  local col=2
  [ "${1:-rx}" = "tx" ] && col=10
  awk -v c="$col" 'NR>2 && $1 !~ /^lo:/ {s+=$c} END{printf "%.2f GB", s/1073741824}' /proc/net/dev
}

# 系统运行时长（/proc/uptime，单位秒 → 人话）

sysinfo_uptime() {
  [ -r /proc/uptime ] || return 0
  local s d h m
  s="$(cut -d. -f1 /proc/uptime 2>/dev/null | tr -d ' ')"
  case "$s" in ''|*[!0-9]*) return 0 ;; esac
  d=$((s / 86400)); h=$(((s % 86400) / 3600)); m=$(((s % 3600) / 60))
  if [ "$d" -gt 0 ]; then printf '%d 天 %d 小时' "$d" "$h"
  elif [ "$h" -gt 0 ]; then printf '%d 小时 %d 分' "$h" "$m"
  else printf '%d 分' "$m"; fi
}

# TCP / UDP 连接数（ss 是标配；没有就退回 netstat，都没有就留空）

sysinfo_conn_count() {
  local proto="$1" flag="-t" n=""
  [ "$proto" = "u" ] && flag="-u"
  if have ss; then
    n="$(ss -H "$flag" 2>/dev/null | wc -l | tr -d ' ')"
    # 老版本的 ss 不支持 -H：多出来的一行是表头，减掉即可
    [ -n "$n" ] || n="$(ss "$flag" 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
  elif have netstat; then
    n="$(netstat "$flag" 2>/dev/null | awk 'NR>2 && ($1 ~ /^tcp/ || $1 ~ /^udp/){c++} END{print c+0}')"
  fi
  printf '%s' "$n"
}

# ---------- 清理磁盘（Docker 侧） ----------
# 反复 upgrade 的代价：本机构建每次都会留下悬空镜像和构建缓存。
# 20G 的小机器上跑一年，这两项能悄悄吃掉十几 G，而磁盘告警只会说「清理备份」—— 指错方向。
# 这里只删「一定没人再用」的东西：悬空镜像（dangling）和构建缓存。
# 绝不碰运行中的镜像、具名镜像和数据卷 —— `docker system prune -a --volumes` 那套太危险，不做。

clean_docker_usage() {
  # docker system df --format 在旧版本 Docker 上不支持，退回可读输出
  docker system df 2>/dev/null || echo "读不到（Docker 版本太老）"
}

# 把 docker 报的 "1.234GB" / "0B" / "512.3MB (some)" 解析成 GB
# 注意：awk 里调用未定义的函数是致命错误，不能拿函数名当条件用

clean_size_gb() {
  awk '
    {
      v = $1
      sub(/[ \t(].*$/, "", v)      # 去掉 " (some)" 这类后缀
      sub(/B$/, "", v)            # 去掉结尾的 B
      u = tolower(substr(v, length(v), 1))
      m = 1
      if (u == "k") m = 1024
      else if (u == "m") m = 1048576
      else if (u == "g") m = 1073741824
      else if (u == "t") m = 1099511627776
      if (v + 0 > 0) printf "%.2f", (v + 0) * m / 1073741824
    }'
}

# 构建缓存的可回收量：builder prune 能全额释放它，这个数是准的

clean_build_cache_gb() {
  docker system df --format '{{.Type}}\t{{.Reclaimable}}' 2>/dev/null |
    awk -F'\t' 'tolower($1) ~ /build/ {print $2; exit}' | clean_size_gb
}

# 镜像可回收量：这是**上界**。里面混着「没人用的具名镜像」，
# 而我们只删悬空镜像（dangling），所以实际释放会小于这个数。

clean_images_upper_gb() {
  docker system df --format '{{.Type}}\t{{.Reclaimable}}' 2>/dev/null |
    awk -F'\t' 'tolower($1) ~ /image/ {print $2; exit}' | clean_size_gb
}

cmd_clean() {
  ui_banner "清理磁盘" "看清 Docker 占了多少，再决定删什么"

  if ! have docker || ! docker info >/dev/null 2>&1; then
    ui_warn "Docker 没运行，没什么可清的"
    return 0
  fi

  ui_section "当前占用"
  clean_docker_usage

  local cache_gb img_gb reclaim
  cache_gb="$(clean_build_cache_gb)"
  img_gb="$(clean_images_upper_gb)"
  # 空字符串兜成 0，避免后面做数值比较时炸掉
  [ -n "$cache_gb" ] || cache_gb=0
  [ -n "$img_gb" ] || img_gb=0
  reclaim="$(awk -v a="$cache_gb" -v b="$img_gb" 'BEGIN{printf "%.2f", a+b}')"
  echo
  ui_kv "构建缓存可回收" "${cache_gb} GB（builder prune 能全额释放）"
  ui_kv "镜像可回收" "${img_gb} GB（上界；实际只删其中的悬空部分）"

  if [ "$(awk -v a="$reclaim" 'BEGIN{print (a<0.01)?1:0}')" = "1" ]; then
    echo
    ui_ok "没什么可回收的，磁盘很干净"
    return 0
  fi

  ui_section "会删掉什么"
  ui_hint "悬空镜像：本地构建升级后没人再引用的中间层"
  ui_hint "构建缓存：下次 build 会慢一点，但不会影响运行中的站点"
  ui_hint "不会碰：运行中的镜像、具名镜像、数据库与上传的数据卷"

  local tty_ok=0
  : 2>/dev/null > /dev/tty && tty_ok=1
  if [ "$ASSUME_YES" = "1" ]; then
    REPLY="y"
  elif [ "$tty_ok" = "1" ] && can_ask; then
    ui_section "确认" 2>/dev/null > /dev/tty
    ui_hint "输入 y 执行清理（可回收 ${reclaim} GB），其他任意键跳过" 2>/dev/null > /dev/tty
    ask "要清理吗" "n"
  else
    REPLY="n"
  fi

  case "$REPLY" in
    y|Y|yes|YES)
      echo
      # 只删悬空镜像：-f 少了这个会提示确认，且 --filter dangling 只匹配无标签镜像
      docker image prune -f --filter "dangling=true" >/dev/null 2>&1 \
        && ui_ok "悬空镜像已清理" \
        || ui_warn "清理悬空镜像失败（权限不足？）" "docker image prune -f --filter dangling=true"
      docker builder prune -f >/dev/null 2>&1 \
        && ui_ok "构建缓存已清理" \
        || ui_warn "清理构建缓存失败" "docker builder prune -f"
      echo
      ui_section "清理后"
      clean_docker_usage
      ;;
    *)
      ui_hint "已跳过。想清的时候：$0 clean"
      ;;
  esac
  return 0
}

cmd_sysinfo() {
  local hostname os kernel arch cpu_model cores cpu_freq cpu_used load site_url public_ip6
  local mem mem_free swap disk_root disk_data tcp udp rx tx cc qdisc dns
  local public_ip public_ip6 geo country city isp data_dir

  hostname="$(uname -n 2>/dev/null || true)"
  os="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n1 | tr -d '"')"
  kernel="$(uname -r 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"

  ui_banner "系统信息" "这台机器的家底（只读，不改动任何配置）"

  ui_section "主机"
  ui_kv "主机名" "${hostname:-未知}"
  ui_kv "系统版本" "${os:-未知}"
  ui_kv "内核" "${kernel:-未知}"
  ui_kv "架构" "${arch:-未知}"
  ui_kv "时区" "$(date '+%Z %z' 2>/dev/null || true)"
  ui_kv "运行时长" "$(sysinfo_uptime)"

  ui_section "CPU"
  cpu_model="$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n1)"
  [ -n "$cpu_model" ] || cpu_model="$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null)"
  cores="$(nproc 2>/dev/null || true)"
  cpu_freq="$(awk -F': ' '/^cpu MHz/{printf "%.2f GHz", $2/1000; exit}' /proc/cpuinfo 2>/dev/null)"
  cpu_used="$(sysinfo_cpu_usage)"
  load="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || true)"
  ui_kv "型号" "${cpu_model:-未知}"
  ui_kv "核心数" "${cores:-未知}"
  [ -n "$cpu_freq" ] && ui_kv "当前频率" "$cpu_freq"
  [ -n "$cpu_used" ] && ui_kv "CPU 占用" "${cpu_used}%（近 1 秒采样）"
  ui_kv "系统负载" "${load:-未知}"

  ui_section "内存与磁盘"
  mem="$(sysinfo_mem)"
  mem_free="$(sysinfo_mem_free)"
  swap="$(sysinfo_swap)"
  ui_kv "物理内存" "${mem:-读不到}"
  [ -n "$mem_free" ] && ui_kv "可用内存" "$mem_free"
  ui_kv "虚拟内存" "${swap:-读不到}"
  disk_root="$(sysinfo_disk /)"
  ui_kv "系统盘 /" "${disk_root:-读不到}"
  data_dir="$(env_value DATA_DIR 2>/dev/null || true)"
  [ -n "$data_dir" ] || data_dir="$INSTALL_DIR/data"
  disk_data="$(sysinfo_disk "$data_dir")"
  [ -n "$disk_data" ] && ui_kv "数据目录" "${data_dir}：${disk_data}"

  ui_section "网络"
  public_ip="$(detect_ip 2>/dev/null || true)"
  public_ip6="$(detect_ip6 2>/dev/null || true)"
  ui_kv "公网 IPv4" "${public_ip:-探测失败（不影响使用）}"
  ui_kv "公网 IPv6" "${public_ip6:-（没有或未启用）}"
  # 归属地查询走 ipinfo.io，国内机器经常连不上 —— 拿不到就留空，不报错
  geo="$(curl -fsS --max-time 5 https://ipinfo.io 2>/dev/null || true)"
  if [ -n "$geo" ]; then
    country="$(printf '%s' "$geo" | tr -d '"' | sed -n 's/^country:[[:space:]]*//p' | head -n1)"
    city="$(printf '%s' "$geo" | tr -d '"' | sed -n 's/^city:[[:space:]]*//p' | head -n1)"
    isp="$(printf '%s' "$geo" | tr -d '"' | sed -n 's/^org:[[:space:]]*//p' | head -n1)"
    [ -n "$isp" ] && ui_kv "运营商 / 归属组织" "$isp"
    [ -n "$country$city" ] && ui_kv "归属地" "$(printf '%s %s' "$country" "$city" | sed 's/[[:space:]]*$//')"
  fi
  ui_kv "网卡累计收 / 发" "$(sysinfo_net_total rx) / $(sysinfo_net_total tx)"
  cc="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)"
  qdisc="$(sysctl -n net.core.default_qdisc 2>/dev/null || true)"
  [ -n "$cc$qdisc" ] && ui_kv "拥塞控制 / 队列" "${cc:-?} ${qdisc:-?}"
  dns="$(awk '/^nameserver/{printf "%s ", $2}' /etc/resolv.conf 2>/dev/null | sed 's/[[:space:]]*$//')"
  [ -n "$dns" ] && ui_kv "DNS" "$dns"
  tcp="$(sysinfo_conn_count t)"
  udp="$(sysinfo_conn_count u)"
  [ -n "$tcp" ] && ui_kv "TCP / UDP 连接" "${tcp} / ${udp:-?}"

  # 顺带看一眼站点状态：机器是机器，站点是站点，两件事一起看更省事。
  # 只在真的读到 SITE_URL 时才显示，避免打印出一堆空值。
  site_url="$(env_value SITE_URL 2>/dev/null || true)"
  if [ -n "$site_url" ]; then
    ui_section "站点"
    ui_kv "访问地址" "$site_url"
    ui_kv "安装目录" "$INSTALL_DIR"
    if have docker && docker info >/dev/null 2>&1; then
      ui_kv "应用容器" "$(docker inspect -f '{{.State.Status}}' qingyu-app 2>/dev/null || echo '未找到')"
    else
      ui_kv "应用容器" "读不到（Docker 没运行）"
    fi
  else
    ui_hint "这台机器还没部署过 —— 跑一次 bash $0 install 就能建站"
  fi

  echo
  # 内存/磁盘的门槛直接给结论，免得用户还要自己换算
  local mem_kb
  mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || true)"
  if [ -n "$mem_kb" ] && [ "$mem_kb" -lt 1250000 ]; then
    ui_hint "内存不足 1.2 GB：本地构建容易被系统杀掉，安装时建议加 --prebuilt 直接用现成镜像"
  fi
  if [ -n "$disk_root" ]; then
    local disk_avail
    disk_avail="$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}' || true)"
    [ -n "$disk_avail" ] && [ "$disk_avail" -lt 204800 ] \
      && ui_hint "系统盘可用不足 200 MB：先清理空间再部署 / 更新"
  fi
  ui_hint "想逐项排查网站本身的问题：bash $0 doctor"
  return 0
}
