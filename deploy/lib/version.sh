# ============================================================
# version.sh —— 版本检测：本地与远端比较、更新范围判定
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
remote_revision() {
  local ref="${1:-$REF}" sha="" u
  [ -n "$ref" ] || return 0
  if have git; then
    while IFS= read -r u; do
      sha="$(git ls-remote "$u" "refs/heads/$ref" 2>/dev/null | awk 'NR==1{print $1}')" || sha=""
      [ -n "$sha" ] && break
    done < <(git_clone_urls)
  fi
  [ -n "$sha" ] || sha="$(atom_revision "$ref")"
  printf '%s' "$sha"
}

# 比对本地与远端，把结论写进 UPDATE_STATE / UPDATE_CUR / UPDATE_REMOTE。
# UPDATE_STATE: latest（已是最新）| behind（有新版）| unknown（查不到，别乱动）

compare_revision() {
  UPDATE_CUR="$(resolve_revision_full)"
  UPDATE_REMOTE="$(remote_revision)"
  if [ -z "$UPDATE_REMOTE" ]; then
    UPDATE_STATE="unknown"
    return 1
  fi
  # 本地版本读不出来也算 unknown：这时若贸然「更新」，可能把正在跑的版本换成别的
  if [ -z "$UPDATE_CUR" ]; then
    UPDATE_STATE="unknown"
    return 1
  fi
  if refs_equal "$UPDATE_CUR" "$UPDATE_REMOTE"; then
    UPDATE_STATE="latest"
    return 1
  fi
  UPDATE_STATE="behind"
  return 0
}

# 列出「本地 → 远端」之间的提交，让人知道这次更新会带来什么。
# 必须先 fetch：远端的新 commit 对象本地根本没有，直接 rev-list 会失败
# （fetch 只更新远端引用，不动工作区与 HEAD，对「只检查」是安全的）。
# 压缩包安装没有本地 git 历史，只能报一句「无法列出」。

show_pending_commits() {
  local n
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    # 拿不到就算了，绝不因为列不出提交就中断检查。
    # 不写 remote 名：用默认的 origin，若安装目录是别处克隆来的（如 gitclone 镜像）
    # origin 不存在时这条会失败，但已被 || true 兜住，最多退化成「不显示明细」。
    git -C "$INSTALL_DIR" fetch --quiet --tags >/dev/null 2>&1 || true
    n="$(git -C "$INSTALL_DIR" rev-list --count "${UPDATE_CUR}..${UPDATE_REMOTE}" 2>/dev/null || true)"
    case "$n" in ''|*[!0-9]*) n="" ;; esac
    if [ -n "$n" ] && [ "$n" != "0" ]; then
      echo "    远端比本地多 ${n} 个提交："
      git -C "$INSTALL_DIR" log --oneline --no-decorate "${UPDATE_CUR}..${UPDATE_REMOTE}" 2>/dev/null \
        | head -n 10 | sed 's/^/      /' || true
      [ "$n" -gt 10 ] && echo "      …… 还有 $((n - 10)) 个"
      return 0
    fi
  fi
  echo "    （拿不到提交明细，不影响更新）"
}

# 本地 → 远端之间改过的文件清单。取不到就返回非 0，交给上层按「判断不了」处理。
pending_changed_files() {
  [ -d "$INSTALL_DIR/.git" ] || return 1
  have git || return 1
  # 远端新 commit 的对象本地没有，先 fetch（只更新远端引用，不动工作区与 HEAD）
  git -C "$INSTALL_DIR" fetch --quiet --tags >/dev/null 2>&1 || true
  git -C "$INSTALL_DIR" diff --name-only "${UPDATE_CUR}..${UPDATE_REMOTE}" 2>/dev/null
}

# 0=有相关改动  1=只有文档  2=判断不了

update_scope() {
  local files f relevant=0 any=0
  files="$(pending_changed_files)" || return 2
  [ -n "$files" ] || return 2
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    any=1
    # 命中「无关清单」就跳过；其余一律当成与站点相关（宁可多更新，不要漏更新）
    printf '%s\n' "$f" | grep -Eq "$UPDATE_DOCONLY_PATTERNS" && continue
    relevant=1
  done <<EOF
$files
EOF
  [ "$any" = "1" ] || return 2
  [ "$relevant" = "1" ] && return 0
  return 1
}

