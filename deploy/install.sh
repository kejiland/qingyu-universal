#!/usr/bin/env bash
# ============================================================
# 轻语博客 · 一键部署引导脚本
# ------------------------------------------------------------
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/kejiland/qingyu-universal/main/deploy/install.sh | bash
#
# 这个文件刻意做得很薄：它只负责把 qy.sh 弄到服务器上，然后交给它。
# 真正的安装逻辑全在 deploy/qy.sh 里，那边有完整的测试护栏。
# 之前踩过的坑 —— 兜底克隆少了 https://github.com 前缀，导致
# "fatal: repository 'kejiland/qingyu-universal' does not exist" ——
# 就是从「脚本太胖，自己干太多事」来的。
# ============================================================
set -euo pipefail

REPO="kejiland/qingyu-universal"
BRANCH="main"
APP_DIR="${QINGYU_DIR:-/opt/qingyu-universal}"
TARGET="$APP_DIR/deploy/qy.sh"

have() { command -v "$1" >/dev/null 2>&1; }
step() { printf '\n\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

download() {
  curl -fsSL --retry 3 --retry-delay 2 \
    "https://raw.githubusercontent.com/$REPO/$BRANCH/deploy/qy.sh" -o "$1.part"
}

# 已有完整仓库就直接用（也顺便更新到最新）
if [ -d "$APP_DIR/.git" ]; then
  step "更新已有代码"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" \
    || die "拉取代码失败，请检查服务器网络能否访问 github.com"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH" >/dev/null
elif [ -f "$TARGET" ]; then
  ok "已存在 $TARGET"
else
  step "下载部署助手"
  have curl || die "没装 curl，请先执行：apt-get install -y curl（或 yum install -y curl）"
  mkdir -p "$(dirname "$TARGET")" || die "创建目录 $APP_DIR 失败，请用 root 或换个 QINGYU_DIR 重试"
  download "$TARGET" || die "下载失败，请检查服务器网络能否访问 raw.githubusercontent.com"
  mv "$TARGET.part" "$TARGET"
  ok "已下载到 $TARGET"
fi

[ -f "$TARGET" ] || die "没找到 qy.sh，请到 $APP_DIR 检查一下"
exec bash "$TARGET" "$@"