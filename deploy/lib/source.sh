# ============================================================
# source.sh —— 代码获取：版本解析、克隆、下载与本地版本记忆
# 本文件由 deploy/install.sh 拆分而来，只放函数定义，不要直接执行。
# ============================================================
atom_revision() {
  local ref="${1:-$REF}" body="" sha=""
  [ -n "$ref" ] || return 0
  local u
  while IFS= read -r u; do
    body=$(curl -fsS --max-time 8 -H 'User-Agent: curl' "$u" 2>/dev/null) || body=""
    [ -n "$body" ] && break
  done < <(github_urls "$REPO/commits/$ref.atom")
  if [ -n "$body" ]; then
    sha=$(printf '%s' "$body" | grep -oE 'Grit::Commit/[0-9a-f]{40}' | sed -n '1s|.*/||p') || sha=""
  fi
  printf '%s' "$sha"
}

# 把「分支 / 标签 / commit」统一成可下载的完整 SHA。
# 纯十六进制（用户直接给了 commit）不联网；其余问一次 Atom feed。

ref_to_full() {
  local ref="${1:-}" body=""
  [ -n "$ref" ] || return 0
  case "$ref" in
    *[!0-9a-fA-F]*) body="$(atom_revision "$ref")" ;;
    *)
      if [ "${#ref}" -ge 40 ]; then
        printf '%s' "$ref"
        return 0
      fi
      # 短 SHA：本地有 git 就本地展开，否则原样带回（GitHub 也认短 SHA）
      if [ -d "$INSTALL_DIR/.git" ] && have git; then
        body="$(git -C "$INSTALL_DIR" rev-parse --verify -q "$ref^{commit}" 2>/dev/null || true)"
      elif [ -n "${SOURCE_ROOT:-}" ] && [ -d "$SOURCE_ROOT/.git" ] && have git; then
        body="$(git -C "$SOURCE_ROOT" rev-parse --verify -q "$ref^{commit}" 2>/dev/null || true)"
      fi
      [ -n "$body" ] || body="$ref"
      ;;
  esac
  printf '%s' "$body"
}

# 当前安装对应的完整 SHA（版本记录文件是压缩包安装的「版本账本」）

resolve_revision_full() {
  local sha=""
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    sha=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null) || sha=""
  fi
  if [ -z "$sha" ]; then
    sha="$(head -n1 "$(cur_ref_file)" 2>/dev/null || true)"
    sha="$(printf '%s' "$sha" | tr -d '[:space:]')"
  fi
  if [ -z "$sha" ] && [ -n "${SOURCE_ROOT:-}" ] && [ -d "$SOURCE_ROOT/.git" ] && have git; then
    sha=$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null) || sha=""
  fi
  if [ -z "$sha" ]; then
    sha="$(atom_revision "$REF")"
  fi
  printf '%s' "$sha"
}

# 取构建版本（commit 短 SHA），用于确认「升级到底生效没有」。

resolve_revision() {
  local full=""
  full="$(resolve_revision_full)"
  if [ -n "$full" ]; then
    printf '%.7s' "$full"
  fi
}
# Docker 命令前缀：非 root 且当前用户访问不了守护进程（不在 docker 组）时用 sudo

# 克隆到临时目录再整树覆盖 —— 安装目录里已有的 .env / data 不会被动到。
# 成功后安装目录就是 git 检出，之后 upgrade / rollback 都走本地历史，又快又稳。
clone_source() {
  have git || return 1
  local tmp
  tmp="$(mktemp -d)"
  log "用 Git 获取代码：$REPO@$REF"
  local git_url cloned=0
  while IFS= read -r git_url; do
    rm -rf "$tmp/src"
    if git clone --quiet "$git_url" "$tmp/src" 2>/dev/null; then cloned=1; break; fi
  done < <(git_clone_urls)
  if [ "$cloned" -ne 1 ]; then
    rm -rf "$tmp"
    return 1
  fi
  if ! git -C "$tmp/src" checkout --quiet "$REF" 2>/dev/null \
     && ! git -C "$tmp/src" checkout --quiet "origin/$REF" 2>/dev/null; then
    rm -rf "$tmp"
    # 用户明确指定了版本就必须精确命中；没指定就用克隆出来的默认分支
    [ "$REF_SET" = "1" ] && die "找不到版本：$REF（请确认分支 / 标签 / commit 是否存在）"
    return 1
  fi
  cp -a "$tmp/src"/. "$INSTALL_DIR/"
  rm -rf "$tmp"
  remember_cur_ref "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  log "代码已就绪（git 检出，支持 upgrade / rollback）"
  return 0
}

