#!/usr/bin/env bash
# ============================================================
# 本地 / 开发机：源码改动后重建镜像并原样替换容器
# ------------------------------------------------------------
# 用法：
#   bash deploy/rebuild-local.sh              # 重建并替换
#   bash deploy/rebuild-local.sh --no-build   # 只换容器，不重建镜像
#   bash deploy/rebuild-local.sh --mirror     # 走国内镜像源构建（Docker Hub / npm / apk）
#
# 设计要点：
#   · 端口、环境变量、数据卷全部**从现有容器读回**，脚本里不硬编码任何密钥，
#     也不会因为漏传某个变量而把站点配坏。容器不存在时才用下面的默认值兜底。
#   · 数据卷用同一个卷名重新挂载 —— 文章、评论、上传的图片都保留。
#   · BUILD_REVISION 用当前 git 短 SHA，装进镜像后由 /healthz 返回，
#     用来确认「这次更新到底生效没有」。
#
# 环境变量（都可覆盖）：IMAGE / NAME / PORT / SETUP_KEY / RESTART / VOLUME
#   QINGYU_MIRROR=1        等价于 --mirror
#   QINGYU_NPM_REGISTRY    npm 源（默认 https://registry.npmmirror.com）
#   ALPINE_MIRROR          apk 源（默认 https://mirrors.aliyun.com/alpine）
# ============================================================
set -euo pipefail

# 【关于 Git Bash（MSYS2）的路径转换】
# MSYS2 会把传给**非 MSYS 程序**（这里是 Windows 原生的 docker.exe）的、形如 `KEY=/data`
# 的参数值改写成 Windows 路径（实测 `-e DATA_DIR=/data` → `-e DATA_DIR=D:/Program Files/Git/data`），
# 写进容器后会让应用启动即崩（EACCES mkdir）。
#
# 但**不能**简单粗暴地 `export MSYS_NO_PATHCONV=1`：那会同时禁用 docker build 的 context
# 路径转换（`/e/Qingyu-vps` 原样传给 docker.exe → "path not found"）以及 git 的路径处理。
#
# 本脚本采用精确方案：从旧容器读回环境变量时，**把镜像自带的路径型变量全部跳过**
# （见下方 while 循环的 case），使 `-e` 参数里不会出现以 `/` 开头的值；万一还有漏网的，
# 由循环内的守卫直接报错退出，绝不静默写进容器。

IMAGE="${IMAGE:-qingyu-universal:local}"
NAME="${NAME:-qingyu-linux}"
PORT="${PORT:-8788}"
SETUP_KEY="${SETUP_KEY:-}"
RESTART="${RESTART:-}"
VOLUME="${VOLUME:-}"
MIRROR="${QINGYU_MIRROR:-0}"
NPM_REGISTRY="${QINGYU_NPM_REGISTRY:-}"
ALPINE_MIRROR="${ALPINE_MIRROR:-}"

NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --mirror) MIRROR=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "未找到 docker 命令" >&2; exit 1; }

# ---------- 0. 国内镜像加速 & 基础镜像预检 ----------
# 【为什么需要这一步】
# Docker Hub 在部分网络下完全不可达（表现为 `docker build` 在第一步
# `[internal] load metadata for docker.io/library/node:24-alpine` 上失败：
#  failed to fetch oauth token: Post "https://auth.docker.io/token": EOF）。
# 此时即使 Dockerfile 一个字没改也构建不了，所以要先解决两件事：
#   1) 基础镜像：缺失时先从国内镜像源拉取，再打上官方标签 —— 之后 FROM 直接命中本地镜像，
#      BuildKit 不再需要连 Docker Hub 解析元数据（配合默认的 --pull=false）。
#   2) npm / apk 源：构建容器内的 `npm ci` 与 `apk add` 也需要外网，一并换成国内源。
# 只在显式传 --mirror（或 QINGYU_MIRROR=1）时换源，与 deploy/install.sh 的约定保持一致。
# ----------
if [ "$MIRROR" = "1" ]; then
  [ -n "$NPM_REGISTRY" ] || NPM_REGISTRY="https://registry.npmmirror.com"
  [ -n "$ALPINE_MIRROR" ] || ALPINE_MIRROR="https://mirrors.aliyun.com/alpine"
  say "已启用国内加速：npm=$NPM_REGISTRY · apk=$ALPINE_MIRROR"
