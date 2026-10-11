# ============================================================
# menu.sh —— 交互菜单、终端快捷键、全局 qingyu 入口与卸载
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
shortcut_target() {
  # 优先用安装目录里的脚本；找不到就退回当前这个脚本自身
  local c="$INSTALL_DIR/deploy/install.sh"
  [ -f "$c" ] || c="$SCRIPT_PATH"
  # 转成绝对路径：alias 只在当前目录下的终端里生效，写全路径才随处可用
  case "$c" in /*) ;; *) c="$PWD/$c" ;; esac
  printf '%s' "$c"
}

shortcut_block() {
  local key="$1" target; target="$(shortcut_target)"
  printf '%s\n' "$SHORTCUT_MARK_BEGIN"
  # 大小写都给，省得用户纠结Shift
  printf 'alias %s='"'"'bash %s'"'"'\n' "$key" "$target"
  if [ "$key" != "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" ]; then
    printf 'alias %s='"'"'bash %s'"'"'\n' "$key" "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" "$target"
  else
    printf 'alias %s='"'"'bash %s'"'"'\n' "$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')" "$target"
  fi
  printf '%s\n' "$SHORTCUT_MARK_END"
}

# 从 rc 文件里删掉旧的快捷键块（先删后加，改键时不会留下两个）

shortcut_strip() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  grep -qF "$SHORTCUT_MARK_BEGIN" "$rc" 2>/dev/null || return 0
  local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/qy-rc.XXXXXX")"
  awk -v b="$SHORTCUT_MARK_BEGIN" -v e="$SHORTCUT_MARK_END" '
    $0 == b { skip = 1 } skip != 1 { print }
    $0 == e { skip = 0; print "" }
  ' "$rc" > "$tmp" 2>/dev/null && cat "$tmp" > "$rc"
  rm -f "$tmp" 2>/dev/null || true
}

shortcut_rcs() {
  local home="${HOME:-/root}" rc
  printf '%s\n' "$home/.bashrc"
  [ -f "$home/.zshrc" ] && printf '%s\n' "$home/.zshrc"
  # 精简系统可能没有 .bashrc（alpine），补一个
  [ -f "$home/.bashrc" ] || printf '%s\n' "$home/.profile"
  return 0
}

# 读出当前真正写进 rc 文件的快捷键，菜单要如实展示；
# 没装 / 被移除时返回空，不拿默认值冒充“已生效”。

shortcut_current_key() {
  local rc key
  while IFS= read -r rc; do
    [ -f "$rc" ] || continue
    key="$(awk -v b="$SHORTCUT_MARK_BEGIN" -v e="$SHORTCUT_MARK_END" '
      $0 == b { block = 1; next }
      $0 == e { block = 0 }
      block == 1 && /^alias [a-zA-Z0-9]=/ {
        key = $1
        sub(/^alias /, "", key)
        sub(/=.*/, "", key)
        print key
        exit
      }
    ' "$rc" 2>/dev/null)"
    [ -n "$key" ] && { printf '%s' "$key"; return 0; }
  done <<EOF
$(shortcut_rcs)
EOF
  return 0
}

cmd_shortcut() {
  # 用法： install.sh shortcut [字母] | shortcut --key 字母 | shortcut --remove
  local remove=0 key="" a
  set -- $SUBCMD_ARGS
  while [ $# -gt 0 ]; do
    case "$1" in
      --remove|-r|--no-shortcut) remove=1 ;;
      --key|-k)
        if [ $# -ge 2 ]; then key="$2"; shift; else die "--key 后面要写一个字母"; fi ;;
      -*) die "看不懂的参数：$1（用法： $0 shortcut [字母] / shortcut --remove）" ;;
      *) key="$1" ;;
    esac
    shift
  done
  if [ "$SHORTCUT_OFF" = "1" ]; then remove=1; fi
  if [ "$remove" = "0" ] && [ -n "$key" ]; then SHORTCUT_KEY="$key"; fi

  if [ "$remove" = "1" ]; then
    local rc n=0
    while IFS= read -r rc; do
      if [ -f "$rc" ]; then shortcut_strip "$rc"; n=$((n + 1)); fi
    done <<EOF
