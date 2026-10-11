# ============================================================
# common.sh —— 终端 UI、日志、错误处理、依赖小工具与用法说明
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
# 终端不是 UTF-8（老 LANG=C 的 ssh、部分精简系统）时换成 ASCII 图形，
# 否则方块 / 对勾会显示成一串乱码。
ui_utf8() {
  local cs=""
  cs="$(locale charmap 2>/dev/null || true)"
  if [ -z "$cs" ]; then
    cs="$(printf '%s' "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" | sed -n 's/.*\.\(UTF-?8\).*/\1/ip')"
  fi
  printf '%s' "$cs" | grep -qi 'utf-\?8'
}

log()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }

ok()   { printf '%s  %s%s %s\n' "$C_GREEN" "$G_OK" "$C_RESET" "$*"; }

warn() { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }

die()  { printf '%s[x]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# 细分隔线：用于把长输出切成几段，读起来不累
# 把一个字符重复 n 次。
#不能用 `printf '%*s' n '' | tr ' ' "$ch"` —— tr 在 C / POSIX 语言环境下按字节处理，
# 会把 "─"（3 字节）拆成乱码，横线整片糊掉。这里用循环拼接，与语言环境无关。

ui_repeat() {
  local ch="$1" n="$2" out="" i
  for (( i = 0; i < n; i++ )); do out="$out$ch"; done
  printf '%s' "$out"
}

ui_rule() { printf '%s%s%s\n' "$C_GREY" "$(ui_repeat "$G_RULE" "$UI_W")" "$C_RESET"; }

# 显示宽度：中文 / 全角字符按 2 列算，否则中英混排的框线会歪。
# 交给 awk 数（它按字符而非字节遍历），bash 的 ${#s} 在非 UTF-8 locale 下会数错。

ui_width() {
  # 显示列宽 = 字符数 + 双宽字符数。
  # 字符数用 awk length（UTF-8 locale 下按字符数），字节数用 LC_ALL=C 下数；
  # ASCII 占 1 字节、CJK / 全角标点占 3 字节，于是 双宽字符数 = (字节数 - 字符数) / 2。
  local chars bytes
  chars="$(printf '%s' "$1" | awk 'END { print length($0) }' 2>/dev/null || echo 0)"
  bytes="$(LC_ALL=C; printf '%s' "$1" | wc -c | tr -d ' ')"
  case "$chars$bytes" in ''|*[!0-9]*) printf '%s' "${#1}"; return 0 ;; esac
  printf '%s' "$(( chars + (bytes - chars) / 2 ))"
}

# 带右边框的一行（按显示宽度自动补齐，中文按 2 列算）

ui_box_line() {
  local color="$1" text="$2" pad
  pad=$(( UI_W - 4 - $(ui_width "$text") ))
  [ "$pad" -lt 0 ] && pad=0
  printf '%s│%s %s%*s %s│%s\n' "$color" "$C_RESET" "$text" "$pad" "" "$color" "$C_RESET"
}

# 标题横幅：整个脚本只在最开头和关键节点用一次，避免刷屏

ui_banner() {
  local bar; bar="$(ui_repeat "${G_RULE:-─}" "$UI_W")"
  echo
  printf '%s+%s+%s\n' "$C_CYAN" "$bar" "$C_RESET"
  ui_box_line "$C_CYAN" "$C_B$1$C_RESET"
  [ -n "${2:-}" ] && ui_box_line "$C_CYAN" "$C_DIM$2$C_RESET"
  printf '%s+%s+%s\n' "$C_CYAN" "$bar" "$C_RESET"
  return 0
}

# 小节标题：一条短横线 + 标题，比整块盒子轻

ui_section() {
  echo
  printf '%s%s %s%s\n' "$C_BLUE" "$G_SECT" "$1" "$C_RESET"
  return 0
}

# 键值对齐行：ui_kv "访问地址" "https://xxx"

ui_kv() {
  printf '  %s%-12s%s %s\n' "$C_DIM" "$1" "$C_RESET" "$2"
  return 0
}

# 提示行（次要说明）

ui_hint() { printf '  %s%s%s\n' "$C_GREY" "$*" "$C_RESET"; return 0; }

# 编号选项：ui_opt 1 "标题" "说明"

ui_opt() {
  printf '  %s%2s)%s %s%s%s' "$C_B" "$1" "$C_RESET" "$C_B" "$2" "$C_RESET"
  [ -n "${3:-}" ] && printf '  %s%s%s' "$C_GREY" "$3" "$C_RESET"
  printf '\n'
  return 0
}

