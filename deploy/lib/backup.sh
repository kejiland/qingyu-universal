# ============================================================
# backup.sh —— 备份、定时备份、迁移打包与恢复
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
cmd_backup() {
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  compose exec -T app node dist/cli/backup.js /data/backups
}

# ----------------------------------------------------------
# 备份：快照 + 清理旧文件 + 定时备份（systemd timer）
# ----------------------------------------------------------

# 快照都在容器内 /data/backups（宿主机的 docker 数据卷里）
# 列出快照文件名（新 → 旧），只认 .db

list_backups() {
  compose exec -T app sh -c 'ls -1t /data/backups 2>/dev/null' 2>/dev/null | grep -E '\.db$' || true
}

# 只保留最近 $1 份快照（默认 7）。容器没跑时只提示、不报错。

prune_backups() {
  local keep="${1:-7}" n=0 f total
  case "$keep" in (''|*[!0-9]*) keep=7 ;; esac
  [ "$keep" -gt 0 ] || return 0
  total="$(list_backups | wc -l | tr -d ' ')"
  [ -n "$total" ] || return 0
  if [ "$total" -le "$keep" ]; then
    log "当前共 ${total} 份快照，未超过保留上限（${keep} 份），无需清理"
    return 0
  fi
  log "清理旧快照：保留最近 ${keep} 份，共 ${total} 份"
  while IFS= read -r f; do
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    if ${DOCKER:-docker} exec qingyu-app rm -f "/data/backups/$f"; then
      log "    已删除旧快照 $f"
    else
      warn "    删除失败（容器可能已停止）：$f"
      return 0
    fi
  done <<EOF
$(list_backups)
EOF
}

# 立刻备份一次 + 清理旧快照。autobackup 的 systemd 也调用 backup --keep。

backup_now() {
  cmd_backup
  prune_backups "${1:-$KEEP_N}"
}

# 数据卷名字（qingyu-data）。
# 优先问「正在跑的容器」——它的挂载信息最准；
# 容器没起来时再按名字找，并且只在唯一匹配时才敢用，
# 否则宁可报错让你手动确认，也绝不猜错卷把别人的数据删了。

data_volume_name() {
  local v matches
  v="$(${DOCKER:-docker} inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' qingyu-app 2>/dev/null | head -n1)"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi

  matches="$(${DOCKER:-docker} volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)qingyu-data$' || true)"
  case "$matches" in
    '') printf '' ;;
    *"
"*) return 1 ;;   # 多个候选：无法确定，交给调用方报错
    *) printf '%s' "$matches" ;;
  esac
}

# 定时备份：优先 systemd timer，没有 systemd 退回 cron，再没有就打印命令