$(shortcut_rcs)
EOF
    log "已移除快捷键（清理了 $n 个配置文件）；当前终端里执行 hash -r 即可生效"
    global_link_remove 2>/dev/null && log "已移除全局命令：$(global_link_path 2>/dev/null || echo qingyu)"
    return 0
  fi

  # 只允许单个字母 / 数字，避免写出乱七八糟的 alias
  case "$SHORTCUT_KEY" in
    [a-zA-Z0-9]) ;;
    *) die "快捷键只能是单个字母或数字，当前是「${SHORTCUT_KEY}」" ;;
  esac

  local target rc n=0
  target="$(shortcut_target)"
  while IFS= read -r rc; do
    [ -n "$rc" ] || continue
    mkdir -p "$(dirname "$rc")" 2>/dev/null || true
    shortcut_strip "$rc"
    shortcut_block "$SHORTCUT_KEY" >> "$rc" 2>/dev/null || { warn "写入 ${rc} 失败（跳过）"; continue; }
    n=$((n + 1))
  done <<EOF
$(shortcut_rcs)
EOF

  if [ "$n" -eq 0 ]; then
    warn "没能写入任何配置文件，请手动执行这一行："
    echo "      alias ${SHORTCUT_KEY}='bash ${target}'"
    return 0
  fi
  ok "快捷键已设置：以后在终端里敲 ${SHORTCUT_KEY} 就能打开运维菜单"
  ui_hint "已写入 $n 个配置文件（当前终端立即可用： source ~/.bashrc）"
  if global_link_maybe && [ -n "$(global_link_path 2>/dev/null)" ]; then
    ok "全局命令已就绪：任何目录直接敲 qingyu 回车即可打开菜单"
    ui_hint "当前终端若不认这个命令，执行一次： hash -r"
  else
    ui_hint "全局命令没装上（需要 root 且 /usr/local/bin 可写），仍可用快捷键 ${SHORTCUT_KEY}"
  fi
  ui_hint "想换别的键： $target shortcut x    不想用了： $target shortcut --remove"
}

# 安装成功后顺手把快捷键装上（--no-shortcut 可跳过）

shortcut_maybe() {
  if [ "$SHORTCUT_OFF" = "1" ]; then return 0; fi
  if [ "$COMMAND_SET" = "0" ]; then return 0; fi
  [ "$(id -u)" = "0" ] || { ui_hint "快捷键需要 root 才能写~/.bashrc，跳过（可稍后手动执行）"; return 0; }
  cmd_shortcut >/dev/null 2>&1 || true
  return 0
}

cmd_uninstall() {
  warn "将停止并删除容器（数据卷 qingyu-data 会保留）"
  if [ "$PURGE" = "1" ]; then
    warn "--purge：会连同数据卷一起删除，文章和上传的图片都会消失！"
    if [ "$ASSUME_YES" != "1" ]; then
      if ! can_ask; then die "确认删除请加 -y：$0 uninstall --purge -y"; fi
      ask "确认彻底删除数据？（不可恢复）" "n"
      case "$REPLY" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
    fi
  fi
  compose down
  if [ "$PURGE" = "1" ]; then
    local vol vol_rc=0
    vol="$(data_volume_name)" || vol_rc=$?
    if [ "$vol_rc" -ne 0 ]; then
      warn "系统里有多个 qingyu-data 卷，没敢乱删。请确认后手动执行： docker volume ls | grep qingyu-data"
      return 0
    fi
    if [ -z "$vol" ]; then
      warn "没找到 qingyu-data 数据卷（可能已经删过了），跳过"
      return 0
    fi
    log "删除数据卷 ${vol}…"
    ${DOCKER:-docker} volume rm "$vol" 2>/dev/null || warn "数据卷删除失败，可手动执行： docker volume rm ${vol}"
  fi
  log "如需只删容器、保留数据，直接运行 $0 uninstall"
}

