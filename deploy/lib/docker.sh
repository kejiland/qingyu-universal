# ============================================================
# docker.sh —— Docker 安装、镜像加速、Compose 封装与镜像构建
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
resolve_docker() {
  if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    DOCKER="docker"
  fi
}

github_proxy_list() {
  if [ -n "$GITHUB_PROXY" ]; then printf '%s\n' "${GITHUB_PROXY%/}"; return 0; fi
  printf '%s\n' "https://ghfast.top" "https://gh-proxy.com" "https://ghproxy.net"
}

# 同一个 GitHub 资源的候选地址。
# 入参既可以是相对路径（owner/repo/archive/...），也可以是完整 URL（自动剥掉域名）。

github_urls() {
  local path="${1#https://github.com/}" p
  if [ "${MIRROR:-0}" = "1" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      printf '%s\n' "${p}/https://github.com/$path"
    done < <(github_proxy_list)
  fi
  printf '%s\n' "https://github.com/$path"
}

# git clone 的候选地址（加速服务对 .git 的支持和普通下载不一样，单独一份）

git_clone_urls() {
  if [ "${MIRROR:-0}" = "1" ]; then
    if [ -n "$GITHUB_PROXY" ]; then
      printf '%s\n' "${GITHUB_PROXY%/}/https://github.com/$REPO.git"
    fi
    printf '%s\n' "https://gitclone.com/github.com/$REPO.git"
  fi
  printf '%s\n' "https://github.com/$REPO.git"
}

# 下载 GitHub 上的资源：逐个候选地址试，成功返回 0，全失败返回 1（由调用方决定要不要报错）

gh_fetch() {
  local path="$1" out="$2" u
  while IFS= read -r u; do
    if curl -fsSL --connect-timeout 8 --max-time 180 "$u" -o "$out" 2>/dev/null; then
      return 0
    fi
    rm -f "$out"
  done < <(github_urls "$path")
  return 1
}

# Debian / Ubuntu 走阿里云的 docker-ce 源（get.docker.com 国内经常超时）。
# 成功返回 0；不适合当前系统或失败返回 1，由调用方回落官方一键脚本。

install_docker_mirror() {
  local distro codename arch
  distro="$(detect_distro)"
  case "$distro" in debian|ubuntu) ;; *) return 1 ;; esac
  [ -r /etc/os-release ] || return 1
  codename="$([ -r /etc/os-release ] && . /etc/os-release; echo "${VERSION_CODENAME:-}")"
  [ -n "$codename" ] || return 1
  arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  log "用阿里云镜像源安装 Docker（${distro} ${codename}）"
  $SUDO apt-get update -qq || return 1
  $SUDO apt-get install -y -qq ca-certificates curl gnupg || return 1
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL --connect-timeout 8 "https://mirrors.aliyun.com/docker-ce/linux/${distro}/gpg" \
    | $SUDO gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg || return 1
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/%s %s stable\n' \
    "$arch" "$distro" "$codename" | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq || return 1
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
  have docker
}

# Docker Hub 镜像加速：写 /etc/docker/daemon.json 的 registry-mirrors。
# 已有配置一律不动（怕把用户自己的加速地址或 runtime 配置弄坏）。

configure_registry_mirror() {
  [ "${MIRROR:-0}" = "1" ] || return 0
  # Docker Desktop 自己管 daemon.json，不碰
  if ${DOCKER:-docker} info 2>/dev/null | grep -qi 'docker desktop'; then
    log "检测到 Docker Desktop，镜像加速请在 Desktop 的设置里配置"
    return 0
  fi
  local dj="/etc/docker/daemon.json"
  if [ -f "$dj" ] && grep -q 'registry-mirrors' "$dj" 2>/dev/null; then
    log "Docker 镜像加速已配置，保持不变"
    return 0
  fi
  if [ -f "$dj" ]; then
    warn "/etc/docker/daemon.json 已存在但没有 registry-mirrors，为不破坏原配置未自动改写"
    warn "  可手动加上：\"registry-mirrors\": [\"https://docker.m.daocloud.io\"] 后重启 Docker"
    return 0
  fi
  $SUDO mkdir -p /etc/docker
  $SUDO tee "$dj" >/dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live",
    "https://mirror.baidubce.com"
  ]
}
EOF
  log "已写入 Docker 镜像加速（/etc/docker/daemon.json）"
  $SUDO systemctl restart docker >/dev/null 2>&1 \
    || $SUDO service docker restart >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 20 ]; do
    if ${DOCKER:-docker} info >/dev/null 2>&1; then
      log "Docker 已重启并就绪"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  warn "Docker 重启后还没就绪，请检查：systemctl status docker"
}