fi

BASE_IMAGE="$(awk '/^FROM /{print $2; exit}' deploy/Dockerfile)"
if [ -n "$BASE_IMAGE" ] && ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  say "本地缺少基础镜像 $BASE_IMAGE，尝试从国内镜像源拉取"
  BASE_MIRRORS=("docker.1ms.run" "dockerproxy.net" "docker.nju.edu.cn")
  PULLED=0
  for m in "${BASE_MIRRORS[@]}"; do
    for ref in "${m}/library/${BASE_IMAGE}" "${m}/${BASE_IMAGE}"; do
      if docker pull "$ref" >/dev/null 2>&1; then
        docker tag "$ref" "$BASE_IMAGE"
        say "已从 $ref 拉取并标记为 $BASE_IMAGE"
        PULLED=1
        break 2
      fi
    done
  done
  if [ "$PULLED" -eq 0 ]; then
    echo "错误：无法获取基础镜像 $BASE_IMAGE（Docker Hub 与国内镜像源都不可达）。" >&2
    echo "      可手工执行（任选一个能通的镜像源）：" >&2
    echo "        docker pull docker.1ms.run/library/$BASE_IMAGE" >&2
    echo "        docker tag docker.1ms.run/library/$BASE_IMAGE $BASE_IMAGE" >&2
    echo "      或先配置 Docker Desktop 的 registry-mirrors 后重试。" >&2
    exit 1
  fi
fi

# ---------- 1. 读回现有容器的配置 ----------
ENV_ARGS=()
VOL_ARGS=()
EXISTS=0
if docker inspect "$NAME" >/dev/null 2>&1; then
  EXISTS=1
  say "发现现有容器 $NAME，读回其配置"

  # 端口：HostConfig.PortBindings 里 8787/tcp 对应的宿主机端口
  mapped="$(docker inspect "$NAME" --format '{{range $k,$v := .HostConfig.PortBindings}}{{if eq $k "8787/tcp"}}{{range $v}}{{.HostPort}}{{end}}{{end}}{{end}}')"
  [ -n "$mapped" ] && PORT="$mapped"

  # 环境变量：只带回「部署时自定义」的变量，其余一律跳过。
  #
  # 跳过的是镜像自带的 ENV（见 deploy/Dockerfile：BUILD_REVISION / NODE_ENV / HOST / PORT /
  # DATA_DIR / ADMIN_DIST_DIR，以及 alpine 的 PATH / NODE_VERSION / YARN_VERSION）：
  #   · BUILD_REVISION 由本次 --build-arg 决定，从旧容器读回（往往是空串）会以
  #     `-e BUILD_REVISION=` 覆盖新镜像的值，让 /healthz 永远看不到 revision。
  #   · DATA_DIR / ADMIN_DIST_DIR 是容器内固定路径，且**最容易被 Git Bash 改写成
  #     `D:/Program Files/Git/data` 这类 Windows 路径** —— 一旦写进容器，应用启动即崩。
  while IFS= read -r line; do
    case "$line" in
      PATH=*|NODE_VERSION=*|YARN_VERSION=*) continue ;;
      BUILD_REVISION=*|NODE_ENV=*|HOST=*|PORT=*) continue ;;
      DATA_DIR=*|ADMIN_DIST_DIR=*) continue ;;
      MSYS_NO_PATHCONV=*|MSYS2_ARG_CONV_EXCL=*|"") continue ;;
    esac
    # 守卫：剩下的变量若值以 / 开头（Git Bash 会改写它）或已被改写成盘符路径 → 报错退出。
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z]:/ ]]; then
      echo "错误：环境变量值已被 Git Bash 改写成 Windows 路径：$line" >&2
      echo "      请检查旧容器是用什么命令建的，并把这个变量名加进本脚本的跳过列表。" >&2
      exit 1
    fi
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=/[^/] ]]; then
      echo "错误：环境变量值以 / 开头，会被 Git Bash 改写：$line" >&2
      echo "      若它确实是容器内绝对路径（如 /data），应加入跳过列表改用镜像自带的 ENV。" >&2
      exit 1
    fi
    ENV_ARGS+=(-e "$line")
  done < <(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}')

  # 数据卷：/data 指向哪个卷就还用哪个卷。读不到宁可报错 ——
  # 静默不传 -v 会让 Docker 按镜像的 VOLUME ["/data"] 新建匿名卷，看起来像「数据全丢了」。
  vol="$(docker inspect "$NAME" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
  [ -n "$VOLUME" ] && vol="$VOLUME"
  if [ -z "$vol" ]; then
    echo "错误：容器 $NAME 存在，但没有读到挂载到 /data 的卷。" >&2
    echo "      继续执行会新建匿名卷并让站点看起来是空的。请手工指定：VOLUME=<卷名> bash $0" >&2
    exit 1
  fi
  VOL_ARGS=(-v "$vol:/data")
  say "数据卷：$vol"

  if [ -z "$RESTART" ]; then
    RESTART="$(docker inspect "$NAME" --format '{{.HostConfig.RestartPolicy.Name}}')"
    [ -z "$RESTART" ] && RESTART=no
  fi