# 进度条：ui_bar 3 6 → ███░░░

ui_bar() {
  local cur="$1" total="$2" w=24 filled head tail
  case "$cur$total" in ''|*[!0-9]*) return 0 ;; esac
  [ "$total" -gt 0 ] || return 0
  filled=$(( cur * w / total ))
  [ "$filled" -gt "$w" ] && filled=$w
  head="$(ui_repeat "$G_FULL" "$filled")"
  tail="$(ui_repeat "$G_EMPTY" "$((w - filled))")"
  printf '%s%s%s%s%s %s%d/%d%s\n' \
    "$C_GREEN" "$head" "$C_GREY" "$tail" "$C_RESET" "$C_DIM" "$cur" "$total" "$C_RESET"
  return 0
}

step_begin() {
  [ -n "$STEP_TOTAL" ] || return 0
  STEP_NO=$((STEP_NO + 1))
  echo
  printf '%s▌ 第 %d/%d 步%s  %s%s%s\n' "$C_BLUE" "$STEP_NO" "$STEP_TOTAL" "$C_RESET" "$C_B" "$*" "$C_RESET"
  ui_bar "$STEP_NO" "$STEP_TOTAL"
  STEP_NAME="$*"
}

step_end() {
  [ -n "$STEP_TOTAL" ] || return 0
  printf '%s  %s 第 %d/%d 步完成%s\n' "$C_GREEN" "$G_OK" "$STEP_NO" "$STEP_TOTAL" "$C_RESET"
}

on_error() {
  local code="${1:-1}" line="${2:-?}" cmd="${3:-}"
  trap - ERR
  echo
  warn "这一步没能完成（退出码 $code）"
  if [ -n "${STEP_NAME:-}" ]; then warn "当前步骤：$STEP_NAME"; fi
  if [ -n "$line" ]; then warn "出错位置：install.sh 第 $line 行"; fi
  echo
  echo "  先试这几招（按顺序，成功了就继续）："
  echo
  case "$cmd" in
    *docker*compose*|*"docker compose"*)
      warn "看起来是容器相关命令失败"
      echo "    1) $0 doctor              # 一键体检，看看 Docker / 容器 / 端口哪一项坏了"
      echo "    2) $0 logs                # 看应用自己在报什么"
      echo "    3) docker ps -a           # 确认容器状态"
      ;;
    *pull*|*curl*|*wget*|*fetch*|*clone*|*npm*)
      warn "看起来是「拉代码 / 下载镜像」时网络不通"
      echo "    1) $0 install --mirror    # 国内网络加速（重新走一遍安装即可）"
      echo "    2) curl -I https://ghcr.io  # 测一下能不能连上镜像仓库"
      echo "    3) $0 --help              # 查看全部参数"
      ;;
    *apt*|*yum*|*dnf*|*apk*|*systemctl*)
      warn "看起来是系统包管理器 / 服务没能正常工作"
      echo "    1) 换国内镜像源后重试：sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list"
      echo "    2) 确认网络：ping -c2 mirrors.aliyun.com"
      ;;
    *mkdir*|*mount*|*"touch"*|*"cp "*)
      warn "看起来是文件写入被拒绝"
      echo "    1) 用 root 运行本脚本（sudo bash deploy/install.sh install）"
      echo "    2) 确认磁盘没满：df -h /"
      ;;
    *chmod*|*"chown"*)
      warn "看起来是权限不足"
      echo "    1) 用 root 运行：sudo bash deploy/install.sh install"
      ;;
    *)
      warn "通用排查"
      echo "    1) $0 doctor              # 一键体检"
      echo "    2) $0 logs                # 看详细日志"
      echo "    3) 上一条命令：$cmd"
      ;;
  esac
  echo
  warn "配置和数据都还在（不会因为这次失败被清空），修好后重新执行同一条命令即可"
  if [ "$COMMAND" = "install" ]; then
    echo
    echo "  不用从头再来 —— 已完成并记录下来的步骤会自动跳过"
    echo "  （最慢的两步：装 Docker、构建镜像，重跑时都不会重复做）"
    echo "  想强制从头执行： $0 install --reset"
  fi
  if [ "$COMMAND" = "update" ] || [ "$COMMAND" = "upgrade" ]; then
    echo
    echo "  这是「更新 / 升级」过程中出的错：代码可能已经换到新版本，服务未必起来了。"
    echo "    · 先看哪里坏了： $0 doctor"
    echo "    · 退回上一版：   $0 rollback"
  fi
  echo
  exit "$code"
}

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