cmd_autobackup() {
  need_root
  resolve_docker
  [ -f "$INSTALL_DIR/.env" ] || die "未找到 $INSTALL_DIR/.env —— 这个目录还没有部署过？"

  local timer_unit="qingyu-backup.timer" service_unit="qingyu-backup.service"
  local script_path="$INSTALL_DIR/deploy/install.sh"
  [ -f "$script_path" ] || die "找不到 $script_path（$INSTALL_DIR 是不是完整的安装目录？）"

  # ---- 关闭 ----
  if [ "$AUTOBACKUP_OFF" = "1" ]; then
    log "关闭定时备份…"
    if have systemctl; then
      systemctl disable --now "$timer_unit" >/dev/null 2>&1 || true
      rm -f "/etc/systemd/system/$timer_unit" "/etc/systemd/system/$service_unit"
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if have crontab; then
      crontab -l 2>/dev/null | grep -v 'qingyu-backup' | crontab - 2>/dev/null || true
    fi
    log "已关闭定时备份（手动备份仍然可用：$0 backup）"
    return 0
  fi

  # ---- 参数校验 ----
  case "$KEEP_N" in (''|*[!0-9]*) KEEP_N=7 ;; esac
  # 允许用户写 3:30 这种简写，补零后校验范围（只查格式的话 systemd 会报 bad unit file）
  if [[ "$AT_TIME" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then
    AT_TIME="$(printf '%02d:%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")"
  fi
  case "$AT_TIME" in
    [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;;
    *) die "时间要写成 00:00-23:59 之间的 HH:MM，例如 03:30（你写的是：$AT_TIME）" ;;
  esac

  chmod +x "$script_path" 2>/dev/null || true
  log "设置定时备份：每天 ${AT_TIME} 执行，保留最近 ${KEEP_N} 份"

  if have systemctl && [ -d /run/systemd/system ]; then
    cat > "/etc/systemd/system/$service_unit" <<EOF
[Unit]
Description=Qingyu blog data backup
# Docker 服务通常由 docker.service 提供，但用 Requires 会让没装 systemd 单元的环境直接失败
After=docker.service
# 只做顺序提示，不 Requires：Docker Desktop / 精简镜像没有 docker.service 也能跑

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $script_path backup --keep $KEEP_N
EOF
    cat > "/etc/systemd/system/$timer_unit" <<EOF
[Unit]
Description=Qingyu blog daily backup

[Timer]
OnCalendar=*-*-* ${AT_TIME}:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$timer_unit" >/dev/null
    log "已启用 systemd 定时器：systemctl list-timers | grep qingyu"
    echo
    echo "  下次执行时间："
    systemctl list-timers "$timer_unit" --no-pager 2>/dev/null | sed -n '1,3p' || true
  elif have crontab; then
    local hh="${AT_TIME%%:*}" mm="${AT_TIME##*:}"
    { crontab -l 2>/dev/null | grep -v 'qingyu-backup' || true
      echo "${mm} ${hh} * * * $script_path backup --keep $KEEP_N >/dev/null 2>&1 # qingyu-backup"
    } | crontab -
    log "这台机器没有 systemd，已改用 crontab：每天 ${AT_TIME}（crontab -l 可查看）"
  else
    warn "这台机器既没有 systemd 也没有 cron，无法自动定时。"
    warn "请在外部定时任务里调用：$script_path backup --keep $KEEP_N"
    return 0
  fi

  echo
  echo "  常用操作："
  echo "    systemctl list-timers | grep qingyu      # 看下次执行时间"
  echo "    systemctl start qingyu-backup.service   # 立刻跑一次"
  echo "    $0 autobackup --off                      # 关闭定时备份"
  echo "    $0 autobackup --at 05:00 --keep 14      # 改时间 / 改保留份数"
  echo "    $0 backup                                # 手动备份一次"
  echo
}

# ----------------------------------------------------------
# 迁移：把 .env + 整个数据卷打成一个 tar.gz，拷到新服务器一键恢复
# ----------------------------------------------------------

cmd_migrate() {
  need_root
  resolve_docker
  [ -f "$INSTALL_DIR/.env" ] || die "未找到 $INSTALL_DIR/.env —— 这个目录还没有部署过？"

  local ts vol vol_rc=0 img out staging size db_label
  ts="$(date +%Y%m%d-%H%M%S)"
  # data_volume_name：0 = 找到唯一一个（可能为空 = 一个都没有）；非 0 = 有多个候选，不能猜
  vol="$(data_volume_name)" || vol_rc=$?
  if [ "$vol_rc" -ne 0 ]; then
    die "系统里有多个 qingyu-data 卷，没敢乱猜该打包哪一个。请确认后手动执行： docker volume ls | grep qingyu-data"
  fi
  [ -n "$vol" ] || die "没找到数据卷 qingyu-data（容器没在运行？）。先 $0 start，或手动执行： docker volume ls | grep qingyu-data"
  # 打包要用带 tar 的镜像：优先用站点自己的镜像（本地已有，不用联网拉）
  img="$(env_value QINGYU_IMAGE)"; [ -n "$img" ] || img="qingyu-universal:local"
  $(${DOCKER:-docker} image inspect "$img" >/dev/null 2>&1) || img="node:22-alpine"

  out="${BUNDLE_OUT:-$HOME/qingyu-migrate-$ts.tar.gz}"
  staging="$(mktemp -d)"
  # 容器里的应用用户不是 root，临时目录得可写（收尾会 rm -rf）
  # 777 只在打包数据卷那几秒需要；打完立刻收回 700，避免同机其他用户读到 .env 里的密钥
  chmod 777 "$staging"
  if [ -n "$(env_value DATABASE_URL)" ]; then db_label="PostgreSQL（连接串已含在 .env 里，数据卷里是上传文件与快照）"; else db_label="SQLite（数据库文件在数据卷里）"; fi

  log "打包数据卷 ${vol}（上传的图片、SQLite 数据库、历史快照）…"
  ${DOCKER:-docker} run --rm \
    -v "$vol":/data:ro \
    -v "$staging":/out \
    --entrypoint sh "$img" -c 'cd /data && tar czf /out/data.tar.gz .' \
    || { rm -rf "$staging"; die "打包数据卷失败（容器里 tar 不可用？）"; }

  # 容器已经把包写完了，接下来这个目录里会出现 .env（管理员密钥 / 数据库密码）。
  # 趁还没写进去，先把权限收回 700。
  chmod 700 "$staging"

  log "写入站点配置 .env 与恢复脚本…"
  cp "$INSTALL_DIR/.env" "$staging/.env"
  mkdir -p "$staging/deploy"
  cp "$INSTALL_DIR/deploy/install.sh" "$staging/deploy/install.sh" 2>/dev/null || true

  cat > "$staging/restore-here.sh" <<'RESTORE_EOF'
#!/usr/bin/env bash
# ============================================================
#  在新服务器上恢复轻语博客（本文件由 install.sh migrate 生成）
#  用法：
#     bash restore-here.sh                # 打印步骤 + 把 .env 复制过去
#     bash restore-here.sh --data-only    # 把数据装回数据卷
# ============================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${QINGYU_ROOT:-/opt/qingyu-universal}"

if [ "${1:-}" = "--data-only" ]; then
  VOL=""
  for v in $(docker volume ls --format '{{.Name}}' | grep -E '(^|_)qingyu-data$' || true); do VOL="$v"; break; done
  [ -n "$VOL" ] || { echo "[x] 找不到数据卷 qingyu-data，请先执行 install" >&2; exit 1; }
  IMG="qingyu-universal:local"
  docker image inspect "$IMG" >/dev/null 2>&1 || IMG="node:22-alpine"
  echo "==> 数据卷 $VOL 正在从备份还原…"
  docker run --rm -v "$VOL":/data -v "$HERE":/in:ro --entrypoint sh "$IMG" -c 'cd /data && tar xzf /in/data.tar.gz'
  echo "==> 数据已还原。现在执行： docker compose -f $ROOT/compose.yaml up -d"
  echo "    然后用 $ROOT/.env 里 SITE_URL 那个地址访问新站点。"
  exit 0
fi

echo "==> 恢复目标目录：$ROOT"
mkdir -p "$ROOT/deploy"
cp "$HERE/.env" "$ROOT/.env"
[ -f "$HERE/deploy/install.sh" ] && cp "$HERE/deploy/install.sh" "$ROOT/deploy/install.sh"
chmod +x "$ROOT/deploy/install.sh" 2>/dev/null || true
echo "==> 已复制站点配置（.env）与部署脚本（域名 / 端口 / 密钥都保留原来的）"
echo
echo "  接下来两步："
echo "    1) bash $ROOT/deploy/install.sh install -y      # 装程序（会复用上面的 .env）"
echo "    2) bash $HERE/restore-here.sh --data-only      # 把文章、图片、评论装回去"
echo
RESTORE_EOF
  chmod +x "$staging/restore-here.sh"

  cat > "$staging/README.txt" <<EOF
轻语博客 迁移包
===============
生成时间：$(date -u +"%Y-%m-%d %H:%M:%S") UTC
来源站点：$(env_value SITE_URL)
数据库：  ${db_label}

怎么迁到新服务器
----------------
1. 把这个 tar.gz 传到新服务器（scp / VPS 面板上传都行）
2. 解压：  tar xzf $(basename "$out")
3. 装程序（复用包里的 .env，域名、端口、密钥都不会变）：
     bash qingyu-migrate-$ts/deploy/install.sh install -y
4. 装回数据：
     bash qingyu-migrate-$ts/restore-here.sh --data-only
5. 打开新服务器上的站点，确认文章和上传的图片都在。

提示
----
· 两台服务器不必同时在线：先在旧机器打包，再拷过去即可。
· 建议打包前先执行 stop，防止这期间有新数据写进来。
· .env 里有管理员密钥和数据库密码，打包文件请当作敏感文件保管（已设为 600 权限）。
EOF

  log "生成迁移包…"
  tar czf "$out" -C "$staging" .
  chmod 600 "$out"
  rm -rf "$staging"
  size="$(du -h "$out" 2>/dev/null | cut -f1)"

  echo
  echo "  ┌──────────────────────────────────────────────────────────┐"
  echo "  │  迁移包已生成                                              │"
  echo "  └──────────────────────────────────────────────────────────┘"
  echo
  echo "    文件    ${out}（${size:-未知大小}）"
  echo "    内容    .env 站点配置 + 整个数据卷（文章、评论、上传的图片）"
  echo
  echo "  传到新服务器后按包内 README.txt 三步恢复即可。"
  echo "  提醒：迁移期间旧站点最好先 stop（$0 stop），避免数据不一致。"
  echo
}

cmd_restore() {
  local file="${ARGS[0]:-}"
  [ -n "$file" ] || die "用法：install.sh restore <快照文件>"
  [ -f "$file" ] || die "找不到快照：$file"
  log "停止应用容器…"
  compose stop app
  ${DOCKER:-docker} cp "$file" qingyu-app:/data/restore-incoming.db
  # 恢复失败也要把应用重新拉起来：数据没被动过，总好过把站点一直停着
  if ! compose run --rm --no-deps app node dist/cli/restore.js /data/restore-incoming.db; then
    compose up -d app || true
    die "恢复失败（应用已重新启动，数据仍是恢复前的状态）。请看上面的报错，或换一个快照重试"
  fi
  compose up -d app
  log "恢复完成"
}
