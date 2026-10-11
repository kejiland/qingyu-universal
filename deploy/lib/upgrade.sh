# ============================================================
# upgrade.sh —— 升级与回滚事务（含备份前置与健康检查）
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
cmd_update() {
  need_root
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR
  提示：如果装在别处，用 --dir <目录> 指定。"
  resolve_docker
  resolve_mirror
  ensure_curl
  have git || ensure_git

  log "正在检查 $REPO@$REF 是否有新代码…"
  if ! compare_revision; then
    if [ "$UPDATE_STATE" = "latest" ]; then
      log "当前已是最新版本（$(printf '%.7s' "$UPDATE_CUR")），无需更新"
      log "想强制重建容器（比如基础镜像更新了）：$0 upgrade"
      return 0
    fi
    die "拿不到远端版本号，为安全起见不做任何改动
  可以试试加 --mirror（国内网络加速），或用 --repo / --ref 确认仓库和分支是否正确"
  fi

  # --check：只报结果就走，和 cmd_check_update 同义
  if [ "$CHECK_ONLY" = "1" ]; then
    local cscope=0
    update_scope || cscope=$?
    if [ "$cscope" = "1" ] && [ "$UPDATE_ALL" != "1" ]; then
      log "远端有新提交，但都与博客运行无关"
      skip_docs_only_update
      return 0
    fi
    log "有新版！本地 $(printf '%.7s' "$UPDATE_CUR") → 远端 $(printf '%.7s' "$UPDATE_REMOTE")"
    show_pending_commits
    return 0
  fi

  # 没新版但明确要求 --check 时，上面已处理；走到这里一定是 behind
  # 与博客运行无关的提交（只动 README / tests / CI）直接跳过：
  # 不备份、不拉代码、不重建、不重启 —— 站点全程无感。
  local scope=0
  update_scope || scope=$?
  if [ "$scope" = "1" ] && [ "$UPDATE_ALL" != "1" ]; then
    echo
    log "远端有新提交，但都与博客运行无关 —— 跳过更新（站点不需要动）"
    skip_docs_only_update
    return 0
  fi

  echo
  log "版本变化：$(printf '%.7s' "$UPDATE_CUR") → $(printf '%.7s' "$UPDATE_REMOTE")"
  show_pending_commits

  if [ "$ASSUME_YES" != "1" ]; then
    if ! can_ask; then
      die "当前不是交互环境，确认无误后加 -y 执行：$0 update -y"
    fi
    ask "确认更新到最新版本？" "y"
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) log "已取消更新"; return 0 ;;
    esac
  fi

  STEP_TOTAL=4
  step_begin "备份当前数据"
  # 更新前先留个快照：代码可以回滚，数据库迁移过的表结构回滚不了
  backup_now || warn "备份失败，继续更新 —— 请自行确认数据安全"
  step_end

  step_begin "拉取最新代码"
  UPGRADE_FROM="$UPDATE_CUR"
  update_source
  # git pull 失败时 update_source 只警告不中断（upgrade 需要「拉不到就用现有代码重建」），
  # 但 update 没真拿到新代码就该在这儿停下 —— 否则白重启一次服务还谎报「更新完成」。
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    local cur_after
    cur_after="$(resolve_revision_full)"
    if [ -n "$cur_after" ] && ! refs_equal "$cur_after" "$UPDATE_REMOTE"; then
      die "新版本没拉下来（本地仍是 $(printf '%.7s' "$cur_after")，远端已是 $(printf '%.7s' "$UPDATE_REMOTE")）。
  常见原因：网络不通、本地分支和远端有冲突。可以先跑 $0 doctor，或用 $0 upgrade 强制按现有代码重建。"
    fi
  fi
  step_end

  step_begin "重建容器并等待服务就绪"
  # 注入构建版本（git 短 SHA），让 /healthz 能回答「更新到底生效没有」
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "重建容器…（版本 $BUILD_REVISION）"
  compose pull --ignore-pull-failures 2>/dev/null || true
  compose_build
  wait_healthy
  step_end

  step_begin "复查防火墙放行"
  ensure_firewall_open
  step_end

  STEP_TOTAL=0
  log "更新完成（版本 $BUILD_REVISION）"
  log "站点：$(env_value SITE_URL)"
  echo "  万一有问题，一条命令退回：$0 rollback"
}

