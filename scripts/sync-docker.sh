#!/usr/bin/env bash
# ============================================================
# 把本机最新代码推进展览容器并重启
# ------------------------------------------------------------
# 用法：
#   bash scripts/sync-docker.sh                  # 默认容器 qingyu-linux
#   bash scripts/sync-docker.sh qingyu-linux     # 指定容器
#
# 为什么不用「重建镜像」：这台机器上 `docker build` 拉 registry 经常 EOF 失败
# （代理也救不了）。直接 cp 产物进去 + restart 是更稳的路径，几秒就完成。
#
# 为什么不能写成 .mjs：本机 Node spawn 外部进程恒 EBUSY（git / docker 都一样），
# 脚本化必须由 shell 发起。
# ============================================================
set -euo pipefail

CONTAINER="${1:-qingyu-linux}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "✗ 容器不存在：$CONTAINER"
  echo "  先看有哪些：docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.CreatedAt}}'"
  exit 1
fi

echo "== 同步到容器 $CONTAINER =="

# 产物：后端 dist、上游前端 app、后台 admin/dist、契约产物 generated
docker cp ./dist/.        "$CONTAINER":/app/dist/
docker cp ./app/.         "$CONTAINER":/app/app/
docker cp ./admin/dist/.  "$CONTAINER":/app/admin/dist/
docker cp ./generated/.   "$CONTAINER":/app/generated/

# 容器以 uid=1000(node) 跑，docker cp 进来的文件属主不对。
# chown 报 Operation not permitted 是正常的（不影响读取），不要因此失败。
docker exec "$CONTAINER" sh -c 'chown -R node:node /app/dist /app/app /app/admin /app/generated 2>/dev/null || true'

echo "-- 重启 --"
docker restart "$CONTAINER" >/dev/null

# 宿主机端口：容器里固定 8787，宿主机映射port 从 docker port 取
HOST_PORT="$(docker port "$CONTAINER" 8787/tcp 2>/dev/null | head -1 | sed -E 's/.*://')"
HOST_PORT="${HOST_PORT:-8788}"
URL="http://127.0.0.1:${HOST_PORT}/api/health"

# 临时文件必须写在工作目录内：Git Bash 的 /tmp 与 Windows 版 Node 看到的不是同一个
# 位置（Node 会解析成 C:\tmp），跨进程读就会 ENOENT。
TMP_JSON=".workbuddy/health.json"
mkdir -p .workbuddy

echo "-- 等待就绪 $URL --"
for i in $(seq 1 40); do
  CODE="$(curl -s --noproxy '*' -o "$TMP_JSON" -w '%{http_code}' "$URL" || echo 000)"
  if [ "$CODE" = "200" ]; then
    break
  fi
  sleep 1
done

if [ "$CODE" != "200" ]; then
  echo "✗ 健康检查未通过（HTTP $CODE）"
  docker logs --tail 30 "$CONTAINER"
  exit 1
fi

node -e '
const j = JSON.parse(require("fs").readFileSync(".workbuddy/health.json", "utf8"));
const m = j.migrations || {};
console.log("✓ 已就绪");
console.log("  版本      " + j.version + "  (" + j.database + ")");
console.log("  文章数    " + j.posts);
console.log("  迁移      新增 " + (m.applied ?? 0) + " / 跳过 " + (m.skipped ?? 0));
console.log("  运行      " + j.uptime + "s");
console.log("  展示地址  http://localhost:'"$HOST_PORT"'");
'
