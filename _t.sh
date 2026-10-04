#!/usr/bin/env bash
set -uo pipefail
cd /mnt/e/Qingyu-vps
awk '/^# ---------- 各子命令 ----------$/{exit} {print}' deploy/install.sh > /tmp/qy-f.sh
source /tmp/qy-f.sh

INSTALL_DIR=/tmp/qy-upg-test
rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
# 模拟「压缩包安装」：有 compose.yaml 但没有 .git，且 SOURCE_ROOT 与 INSTALL_DIR 不同
cp compose.yaml "$INSTALL_DIR/" 2>/dev/null || true
echo "老代码" > "$INSTALL_DIR/README.md"
echo "SITE_URL=http://keep.me" > "$INSTALL_DIR/.env"
echo "数据" > "$INSTALL_DIR/data-marker"

SUDO=""; SOURCE_ROOT="/nonexistent"; REPO="kejiland/qingyu-universal"; REF="main"

echo "=== update_source 的取码分支 ==="
if [ -d "$INSTALL_DIR/.git" ]; then echo "  → git pull"; else
  if [ -n "${SOURCE_ROOT:-}" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ "$SOURCE_ROOT" != "$INSTALL_DIR" ]; then
    echo "  → 复制本地代码"
  else
    echo "  → 下载最新代码包（预期）"
  fi
fi

echo
echo "=== 真实执行 update_source ==="
update_source 2>&1 | tail -4

echo
echo "=== 结果检查 ==="
printf '  README.md 内容: %s\n' "$(head -c 30 "$INSTALL_DIR/README.md" 2>/dev/null | tr -d '\n')"
printf '  .env 是否保留: %s\n' "$(grep -q 'keep.me' "$INSTALL_DIR/.env" && echo '✓ 保留' || echo '✗ 被覆盖')"
printf '  data-marker 是否保留: %s\n' "$([ -f "$INSTALL_DIR/data-marker" ] && echo '✓ 保留' || echo '✗ 被删')"
printf '  是否拿到新代码（应有 src/etag.ts）: %s\n' "$([ -f "$INSTALL_DIR/src/etag.ts" ] && echo '✓' || echo '✗')"
printf '  新增文件数: %s\n' "$(find "$INSTALL_DIR" -type f | wc -l)"
rm -rf "$INSTALL_DIR"