# 挑一个可写的 PATH 目录
global_link_dir() {
  local d
  for d in $GLOBAL_LINK_DIRS; do
    if [ -d "$d" ] && [ -w "$d" ]; then printf '%s' "$d"; return 0; fi
  done
  return 1
}

global_link_path() {
  local d
  d="$(global_link_dir)" || return 1
  printf '%s/qingyu' "$d"
}

# 入口脚本里带一行本项目的标记，删除时据此判断，避免误删同名文件

global_link_write() {
  local path tmp target
  path="$(global_link_path)" || return 1
  target="$(shortcut_target)"
  tmp="$(mktemp "${TMPDIR:-/tmp}/qy-link.XXXXXX")" || return 1
  {
    printf '#!/bin/sh\n'
    printf '# qingyu-universal 运维菜单入口（由 deploy/install.sh 自动生成，可直接删）\n'
    printf 'exec bash "%s" "$@"\n' "$target"
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  cat "$tmp" > "$path" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  rm -f "$tmp" 2>/dev/null
  chmod 0755 "$path" 2>/dev/null || true
  return 0
}

global_link_remove() {
  local d p removed=0
  for d in $GLOBAL_LINK_DIRS; do
    p="$d/qingyu"
    [ -f "$p" ] || continue
    grep -q 'qingyu-universal' "$p" 2>/dev/null || continue
    rm -f "$p" 2>/dev/null && removed=1
  done
  [ "$removed" = "1" ]
}

# 装入口（非 root 或目录不可写时安静跳过，绝不因此让安装失败）

global_link_maybe() {
  [ "$(id -u)" = "0" ] || return 0
  global_link_write 2>/dev/null || return 0
  return 0
}
# ----------------------------------------------------------
# 傻瓜式：已经部署过、又没写具体子命令时，弹一个数字菜单
# 只在「交互终端 + 没加 -y + 目录里已有 .env」时出现，
# 所以 CI、管道（curl|bash）、脚本互调都不会被它卡住。
# ----------------------------------------------------------

maybe_show_menu() {
  [ "${COMMAND_SET:-0}" = "0" ] || return 0
  [ -f "$INSTALL_DIR/.env" ] || return 0
  can_ask || return 0
  # 自愈：菜单每次打开都顺手确认一次全局 qingyu 命令在不在。
  # 这样「我不记得命令怎么敲」的人只要能打开菜单，敲 qingyu 就永远可用。
  [ "$(id -u)" = "0" ] && global_link_maybe
  local site shortcut_key
  site="$(env_value SITE_URL 2>/dev/null || true)"
  shortcut_key="$(shortcut_current_key)"
  {
    ui_banner "运维菜单" "直接输入数字即可，全程不用敲命令"
    [ -n "$site" ] && ui_kv "当前站点" "${C_B}${site}${C_RESET}"
    if [ -n "$shortcut_key" ]; then
      ui_kv "终端快捷键" "在终端敲 ${C_B}${shortcut_key}${C_RESET} 直接打开本菜单"
    else
      ui_kv "终端快捷键" "尚未设置（可选 15 设置）"
    fi
    echo
    ui_section "常用"
    ui_opt  1 "更新到最新版" "先查有没有新代码，有才备份 + 重建，数据保留"
    ui_opt  2 "只检查更新"   "看远端有没有新代码，不改动任何东西"
    ui_opt  3 "一键体检"     "Docker / 容器 / 端口 / 防火墙 / 公网逐项检查"
    ui_opt  4 "部署信息"     "访问地址、初始化密钥、版本、文章数"
    ui_opt  5 "运行状态"     "容器与健康检查"
    ui_opt 17 "服务器家底"   "CPU / 内存 / 磁盘 / 负载 / 网络（借鉴 kejilion 的系统信息查询）"
    ui_opt  6 "备份数据"     "数据库快照到 data/backups"
    ui_opt  7 "查看日志"     "实时输出应用日志（Ctrl+C 退出）"
    echo
    ui_section "服务与回退"
    ui_opt  8 "重启服务"     "改完 .env 之后用它生效"
    ui_opt  9 "停止服务"     "配置和数据都保留"
    ui_opt 10 "启动服务"     "把停过的服务再拉起来"
    ui_opt 11 "回滚到上一版" "更新出问题时退回"
    ui_opt 12 "定时备份"     "每天自动快照，只保留最近 ${KEEP_N} 份"
    ui_opt 13 "打包迁移"     "打成 tar.gz，方便搬到新服务器"
    ui_opt 14 "改域名"       "查看 / 切换域名，自动申请 HTTPS 证书"
    ui_opt 15 "卸载"         "删除容器（数据卷保留）"
    ui_opt 18 "电脑测速"     "回程延迟 + 上下行带宽，只出数字不改配置"
    ui_opt 19 "服务器调优"   "BBR + 队列 + 内存策略；不碰 SSH，可撤销"
    ui_opt 20 "清理磁盘"     "只删 Docker 悬空镜像 + 构建缓存，数据一律不动"
    echo
    ui_section "终端快捷键"
    if [ -n "$shortcut_key" ]; then
      ui_opt 16 "自定义快捷键" "当前 ${shortcut_key}；改成字母 / 数字，输入 - 移除"
    else
      ui_opt 16 "设置快捷键"   "单个字母 / 数字；输入 - 取消设置"
    fi
    echo
    ui_opt  0 "退出" ""
    ui_rule
    ui_hint "改端口 / 站点地址 → 编辑 ${INSTALL_DIR}/.env 后选 8 生效"
  } 2>/dev/null > /dev/tty || return 0
  ask "请输入数字" "0"
  case "$REPLY" in
    1)  COMMAND="update" ;;
    2)  COMMAND="check-update" ;;
    3)  COMMAND="doctor" ;;
    4)  COMMAND="info" ;;
    5)  COMMAND="status" ;;
    6)  COMMAND="backup" ;;
    7)  COMMAND="logs" ;;
    8)  COMMAND="restart" ;;
    9)  COMMAND="stop" ;;
    10) COMMAND="start" ;;
    11) COMMAND="rollback" ;;
    12) COMMAND="autobackup" ;;
    13) COMMAND="migrate" ;;
    14) COMMAND="domain" ;;
    15) COMMAND="uninstall" ;;
    17) COMMAND="sysinfo" ;;
    18) COMMAND="speedtest" ;;
    19) COMMAND="tune" ;;
    20) COMMAND="clean" ;;
    16)
      # 交互式改键：用户已在菜单里明确选择，忽略这次启动参数里的 --no-shortcut。
      SHORTCUT_OFF=0
      # 交互式改键：单个字母 / 数字直接覆盖；“-”表示移除。
      ask "输入新的快捷键（字母 / 数字，输入 - 移除）" "${shortcut_key:-$SHORTCUT_KEY}"
      case "$REPLY" in
        -) COMMAND="shortcut"; SUBCMD_ARGS="--remove" ;;
        [a-zA-Z0-9]) COMMAND="shortcut"; SUBCMD_ARGS="$REPLY" ;;
        *) warn "快捷键只能是单个字母或数字，当前是「${REPLY}」"; exit 1 ;;
      esac
      ;;
    0)  log "已退出（再次运行本脚本可重新打开菜单）"; exit 0 ;;
    *)  warn "没看懂这个选择（请输入 0-20），先退出"; exit 1 ;;
  esac
}