# 升级前先把「从哪个版本升到哪个版本」说清楚，中间隔了多少个提交也一并列出

cmd_upgrade() {
  STEP_TOTAL=4
  need_root

  step_begin "检查系统环境与网络加速"
  resolve_docker
  resolve_mirror
  configure_registry_mirror
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"
  ensure_git
  # 记下升级前的版本，拉完代码后好对比
  UPGRADE_FROM="$(resolve_revision)"
  step_end

  apply_timezone

  step_begin "拉取最新代码并备份当前数据"
  update_source
  show_version_diff
  resolve_mode
  persist_mirror_env
  # 文档里承诺「upgrade --domain X 可以换域名」，但 resolve_mode 只决定本次进程的模式，
  # 不会写 .env —— 在这里显式落盘，避免升级完域名还是旧的。
  if [ -n "$DOMAIN" ] && [ -z "$APP_PORT" ] && [ "$DOMAIN" != "$(env_value SITE_DOMAIN)" ]; then
    log "把域名切换为 ${DOMAIN}（自动申请 HTTPS 证书）"
    domain_apply "$DOMAIN"
  fi
  apply_env_extras
  # 先备份，再升级
  backup_now || warn "升级前备份失败，继续升级"
  step_end

  step_begin "重建容器并等待服务就绪"
  # 注入构建版本（git 短 SHA），让 /healthz 能回答「升级到底生效没有」
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "重建容器…（版本 $BUILD_REVISION）"
  compose pull --ignore-pull-failures 2>/dev/null || true
  compose_build
  wait_healthy
  step_end

  step_begin "复查防火墙放行"
  ensure_firewall_open
  step_end

  STEP_TOTAL=0
  log "升级完成（版本 $BUILD_REVISION）"
}

# 状态输出用的两行勾叉（doctor 的 doc_* 会顺带累计体检计数，这里不要那套）

cmd_rollback() {
  need_root
  resolve_docker
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR"

  local prev cur
  prev="$(read_ref_file "$(prev_ref_file)")"
  [ -n "$prev" ] || die "还没有可回滚的版本记录。
  提示：这份安装升级过一次之后才会生成记录。
  如果你从未执行过 upgrade，先运行一次：$0 upgrade"

  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    cur="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  else
    cur="$(read_ref_file "$(cur_ref_file)")"
  fi
  if [ -n "$cur" ] && refs_equal "$cur" "$prev"; then
    die "当前已经是记录中的版本 $(printf '%.7s' "$prev")，无需回滚"
  fi
  [ -n "$cur" ] || warn "未记录当前版本号，回滚后将无法一键滚回（建议回滚前先 backup）"

  # 升级时数据库已经迁移过，回滚代码不会把表结构退回去，先留个快照
  backup_now || warn "备份失败，继续回滚 —— 请自行确认数据安全"

  warn "准备把代码回滚到 $(printf '%.7s' "$prev")${cur:+（当前 $(printf '%.7s' "$cur")）}。"
  warn "数据库表结构保持现状，不会自动回退；回滚后若报错，可用 restore 恢复快照。"
  if [ "$ASSUME_YES" != "1" ]; then
    if [ ! -r /dev/tty ]; then
      die "当前不是交互环境，确认无误后加 -y 执行：$0 rollback -y"
    fi
    ask "确认回滚？" "n"
    case "$REPLY" in
      y|Y|yes|YES) ;;
      *) die "已取消回滚" ;;
    esac
  fi

  # 先把「回滚前」的版本记下来，回滚完还能再滚回去
  [ -n "$cur" ] && remember_prev_ref "$cur"
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    git -C "$INSTALL_DIR" reset --hard "$prev" >/dev/null
    remember_cur_ref "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  else
    download_source "$prev"
  fi
  BUILD_REVISION="$(resolve_revision)"
  [ -n "$BUILD_REVISION" ] || BUILD_REVISION=unknown
  export BUILD_REVISION
  log "回滚到 ${BUILD_REVISION}，重建容器…"
  compose_build
  wait_healthy
  log "回滚完成（版本 $BUILD_REVISION）。再执行一次 rollback 可回到回滚前的版本。"
}
