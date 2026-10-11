# ============================================================
# detect.sh —— 运行环境探测：Docker、系统发行版、公网 IP、镜像加速开关
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
docker_ready() {
  have docker || return 1
  # 非 root 且不在 docker 组时，守护进程只能用 sudo 访问 —— 先试直接访问再试 sudo，
  # 否则会被误判成「Docker 未安装」而重复走安装流程
  if docker info >/dev/null 2>&1; then
    docker compose version >/dev/null 2>&1
    return $?
  fi
  have sudo || return 1
  sudo docker info >/dev/null 2>&1 || return 1
  sudo docker compose version >/dev/null 2>&1
}

detect_distro() {
  if [ -f /etc/os-release ]; then . /etc/os-release; echo "${ID:-linux}"; else echo linux; fi
}

# ============================================================
# 国内网络加速（--mirror）
# ------------------------------------------------------------
# 只做三件事，而且每件都有「失败就回落官方源」的兜底：
#   1) GitHub 代码：克隆 / 压缩包 / 版本查询先走加速前缀
#   2) Docker Hub：往 /etc/docker/daemon.json 写 registry-mirrors
#   3) npm：构建镜像时把 registry 换成 npmmirror
# 只在显式传 --mirror、或 .env 里记着 QINGYU_MIRROR=1 时生效。
# ============================================================

# 没显式指定时，沿用 .env 里记下的选择（升级时不用重复加 --mirror）

resolve_mirror() {
  if [ -z "$MIRROR" ]; then
    if [ -f "$INSTALL_DIR/.env" ] && grep -q '^QINGYU_MIRROR=1' "$INSTALL_DIR/.env" 2>/dev/null; then
      MIRROR=1
    else
      MIRROR=0
    fi
  fi
  [ "$MIRROR" = "1" ] || return 0
  [ -n "$NPM_REGISTRY_OPT" ] || NPM_REGISTRY_OPT="https://registry.npmmirror.com"
  log "已启用国内加速：GitHub 代码 / Docker Hub 镜像 / npm 依赖"
}

# GitHub 加速前缀（按顺序试；都试不通就用官方直连）

# 探测对外 IP：云主机通常在 NAT 后，本地网卡看到的只是内网地址，
# 所以优先问外部回显服务，失败再退回第一块网卡。

detect_ip() {
  local ip=""
  ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [ -z "$ip" ] && ip=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)
  [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${ip:-127.0.0.1}"
}
# 公网 IPv6：机器没配 v6 路由时 curl 会立刻失败，返回空即可，不能拖慢命令

detect_ip6() {
  have curl || { printf ''; return 0; }
  curl -6 -fsS --max-time 5 https://api6.ipify.org 2>/dev/null \
    || curl -6 -fsS --max-time 5 https://ifconfig.co 2>/dev/null \
    || true
}