# Git 用于「新装时留下版本历史」和「一键回滚」。
# 它不是硬依赖：装不上就退回压缩包方式，回滚走下载历史版本的路，功能不缺失。

ensure_git() {
  have git && return 0
  log "未检测到 git，正在安装…（用于版本管理与一键回滚）"
  case "$(detect_distro)" in
    alpine) $SUDO apk add --no-cache git ;;
    debian|ubuntu|raspbian) $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git ;;
    fedora|rhel|centos|rocky|almalinux) $SUDO dnf install -y -q git ;;
    arch|manjaro) $SUDO pacman -Sy --noconfirm git ;;
    *) warn "当前系统无法自动安装 git，将改用压缩包方式（回滚功能不受影响）"; return 0 ;;
  esac
  have git || warn "git 自动安装失败，将改用压缩包方式（回滚功能不受影响）"
}

# 判断 Docker 是否真的可用：二进制存在不等于守护进程可达
# （例如 WSL 里 PATH 上有 Windows 侧的 docker，但守护进程连不上）

# ------------------------------------------------------------
# 配置档：把一次安装的选择存成文件，之后照着它一键复现
# ------------------------------------------------------------
# 优先级：命令行参数 > 配置档 > 环境变量/内置默认值。
# 所以配置档只补「命令行没给」的项，不会覆盖你手敲的参数。
# 这里定义得早、调用得早，是因为它要在任何函数被调用之前生效。
load_config_file() {
  local f="$1"
  [ -f "$f" ] || die "找不到配置档：$f（--config 后面要跟一个真实存在的文件）"
  log "读取配置档：$f"
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
    # 全部写成 `… || VAR=val`：左侧成功则短路（返回 0），失败才赋值，
    # 整条语句永远返回 0 —— 在 set -e 下不会把脚本打断。
    case "$key" in
      DOMAIN)       [ -n "$DOMAIN" ]        || DOMAIN="$val" ;;
      PORT)         [ -n "$APP_PORT" ]      || APP_PORT="$val" ;;
      DB)           [ -n "$DB_KIND" ]       || DB_KIND="$val" ;;
      DATABASE_URL) [ -n "$DATABASE_URL_OPT" ] || DATABASE_URL_OPT="$val" ;;
      DIR)          [ "$DIR_SET" = "1" ]    || INSTALL_DIR="$val" ;;
      REF)          [ "$REF_SET" = "1" ]    || REF="$val" ;;
      REPO)         REPO="$val" ;;
      EMAIL)        [ -n "$EMAIL" ]         || EMAIL="$val" ;;
      IP)           [ -n "$IP_ADDR" ]       || IP_ADDR="$val" ;;
      TIMEZONE)     [ -n "$TIMEZONE" ]      || TIMEZONE="$val" ;;
      ADMIN_EMAIL)  [ -n "$ADMIN_EMAIL_OPT" ] || ADMIN_EMAIL_OPT="$val" ;;
      DATA_DIR)     [ "$DIR_SET" = "1" ]    || DATA_DIR_OPT="$val" ;;
      LOG_LEVEL)    [ -n "$LOG_LEVEL_OPT" ] || LOG_LEVEL_OPT="$val" ;;
      REDIS)        [ -n "$REDIS_OPT" ]    || REDIS_OPT="$val" ;;
      AI_BASE_URL)  [ -n "$AI_BASE_OPT" ]   || AI_BASE_OPT="$val" ;;
      AI_API_KEY)   [ -n "$AI_KEY_OPT" ]    || AI_KEY_OPT="$val" ;;
      AI_MODEL)     [ -n "$AI_MODEL_OPT" ]  || AI_MODEL_OPT="$val" ;;
      S3_ENDPOINT)  [ -n "$S3_ENDPOINT_OPT" ] || S3_ENDPOINT_OPT="$val" ;;
      S3_REGION)    [ -n "$S3_REGION_OPT" ]   || S3_REGION_OPT="$val" ;;
      S3_KEY_ID)    [ -n "$S3_KEY_ID_OPT" ]   || S3_KEY_ID_OPT="$val" ;;
      S3_SECRET)    [ -n "$S3_SECRET_OPT" ]   || S3_SECRET_OPT="$val" ;;
      S3_BUCKET)    [ -n "$S3_BUCKET_OPT" ]   || S3_BUCKET_OPT="$val" ;;
      S3_PUBLIC_BASE) [ -n "$S3_PUBLIC_BASE_OPT" ] || S3_PUBLIC_BASE_OPT="$val" ;;
      SMTP_HOST)    [ -n "$SMTP_HOST_OPT" ] || SMTP_HOST_OPT="$val" ;;
      SMTP_PORT)    [ -n "$SMTP_PORT_OPT" ] || SMTP_PORT_OPT="$val" ;;
      SMTP_USER)    [ -n "$SMTP_USER_OPT" ] || SMTP_USER_OPT="$val" ;;
      SMTP_PASS)    [ -n "$SMTP_PASS_OPT" ] || SMTP_PASS_OPT="$val" ;;
      SMTP_FROM)    [ -n "$SMTP_FROM_OPT" ] || SMTP_FROM_OPT="$val" ;;
      MIRROR)       if [ "$val" = "1" ]; then MIRROR=1; fi ;;
      KEEP)         [ -z "$val" ] || KEEP_N="$val" ;;
      AT)           [ -z "$val" ] || AT_TIME="$val" ;;
      AUTOBACKUP)
        if [ "$val" = "1" ]; then WIZ_BACKUP=1; fi
        if [ "$val" = "0" ]; then NO_AUTOBACKUP=1; fi
        ;;
    esac
  done < "$f"
}