# 升级时把 --mirror 的选择追加进已有的 .env（首次安装由 ensure_env 直接写入）

persist_mirror_env() {
  [ "${MIRROR:-0}" = "1" ] || return 0
  local env_file="$INSTALL_DIR/.env" need=0
  [ -f "$env_file" ] || return 0
  grep -q '^QINGYU_MIRROR=' "$env_file" 2>/dev/null || need=1
  grep -q '^NPM_REGISTRY='  "$env_file" 2>/dev/null || need=1
  [ "$need" = "1" ] || return 0
  local block
  block='
# 国内网络加速（deploy/install.sh --mirror 生成）
'
  grep -q '^QINGYU_MIRROR=' "$env_file" 2>/dev/null || block="${block}QINGYU_MIRROR=1
"
  grep -q '^NPM_REGISTRY='  "$env_file" 2>/dev/null || block="${block}NPM_REGISTRY=${NPM_REGISTRY_OPT}
"
  if [ -w "$env_file" ]; then
    printf '%s' "$block" >> "$env_file"
  else
    printf '%s' "$block" | $SUDO tee -a "$env_file" >/dev/null
  fi
  log "已把国内加速设置写入 .env（下次升级自动沿用）"
}

install_docker() {
  if docker_ready; then
    log "Docker 与 Compose 已就绪（$(docker --version)）"
    return
  fi
  ensure_curl
  log "未检测到可用的 Docker，正在安装…"
  if [ "$(detect_distro)" = "alpine" ]; then
    $SUDO apk add --no-cache docker docker-cli-compose
    $SUDO rc-update add docker default || true
    $SUDO service docker start || true
  else
    # 国内服务器先试阿里云的 docker-ce 源（get.docker.com 国内经常超时），
    # 失败或不是 Debian 系就回落官方一键脚本
    if [ "${MIRROR:-0}" = "1" ] && install_docker_mirror; then
      log "Docker 安装完成（阿里云镜像源）"
    else
      curl -fsSL https://get.docker.com | $SUDO sh
    fi
    $SUDO systemctl enable --now docker || true
  fi
  have docker || die "Docker 安装失败，请手动安装后重试"
  $SUDO docker compose version >/dev/null 2>&1 || warn "未检测到 compose 插件，请确认 docker compose 可用"
}

compose() {
  cd "$INSTALL_DIR"
  if [ -n "$IMAGE" ]; then export QINGYU_IMAGE="$IMAGE"; fi
  ${DOCKER:-docker} compose "$@"
}

# ----------------------------------------------------------
# 构建策略：省内存地构建 / 部署镜像
# ----------------------------------------------------------
# 1G / 512M 的小机器上直接 `compose up -d --build` 很容易被 OOM 杀掉：
# 后台 SPA 构建和服务端 tsc 构建是两个互不依赖的 stage，BuildKit 会【并行】跑它们，
# 两个 npm build 一起抢内存，峰值远高于机器的物理内存（你的日志里两个 build 同时跑了 149 秒）。
# 这里给两条省内存的走法，compose_build() 按参数自动挑：
#   ① --image <镜像>：完全跳过本地构建，只拉预构建镜像 —— 资源占用最低
#   ② --lowmem       ：仍然本地构建，但把两个重 stage 拆成串行，并压住 Node 堆上限

# 是否启用低内存构建。LOWMEM=auto 时按物理内存自动判断（< 1200 MB 视为小机器）。

lowmem_mode() {
  case "${LOWMEM:-auto}" in
    on|1|yes|true)  return 0 ;;
    off|0|no|false) return 1 ;;
  esac
  local kb
  kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  [ -n "$kb" ] || return 1
  [ "$kb" -lt 1228800 ]
}