# 只列文件（比列 commit 直观：用户关心的是「改了什么」，不是「谁提交的」）

show_pending_files() {
  local files
  files="$(pending_changed_files)" || return 0
  [ -n "$files" ] || return 0
  echo "    改动文件："
  printf '%s\n' "$files" | head -n 20 | sed 's/^/      /'
}

# 判定为「与博客无关」时统一走这里：说清楚为什么跳过，以及怎么强制拉

skip_docs_only_update() {
  ui_hint "远端这批改动只涉及 README / 测试 / CI，不影响正在运行的站点 → 按你的要求跳过"
  show_pending_files
  ui_hint "确实想连文档一起拉下来（比如想让本地 README 跟上）：$0 update --all"
  return 0
}
# 只检查：不动任何东西。退出码 0 = 检查成功（有没有新版都算成功，方便定时任务只在
# 「查不到」时告警）；1 = 拿不到远端版本号。想「有新版就更新」直接跑 update，
# 它在没有新版时是零操作、零风险的。

cmd_check_update() {
  [ -d "$INSTALL_DIR" ] || die "未找到安装目录：$INSTALL_DIR
  提示：如果装在别处，用 --dir <目录> 指定。"
  resolve_mirror
  ensure_curl
  # 故意不装 git：检查是只读的，git 缺失时 remote_revision 会自动退回 Atom feed。
  # 而装 git 可能要动系统包管理器 —— 一个「只查一下」的命令不该有这种副作用。
  have git || warn "未检测到 git，改用 GitHub Atom feed 判断版本（结果同样准确）"

  log "正在检查 $REPO@$REF 是否有新代码…"
  if ! compare_revision; then
    if [ "$UPDATE_STATE" = "latest" ]; then
      log "当前已是最新版本（$(printf '%.7s' "$UPDATE_CUR")），无需更新"
      return 0
    fi
    warn "拿不到远端版本号，没法判断有没有新版"
    echo "  可能原因：网络不通 / 代理配错 / 仓库或分支名写错了"
    echo "  可以试试：$0 check-update --mirror --repo <owner/repo> --ref <分支>"
    return 1
  fi

  # 只改了文档 / 测试 / CI 的提交不必推给用户：对正在跑的站点没有任何影响
  local scope=0
  update_scope || scope=$?
  if [ "$scope" = "1" ] && [ "$UPDATE_ALL" != "1" ]; then
    echo
    log "远端有新提交，但都与博客运行无关"
    skip_docs_only_update
    return 0
  fi

  echo
  log "有新版！本地 $(printf '%.7s' "$UPDATE_CUR") → 远端 $(printf '%.7s' "$UPDATE_REMOTE")"
  show_pending_commits
  echo
  log "执行更新：$0 update"
  return 0
}

# 更新：先查，有新版才备份 + 拉代码 + 重建 + 等健康；没有就什么都不做。
# 与 upgrade 的区别是「没新版就不白重建一次」—— 升级是无条件的，这个是幂等的，
# 适合放进 cron 每天跑（没新版时零开销、零风险）。

show_version_diff() {
  local after
  after="$(resolve_revision)"
  if [ -z "${UPGRADE_FROM:-}" ] || [ -z "$after" ]; then
    [ -n "$after" ] && log "当前版本：$after"
    return 0
  fi
  if refs_equal "$UPGRADE_FROM" "$after"; then
    log "版本未变化：$after（已经是最新的代码）"
    return 0
  fi
  echo
  log "版本变化：${UPGRADE_FROM} → ${after}"
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    local n
    n="$(git -C "$INSTALL_DIR" rev-list --count "${UPGRADE_FROM}..HEAD" 2>/dev/null || true)"
    case "$n" in ''|*[!0-9]*) n="" ;; esac
    [ -n "$n" ] && echo "    新增 ${n} 个提交"
    git -C "$INSTALL_DIR" log --oneline --no-decorate "${UPGRADE_FROM}..HEAD" 2>/dev/null \
      | head -n 8 | sed 's/^/      /' || true
  fi
  echo
  return 0
}