usage() {
  cat <<'EOF'
轻语博客 · 自托管通用版 一键部署

  最简单的用法：什么都不填，跑完就能打开网站
      curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash
      （或在本仓库里执行： bash deploy/install.sh）

  默认行为：不提问、不需要任何配置。
  自动完成「装 Docker → 取代码 → 建库 → 启动」，装完直接给你一个能打开的网址，
  管理员密码、站名、AI 摘要、邮件、图床等全部进后台「设置」里填即可。

  想自动 HTTPS（有域名时）：加 --domain 你的域名
  想换端口：              加 --port 8080
  想手动确认每一步：      加 --wizard

────────────────────────────────────────────────────────────────────────
【可选配置】全部不填也能正常跑；以下只是「懒得进后台时」的一次性替代
────────────────────────────────────────────────────────────────────────

  访问方式
    --domain <域名>         对外域名，自动申请 HTTPS 证书
    --port   <端口>         直接对外端口，纯 HTTP（默认 8080）
    --ip     <地址>         无域名时写入站点地址的 IP（默认自动探测）
    --db     <数据库>       sqlite（默认）| postgres（脚本自动起内置容器）
    --database-url <连接串> 用自己的云数据库（RDS / Supabase 等）

  站点与运行
    --dir        <目录>     安装目录，默认 /opt/qingyu-universal
    --data-dir   <目录>     数据目录，默认 <安装目录>/data
    --admin-email <邮箱>    管理员邮箱
    --log-level  <级别>     error | warn | info | debug
    --redis      <连接串>   Redis / Valkey（留空 = 用数据库自带 KV）
    --email      <邮箱>     证书到期通知邮箱
    --repo       <owner/repo>  代码仓库，默认 kejiland/qingyu-universal
    --ref        <分支/标签>  代码版本，默认 main
    --image      [<镜像>]     用预构建镜像，不在本机构建
    --prebuilt             同上，直接用脚本内置的默认镜像（小内存机器装法一条路）
    --local-build          强制本地构建（并清掉 .env 里的镜像设置）
    --lowmem               本地构建时走低内存模式（两个 npm 构建串行）
                              内存 < 1200 MB 时自动开启，可用 --no-lowmem 关闭

  AI 摘要（也可在后台「设置 → AI」填）
    --ai-base-url <地址> --ai-key <密钥> --ai-model <模型>

  对象存储（也可在后台「设置 → 存储」填；留空 = 存本地磁盘）
    --s3-endpoint --s3-region --s3-key-id --s3-secret --s3-bucket --s3-public-base

  备份
    --keep <份数>           定时备份保留几份（默认 7）
    --at   <HH:MM>          每天几点备份（默认 03:30）
    --off                   不装定时备份
    --no-autobackup          同 --off（安装后不装定时备份）

  网络加速（国内机器建议加 --mirror）
    --mirror               GitHub / Docker / npm 全走国内源
    --no-mirror            关闭加速
    --github-proxy <前缀>  自定义 GitHub 加速前缀

  邮件通知（也可在后台「设置 → 邮件」填）
    --smtp-host --smtp-port --smtp-user --smtp-pass --smtp-from

────────────────────────────────────────────────────────────────────────
【日常运维】
────────────────────────────────────────────────────────────────────────
  install（默认）      安装并启动；已部署过时直接弹出数字菜单
  update               有新代码就更新（先备份再重建，没有新版什么都不做）
  check-update         只看有没有新代码，不改动任何东西
  upgrade              强制拉最新代码并重建（保留数据）
  rollback             回滚到上一版（回滚前自动备份）
  domain               域名与 HTTPS：status（DNS 指向 + 证书到期）/ set [域名]
                       / add [别名域名] / rm [别名域名] / port [端口] / off
  restart              重启（改完 .env 后用它生效）
  start / stop         启动 / 停止（配置和数据都保留）
  logs                 查看应用日志
  status               容器与健康状态
  info                 部署信息（访问地址、初始化密钥、版本、文章数…）
  sysinfo              服务器家底：CPU / 内存 / 磁盘 / 负载 / 网卡流量 / 公网 IP 与归属地
  speedtest            网络测速：到几个目标地址的延迟 + 上下行带宽（只测不改）
  clean                 清理磁盘：只删 Docker 的悬空镜像 + 构建缓存，不碰数据和运行中的容器
  tune                 服务器调优（可选）：BBR + 队列 + 内存策略；不碰 SSH，带 --restore 可撤销
                         tune --apply 直接调优不询问；tune --restore 撤销调优
  doctor               一键体检：Docker / 容器 / 端口 / 防火墙 / 公网 / 磁盘
  backup               立刻生成一份数据库快照
  autobackup           安装每日定时备份
  restore <快照文件>    从快照恢复（先 stop）
  migrate              打包整站（含数据），用于换服务器
  uninstall            删除容器（数据卷保留）
  shortcut [字母]      设置/移除终端快捷键（默认敲 k 直接打开运维菜单）

────────────────────────────────────────────────────────────────────────
【高级】
────────────────────────────────────────────────────────────────────────
  -y, --yes            全程不提问（自动化 / CI）
  --wizard             手动问答向导（默认不向导）
  --no-wizard          不提问（默认行为，保留为兼容写法）
  --config <文件>       照着配置档装
  --save-config <文件>  把本次选择存成配置档
  --dry-run            只打印「将要做什么」，什么都不改
  --timezone <时区>     设置系统时区，如 Asia/Shanghai
  --out <文件>         migrate 生成的 tar.gz 保存路径
  --purge              uninstall 时连数据卷一起删
  --skip-preflight     跳过起飞前检查
  --no-doctor          安装后不做自动体检
  --check              update 时只检查不改动
  --reset, --fresh     清除安装进度记录，从头执行
  --key <字母>         自定义快捷键（默认 k，大小写都行）
  --remove            移除已设置的快捷键
  --no-shortcut        不设置快捷键
  --all                更新时连「只改文档/测试」的远端提交也一并拉下来（默认跳过）
  -h, --help           显示本帮助
  换域名（已部署之后）：
    ./deploy/install.sh domain              查看当前域名、DNS 与证书状态
    ./deploy/install.sh domain set blog.example.com   切到新域名（自动 HTTPS）
    ./deploy/install.sh domain set                 不带域名则交互提问，走同一套流程
    ./deploy/install.sh domain add www.example.com   再绑一个域名（同一站点，自动 HTTPS）
    ./deploy/install.sh domain rm  www.example.com   解绑别名
    ./deploy/install.sh domain port [8080]  退回 IP + 端口模式

  配置档示例（KEY=VALUE，# 开头是注释；命令行参数优先级更高）：
      DOMAIN=blog.example.com
      DB=sqlite
      TIMEZONE=Asia/Shanghai

  断点续跑：安装中途失败不用重来，原样再跑一次同一条命令即可，
            已完成并记录的步骤会自动跳过（想从头来就加 --reset）。
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

# 通过 GitHub 的 Atom feed 取某个分支 / 标签的完整 commit SHA。
# 它走网页，不受 api.github.com 的限流（未认证每小时 60 次，实测经常直接 403）。
# 取不到则返回空串，不影响部署。
#
# 注意：这里先把响应存进变量再解析，**不能**写成
#   curl … | grep -m1 …
# 因为脚本开了 set -o pipefail，而 grep -m1 命中后立即退出会让 curl 收到
# SIGPIPE（141），pipefail 把整条管道判为失败 —— 而且这是竞态：
# curl 先写完就正常，所以单独测试能过、在脚本里却拿到空值。

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