fetch_source() {
  prepare_install_dir
  # 情况一：从仓库内运行（本地已有完整代码）→ 直接同步过去
  if [ -n "${SOURCE_ROOT:-}" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ -f "$SOURCE_ROOT/deploy/Dockerfile" ]; then
    log "使用本地代码：$SOURCE_ROOT"
    if [ "$(cd "$SOURCE_ROOT" && pwd)" != "$(cd "$INSTALL_DIR" && pwd)" ]; then
      # 整树复制并排除本地产物。
      # 此前是手写文件清单，加入后台应用后清单没同步，漏掉 admin/ 与 generated/，
      # 会让 Dockerfile 构建后台时直接失败——清单式复制对新增目录太脆弱，改为整树。
      tar -C "$SOURCE_ROOT" -cf - \
        --exclude='./.git' \
        --exclude='./node_modules' \
        --exclude='./admin/node_modules' \
        --exclude='./admin/dist' \
        --exclude='./dist' \
        --exclude='./data' \
        --exclude='./.env' \
        . | tar -C "$INSTALL_DIR" -xf -
    fi
    remember_cur_ref "$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    return
  fi
  # 情况二：已经是 git 检出 → 不重复下载
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    # 例外：用户明确给了 --ref，就按指定版本切换
    if [ "$REF_SET" = "1" ]; then
      update_source
      return
    fi
    remember_cur_ref "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    log "代码已是 git 检出，跳过下载"
    return
  fi
  # 情况三：远程一键安装 → 优先克隆（带回完整历史），失败退回压缩包
  clone_source && return 0
  download_source
}

# 下载指定版本的代码包并覆盖到安装目录。
# 只覆盖代码，不动 .env 与 data —— 压缩包里本来就不含它们。
# 用法：download_source            → 下载 $REF（默认当前分支）
#       download_source <commit>   → 回滚时下载某个历史版本

download_source() {
  local target="${1:-$REF}" full="" exact=0
  log "下载代码：$REPO@$target"
  need_root
  ensure_curl
  full="$(ref_to_full "$target")"
  [ -n "$full" ] || full="$target"
  # 只有拿到精确 commit 才记账；只拿到分支名时宁可不记，
  # 也绝不写一条「回滚到最新版」的假记录
  case "$full" in
    *[!0-9a-fA-F]*) exact=0 ;;
    *) exact=1 ;;
  esac
  local tmp url1 url2 url3
  tmp="$(mktemp -d)"
  case "$full" in
    *[!0-9a-fA-F]*)
      # 分支 / 标签
      url1="$REPO/archive/refs/heads/$full.tar.gz"
      url2="$REPO/archive/refs/tags/$full.tar.gz"
      url3="$REPO/archive/$full.tar.gz"
      ;;
    *)
      # commit（回滚走这里）：GitHub 支持直接按 SHA 打包
      url1="$REPO/archive/$full.tar.gz"
      url2=""
      url3=""
      ;;
  esac
  # gh_fetch 先试加速地址（--mirror），失败自动回落官方直连
  if [ -n "$url2" ]; then
    gh_fetch "$url1" "$tmp/src.tgz" \
      || gh_fetch "$url2" "$tmp/src.tgz" \
      || gh_fetch "$url3" "$tmp/src.tgz" \
      || die "下载失败：https://github.com/$REPO（请确认仓库与分支/标签/版本；国内网络可加 --mirror 或 --github-proxy）"
  else
    gh_fetch "$url1" "$tmp/src.tgz" \
      || die "下载失败：https://github.com/$REPO/archive/$full（版本可能已被删除；国内网络可加 --mirror）"
  fi
  tar -xzf "$tmp/src.tgz" -C "$tmp"
  local extracted
  extracted="$(find "$tmp" -maxdepth 1 -type d -name '*qingyu*' | head -n1)"
  [ -n "$extracted" ] || extracted="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)"
  cp -a "$extracted"/. "$INSTALL_DIR/"
  rm -rf "$tmp"
  if [ "$exact" = "1" ]; then
    remember_cur_ref "$full"
    log "代码已更新到 $(printf '%.7s' "$full")"
  else
    warn "本次没能确认精确版本号，暂不生成回滚记录（下次升级会重新尝试）"
    log "代码已更新到 $full"
  fi
}

# ---------- 版本记录与回滚 ----------
# 版本账本：cur 记「现在是哪版」，prev 记「上一版是哪版」。
# 两个文件都放在安装目录里（已加入 .gitignore，不会污染 git status）。

prev_ref_file() { printf '%s/.qingyu-prev-ref' "$INSTALL_DIR"; }

cur_ref_file()  { printf '%s/.qingyu-cur-ref' "$INSTALL_DIR"; }

read_ref_file() {
  head -n1 "${1:-}" 2>/dev/null | tr -d '[:space:]' || true
}

# 两个版本号是否指向同一个 commit（兼容一长一短的 SHA 写法）