else
  say "未发现容器 $NAME，按默认参数新建（端口 $PORT）"
  VOL_ARGS=(-v "${NAME}-data:/data")
  ENV_ARGS=(-e "SITE_URL=http://localhost:${PORT}" -e "TRUST_PROXY=1")
  [ -n "$SETUP_KEY" ] && ENV_ARGS+=(-e "BLOG_ADMIN_SETUP_KEY=${SETUP_KEY}")
  RESTART="${RESTART:-no}"
fi

# ---------- 2. 重建镜像 ----------
if [ "$NO_BUILD" -eq 0 ]; then
  REVISION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '')"
  say "构建镜像 $IMAGE（BUILD_REVISION=${REVISION:-空}）"
  BUILD_ARGS=(--build-arg "BUILD_REVISION=${REVISION}")
  if [ -n "$NPM_REGISTRY" ]; then BUILD_ARGS+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}"); fi
  if [ -n "$ALPINE_MIRROR" ]; then BUILD_ARGS+=(--build-arg "ALPINE_MIRROR=${ALPINE_MIRROR}"); fi
  docker build \
    -f deploy/Dockerfile \
    "${BUILD_ARGS[@]}" \
    -t "$IMAGE" \
    "$ROOT"
else
  say "跳过镜像构建（--no-build）"
fi

# ---------- 3. 替换容器 ----------
if [ "$EXISTS" -eq 1 ]; then
  say "停止并移除旧容器 $NAME（数据卷保留）"
  docker stop "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null   # 注意：不加 -v，数据卷必须留下
fi

say "启动新容器（端口 ${PORT}，restart=${RESTART}）"
docker run -d \
  --name "$NAME" \
  --restart "$RESTART" \
  -p "${PORT}:8787" \
  "${VOL_ARGS[@]}" \
  "${ENV_ARGS[@]}" \
  "$IMAGE" >/dev/null

# ---------- 4. 等待健康检查 ----------
say "等待健康检查"
for i in $(seq 1 45); do
  status="$(docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then break; fi
  if [ "$i" -eq 45 ]; then
    echo "健康检查未通过（当前状态：$status），最近日志：" >&2
    docker logs --tail 40 "$NAME" >&2 || true
    exit 1
  fi
  sleep 2
done

REV="$(docker exec "$NAME" node -e "process.stdout.write(process.env.BUILD_REVISION||'')" 2>/dev/null || true)"
say "完成。访问 http://localhost:${PORT}/admin（后台）· http://localhost:${PORT}/（前台）"
say "版本 revision：${REV:-（空，非 git 构建）}"
# 本机若设了 http_proxy，curl 会把 127.0.0.1 也走代理导致误报（502）——显式绕开
curl -fsS --noproxy '*' "http://localhost:${PORT}/healthz" 2>/dev/null && echo || true