# 串行构建：先用 --target 分别把两个重 stage 跑一遍（只写构建缓存，不产出镜像），
# 再做一次完整构建组装最终镜像 —— 这一步会直接命中刚才的缓存，几乎不耗 CPU。
# 关键点：--target 把 BuildKit 的并行图拆成两次调用，两个 npm build 就变成先后执行，
# 内存峰值从「两个加起来」降到「单个」。
build_staged() {
  local d="${DOCKER:-docker}"
  local tag="${IMAGE:-}"
  [ -n "$tag" ] || tag="$(env_value QINGYU_IMAGE)"
  [ -n "$tag" ] || tag="qingyu-universal:local"
  local reg rev cacheonly
  reg="$(env_value NPM_REGISTRY)"
  rev="${BUILD_REVISION:-}"
  # 老版本 Docker 没有 cacheonly 输出类型，退化成普通构建（仍然只多花一次时间）
  cacheonly=()
  if "$d" build --help 2>/dev/null | grep -q -- '--output'; then
    cacheonly=(--output type=cacheonly)
  fi

  cd "$INSTALL_DIR"

  log "  · 1/3 单独构建后台 SPA（admin）…"
  "$d" build -f deploy/Dockerfile \
    --build-arg "NPM_REGISTRY=$reg" \
    --build-arg "BUILD_REVISION=$rev" \
    --build-arg "NODE_OPTIONS=$LOWMEM_NODE_OPTIONS" \
    --target admin-build "${cacheonly[@]}" . \
    || warn "admin 预构建没成功（不影响继续，最后一步会重跑这一段）"

  log "  · 2/3 单独构建服务端（server）…"
  "$d" build -f deploy/Dockerfile \
    --build-arg "NPM_REGISTRY=$reg" \
    --build-arg "BUILD_REVISION=$rev" \
    --build-arg "NODE_OPTIONS=$LOWMEM_NODE_OPTIONS" \
    --target server-build "${cacheonly[@]}" . \
    || warn "server 预构建没成功（不影响继续，最后一步会重跑这一段）"

  log "  · 3/3 组装最终镜像（命中缓存，这一轮很快）…"
  "$d" build -f deploy/Dockerfile \
    --build-arg "NPM_REGISTRY=$reg" \
    --build-arg "BUILD_REVISION=$rev" \
    --build-arg "NODE_OPTIONS=$LOWMEM_NODE_OPTIONS" \
    -t "$tag" . \
    || die "镜像构建失败。
    内存不够的话：加 1G swap（fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile），
    或改用预构建镜像：$0 install --prebuilt"
}

# 所有需要「构建并启动」的地方都走这里，取代裸的 compose up -d --build

compose_build() {
  # ① 预构建镜像：只 pull，完全不本地构建（最省内存，1G 机器首选）
  if [ -n "$IMAGE" ]; then
    log "使用预构建镜像，跳过本地构建：$IMAGE"
    env_set QINGYU_IMAGE "$IMAGE" || true
    compose pull app 2>/dev/null || compose pull --ignore-pull-failures 2>/dev/null || true
    compose up -d --no-build
    return 0
  fi
  # --local-build：显式要求本地构建，把 .env 里记着的预构建镜像设置清掉
  if [ "${IMAGE_SET:-0}" = "1" ]; then env_set QINGYU_IMAGE "" || true; fi
  # ② 低内存机器：串行构建
  if lowmem_mode; then
    log "内存偏紧：改用串行构建（两个 npm build 不再抢内存）"
    build_staged
    compose up -d --no-build
    return 0
  fi
  # ③ 常规机器：默认并行构建，最快
  compose up -d --build
}

wait_healthy() {
  log "等待服务就绪…"
  local i=0 port
  port="$(local_health_port)"
  while [ $i -lt 60 ]; do
    # 只认 app 这一个容器：`compose ps` 不带服务名会把 postgres/redis/caddy
    # 的 healthy 也算进来，数据库刚起来时会误判成「应用已就绪」。
    if ${DOCKER:-docker} compose ps app --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
      log "服务已健康"
      return 0
    fi
    # 最终以应用自己应答为准：/healthz 通了才代表迁移跑完、数据库连上了
    if [ -n "$port" ] && curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log "服务已响应"
      return 0
    fi
    i=$((i + 1)); sleep 3
  done
  warn "应用 3 分钟内没有就绪（可能是数据库迁移失败 / 端口没通 / 镜像构建出错）"
  warn "查看日志：docker compose -f $INSTALL_DIR/compose.yaml logs -f app"
  return 1
}