refs_equal() {
  local a b m
  a="$(printf '%s' "${1:-}" | tr 'A-F' 'a-f')"
  b="$(printf '%s' "${2:-}" | tr 'A-F' 'a-f')"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "$a" = "$b" ] && return 0
  m="${#a}"; [ "${#b}" -lt "$m" ] && m="${#b}"
  [ "$m" -ge 7 ] && [ "${a:0:$m}" = "${b:0:$m}" ]
}

# 记录「现在是哪个版本」——压缩包安装没有 git，靠这个小文件当版本账本

remember_cur_ref() {
  local sha="${1:-}"
  [ -n "$sha" ] || return 0
  printf '%s\n' "$sha" > "$(cur_ref_file)"
}

remember_prev_ref() {
  local sha="${1:-}"
  [ -n "$sha" ] || return 0
  printf '%s\n' "$sha" > "$(prev_ref_file)"
}

# upgrade 专用的取码逻辑：
#   安装目录是 git 仓库 → git pull
#   从本地 checkout 运行  → 复制本地代码
#   压缩包安装（默认）    → 下载最新代码包
# 此前 upgrade 只做「重建容器」，对压缩包安装等于原地重建旧版本，
# 用户执行了 upgrade 却拿不到新代码。

update_source() {
  if [ -d "$INSTALL_DIR/.git" ] && have git; then
    # 显式给了 --ref：切到那个版本（分支 / 标签 / commit 都行），并记下回滚点
    if [ "$REF_SET" = "1" ]; then
      log "切换到指定版本 $REF…"
      git -C "$INSTALL_DIR" fetch --quiet origin --tags || warn "拉取远端失败，改用本地已有的版本"
      local target=""
      target="$(git -C "$INSTALL_DIR" rev-parse --verify -q "$REF^{commit}" 2>/dev/null || true)"
      [ -n "$target" ] || target="$(git -C "$INSTALL_DIR" rev-parse --verify -q "origin/$REF^{commit}" 2>/dev/null || true)"
      [ -n "$target" ] || die "找不到版本：$REF（请确认分支 / 标签是否存在）"
      local cur
      cur="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
      if [ "$cur" != "$target" ]; then
        remember_prev_ref "$cur"
        git -C "$INSTALL_DIR" reset --hard "$target" >/dev/null
        remember_cur_ref "$target"
        log "已切换到 ${target:0:7}（可用 rollback 回到 ${cur:0:7}）"
      else
        log "当前已经是 $REF"
      fi
      return 0
    fi
    log "从 git 拉取最新代码…"
    local before after
    before="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull 失败，继续用现有代码重建"
    after="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    remember_cur_ref "$after"
    if [ "$before" != "$after" ]; then
      remember_prev_ref "$before"
      log "版本已更新 ${before:0:7} → ${after:0:7}（不满意可用 rollback 退回）"
    fi
    return 0
  fi
  # 本地 checkout 运行 → 复制本地代码，并记好回滚点
  if [ -n "${SOURCE_ROOT:-}" ] && [ -f "$SOURCE_ROOT/compose.yaml" ] && [ "$SOURCE_ROOT" != "$INSTALL_DIR" ]; then
    local before_local after_local
    before_local="$(read_ref_file "$(cur_ref_file)")"
    fetch_source
    after_local="$(read_ref_file "$(cur_ref_file)")"
    if [ -n "$before_local" ] && [ -n "$after_local" ] && ! refs_equal "$before_local" "$after_local"; then
      remember_prev_ref "$before_local"
      log "版本已更新（不满意可用 rollback 退回）"
    fi
    return 0
  fi

  # 压缩包安装：先记下「升级前」的版本，再取新代码
  local before after
  before="$(read_ref_file "$(cur_ref_file)")"
  # 装过 git 之后，升级顺手把它变成 git 检出（以后升级更快、可精确回滚）
  if [ ! -d "$INSTALL_DIR/.git" ] && have git && clone_source; then
    after="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  else
    download_source
    after="$(read_ref_file "$(cur_ref_file)")"
  fi
  if [ -n "$before" ] && [ -n "$after" ] && ! refs_equal "$before" "$after"; then
    remember_prev_ref "$before"
    log "版本已更新 ${before:0:7} → ${after:0:7}（不满意可用 rollback 退回）"
  elif [ -z "$before" ] && [ -n "$after" ]; then
    log "已记录当前版本 ${after:0:7}（从下一次升级起可用 rollback）"
  fi
}

# ---------- 数据库选择 ----------
# 归一化成三种形态：
#   sqlite   内置 SQLite 文件（默认，零依赖）
#   postgres 启动 compose 里的 PostgreSQL 容器
#   external 用户自己的云数据库，只填 DATABASE_URL
