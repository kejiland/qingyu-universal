# ============================================================
# 轻语博客 · 自托管通用版 —— Windows 一键部署（Docker Desktop）
# ------------------------------------------------------------
# 与 Linux 版 deploy/install.sh 能力对齐：同样的 .env 字段、同样的
# 端口/数据库选择、同样的日常运维子命令。
#
# 用法（PowerShell）：
#   .\deploy\install.ps1                       # 交互式安装
#   .\deploy\install.ps1 -Port 8080             # 无域名，IP+端口
#   .\deploy\install.ps1 -Domain blog.example.com
#   .\deploy\install.ps1 info                   # 随时查看访问地址、初始化密钥
#   .\deploy\install.ps1 upgrade                # 拉新版本并重建
# 要求：已安装并启动 Docker Desktop。
# ============================================================
param(
  # 子命令：install(默认) / upgrade / start / stop / restart / status /
  #         logs / info / backup / restore / doctor / uninstall / help
  [Parameter(Position = 0)]
  [string]$Command = "install",

  [string]$Domain = "",
  # 对外端口。0 = 未指定（有域名则走 80/443，无域名默认 8080）
  [int]$Port = 0,
  # 数据库：sqlite（默认） | postgres（注意：PowerShell 里 -Db 会和公共参数 -Debug 冲突，只能写 -Database）
  [string]$Database = "",
  # 无域名模式写入 SITE_URL 的地址，留空自动用本机局域网 IP
  [string]$Ip = "",
  [Alias('Dir')]
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Image = "",
  # restore 用的快照文件
  [string]$File = "",
  [switch]$SkipBuild,
  # 国内网络加速（npm 走 npmmirror）
  [switch]$Mirror,
  # 不提问，全部用默认值
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$CommandSet = $PSBoundParameters.ContainsKey('Command')

# ---------- 输出helper ----------
function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Die($msg)  { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }

function New-Secret([int]$bytes = 32) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}
function New-SecretShort([int]$bytes = 9) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

# 交互提问：-Yes 或非交互终端时直接用默认值
function Ask($question, $default = "1") {
  if ($Yes -or -not [Environment]::UserInteractive) { return $default }
  $hint = if ($default) { "[$default]" } else { "" }
  $reply = Read-Host "$question $hint"
  if ([string]::IsNullOrWhiteSpace($reply)) { return $default }
  return $reply.Trim()
}

$EnvFile = Join-Path $InstallDir '.env'

# ---------- .env 读写（install.sh 生成的配置以 .env 为准）----------
function Get-EnvValue([string]$key, [string]$fallback = "") {
  if (-not (Test-Path $EnvFile)) { return $fallback }
  $line = Get-Content $EnvFile -ErrorAction SilentlyContinue |
          Where-Object { $_ -like "$key=*" } | Select-Object -First 1
  if ($null -eq $line) { return $fallback }
  return ($line -split '=', 2)[1]
}

function Set-EnvValue([string]$key, [string]$value) {
  if (-not (Test-Path $EnvFile)) { return }
  $lines = [System.IO.File]::ReadAllLines($EnvFile)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -like "$key=*") { $lines[$i] = "$key=$value"; $found = $true; break }
  }
  if (-not $found) { $lines += "$key=$value" }
  [System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

# COMPOSE_PROFILES 是逗号分隔列表（"domain" / "postgres" / "domain,postgres"）
function Test-Profile([string]$needle, [string]$profiles) {
  if (-not $profiles) { return $false }
  return ("," + $profiles + ",").Contains("," + $needle + ",")
}

# 是否 HTTPS 模式（有 domain profile = 由 Caddy 反代 + 自动证书）
function Uses-Caddy { return (Test-Profile 'domain' (Get-EnvValue 'COMPOSE_PROFILES')) }

# 本机健康检查端口：从 APP_BIND（127.0.0.1:8787 / 0.0.0.0:8080）取端口部分
function Get-HealthPort {
  $bind = Get-EnvValue 'APP_BIND'
  if (-not $bind) { $bind = '127.0.0.1:8787' }
  return ($bind -split ':')[-1]
}

function Get-LocalIPv4 {
  try {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
           Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
           Select-Object -First 1).IPAddress
    if ($ip) { return $ip }
  } catch { }
  return '127.0.0.1'
}

# 端口是否已被占用
function Test-PortBusy([int]$p) {
  try { return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop) }
  catch { return $false }
}

function Pick-FreePort([int]$preferred = 8080) {
  for ($p = $preferred; $p -lt $preferred + 20; $p++) {
    if (-not (Test-PortBusy $p)) { return $p }
  }
  return $preferred
}

# ---------- Docker ----------
function Invoke-Compose([string[]]$ComposeArgs) {
  Push-Location $InstallDir
  try { & docker compose @ComposeArgs }
  finally { Pop-Location }
}

function Resolve-Docker {
  Write-Step "检查 Docker Desktop"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Die "未安装 Docker。请先安装并启动 Docker Desktop：https://www.docker.com/products/docker-desktop/"
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { Write-Die "Docker Desktop 没有运行。请启动 Docker Desktop 后重试。" }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Write-Die "缺少 docker compose 组件（Docker Desktop 版本过旧，请升级）。" }
}

function Wait-Healthy([int]$healthPort, [int]$timeoutSec = 180) {
  Write-Step "等待服务就绪（最多 $timeoutSec 秒）"
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-RestMethod -Uri "http://127.0.0.1:$healthPort/healthz" -TimeoutSec 3
      if ($res.ok) { Write-Ok "服务已就绪"; return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  Write-Warn "健康检查超时。查看日志： docker compose -f `"$InstallDir\compose.yaml`" logs -f app"
  return $false
}

# 数据库选择：函数内部要回写 $Database，需先在脚本级声明，否则报错
function Resolve-DbChoice {
  if ($Database) { return $Database.ToLower() }
  if ($Yes -or -not [Environment]::UserInteractive) { return 'sqlite' }
  Write-Host ""
  Write-Host "  选择数据库：" -ForegroundColor Cyan
  Write-Host "    1) SQLite     —— 单文件，最省心，个人博客首选"
  Write-Host "    2) PostgreSQL —— 脚本自动起内置数据库容器"
  $choice = if ((Ask "  选哪个？(1/2)" "1") -eq '2') { 'postgres' } else { 'sqlite' }
  return $choice
}

# ---------- Windows 防火墙自动放行 ----------
# 只「新增」放行规则，不改任何已有策略；没有管理员权限就退回打印命令。
function Ensure-Firewall([int]$Port) {
  if ($Port -le 0) { return }
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
              ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Warn "当前不是管理员，无法自动放行防火墙。请用「管理员 PowerShell」执行："
    Write-Host "      New-NetFirewallRule -DisplayName Qingyu -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow" -ForegroundColor DarkGray
    return
  }
  $ruleName = "Qingyu Blog ($Port)"
  $exists = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($exists) { Write-Step "防火墙已放行端口 $Port（规则 $ruleName 已存在）"; return }
  try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow | Out-Null
    Write-Ok "防火墙已放行端口 $Port"
  } catch {
    Write-Warn "自动放行失败，请手动执行："
    Write-Host "      New-NetFirewallRule -DisplayName Qingyu -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow" -ForegroundColor DarkGray
  }
}

# ---------- 首次部署：生成 .env ----------
function New-EnvFile {
  $setupKey  = 'qy-' + (New-SecretShort)
  $writeToken = New-Secret

  $dbKind = Resolve-DbChoice

  $databaseUrl = ''
  $postgresPassword = ''
  $profiles = @()
  if ($dbKind -eq 'postgres') {
    $postgresPassword = New-Secret
    $databaseUrl = "postgres://qingyu:$postgresPassword@postgres:5432/qingyu"
    $profiles += 'postgres'
  }

  # 部署模式：有域名 → Caddy 自动 HTTPS；否则 IP+端口纯 HTTP
  $trustProxy = '1'
  if ($Domain) {
    $siteUrl = "https://$Domain"
    $appBind = '127.0.0.1:8787'
    $profiles += 'domain'
  } else {
    if ($Port -le 0) {
      if ($Yes -or -not [Environment]::UserInteractive) {
        $Port = 8080
      } else {
        $suggest = if (Test-PortBusy 8080) { Pick-FreePort 8080 } else { 8080 }
        Write-Host ""
        Write-Host "  没有域名，需要一个对外端口（80/443 常被占用，默认用 $suggest）：" -ForegroundColor Cyan
        $reply = Ask "  端口号（直接回车用 $suggest）" "$suggest"
        $parsed = 0
        if ([int]::TryParse($reply, [ref]$parsed) -and $parsed -gt 0) { $Port = $parsed } else { $Port = $suggest }
      }
    }
    $host_ = if ($Ip) { $Ip } else { Get-LocalIPv4 }
    $siteUrl = "http://${host_}:$Port"
    $appBind = "0.0.0.0:$Port"
    # 没有反向代理就不能信任 X-Forwarded-For，否则限流标识可被伪造
    $trustProxy = '0'
  }

  Write-Step "生成 .env 与随机密钥"
  $lines = @(
    "# 由 deploy/install.ps1 于 $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) 生成",
    "PORT=8787",
    "HOST=0.0.0.0",
    "SITE_URL=$siteUrl",
    "SITE_DOMAIN=$Domain",
    "DATA_DIR=./data",
    "# 数据库：留空使用 SQLite 文件；填写连接串则切换到 PostgreSQL",
    "DATABASE_URL=$databaseUrl",
    "POSTGRES_DB=qingyu",
    "POSTGRES_USER=qingyu",
    "POSTGRES_PASSWORD=$postgresPassword",
    "# 可选：Redis / Valkey 限流与去重；留空使用数据库 KV",
    "REDIS_URL=",
    "APP_BIND=$appBind",
    "COMPOSE_PROFILES=$($profiles -join ',')",
    "TRUST_PROXY=$trustProxy",
    "",
    "# 首次打开 /admin 时需要填写的安装密钥",
    "BLOG_ADMIN_SETUP_KEY=$setupKey",
    "# 脚本 / CI 长期写入令牌",
    "BLOG_WRITE_TOKEN=$writeToken",
    "",
    "# 对象存储（留空 = 本地磁盘）",
    "S3_ENDPOINT=",
    "S3_REGION=auto",
    "S3_ACCESS_KEY_ID=",
    "S3_SECRET_ACCESS_KEY=",
    "S3_MEDIA_BUCKET=",
    "S3_MEDIA_PUBLIC_BASE=",
    "S3_MUSIC_BUCKET=",
    "S3_MUSIC_PUBLIC_BASE=",
    "S3_BACKUP_BUCKET=",
    "",
    "# 邮件（留空 = 关闭订阅通知）",
    "SMTP_HOST=",
    "SMTP_PORT=587",
    "SMTP_USER=",
    "SMTP_PASS=",
    "SMTP_SECURE=0",
    "RESEND_API_KEY=",
    "BLOG_MAIL_FROM=",
    "",
    "# AI（留空 = 关闭）",
    "AI_BASE_URL=",
    "AI_API_KEY=",
    "AI_MODEL=",
    "# 国内网络加速（1 = 启用）",
    "QINGYU_MIRROR=$($(if ($Mirror) { 1 } else { 0 }))",
    "# 构建镜像时 npm 使用的源，留空 = 官方源",
    "NPM_REGISTRY=$($(if ($Mirror) { 'https://registry.npmmirror.com' } else { '' }))",
    ""
  )
  [System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
  return $setupKey
}

function Ensure-Env {
  if (Test-Path $EnvFile) {
    Write-Step ".env 已存在，保持不覆盖（如需重配请手动编辑）"
    return $null
  }
  if (-not (Test-Path (Join-Path $InstallDir 'compose.yaml'))) {
    Write-Die "找不到 $InstallDir\compose.yaml —— 请在项目目录里运行本脚本，或用 -Dir 指定目录。"
  }
  return (New-EnvFile)
}

# ---------- 日常输出 ----------
function Show-Summary([string]$setupKey) {
  $siteUrl = Get-EnvValue 'SITE_URL'
  $dbUrl   = Get-EnvValue 'DATABASE_URL'
  $key     = if ($setupKey) { $setupKey } else { Get-EnvValue 'BLOG_ADMIN_SETUP_KEY' }
  Write-Host ""
  Write-Host "  轻语博客 · 自托管通用版 部署完成" -ForegroundColor Green
  Write-Host "  --------------------------------------------------------"
  Write-Host "    访问地址    $siteUrl"
  Write-Host "    管理后台    $siteUrl/admin"
  Write-Host "    初始化密钥  $key"
  if ($dbUrl) {
    Write-Host "    数据库      PostgreSQL（内置容器）"
  } else {
    Write-Host "    数据库      SQLite（$InstallDir\data\qingyu.db）"
  }
  Write-Host "    安装目录    $InstallDir"
  Write-Host ""
  Write-Host "  常用操作："
  Write-Host "    .\deploy\install.ps1 info      # 查看访问地址、初始化密钥、版本"
  Write-Host "    .\deploy\install.ps1 upgrade   # 拉新版本并重建"
  Write-Host "    .\deploy\install.ps1 backup    # 生成数据库快照"
  Write-Host ""
  if (Uses-Caddy) {
    Write-Host "  已启用自动 HTTPS，证书首次签发通常需要十几秒，可用 logs 查看。"
  } else {
    Write-Host "  当前为纯 HTTP 模式（无证书）。管理后台密码是明文传输的："
    Write-Host "    建议改用域名自动 HTTPS，或用现有 Web 服务器反代（见 README）。"
  }
  Write-Host ""
}

function Show-Info {
  if (-not (Test-Path $EnvFile)) { Write-Die "未找到 $EnvFile —— 这个目录还没有部署过？" }
  $siteUrl  = Get-EnvValue 'SITE_URL'
  $appBind  = Get-EnvValue 'APP_BIND'
  $profiles = Get-EnvValue 'COMPOSE_PROFILES'
  $dbUrl    = Get-EnvValue 'DATABASE_URL'
  $setupKey = Get-EnvValue 'BLOG_ADMIN_SETUP_KEY'
  $token    = Get-EnvValue 'BLOG_WRITE_TOKEN'
  $revision = Get-EnvValue 'QINGYU_MIRROR'

  Write-Host ""
  Write-Host "  轻语博客 · 部署信息"
  Write-Host "  --------------------------------------------------------"
  Write-Host "    访问地址      $siteUrl"
  Write-Host "    管理后台      $siteUrl/admin"
  if ($setupKey) {
    Write-Host "    初始化密钥    $setupKey"
    Write-Host "                  （首次打开后台设置管理员密码时需要；重置密码也需要）"
  } else {
    Write-Host "    初始化密钥    （未设置——首次初始化无保护，建议补上）"
  }
  if ($token) { Write-Host "    写入令牌      $($token.Substring(0, 8))…（完整值见 .env）" }
  Write-Host ""
  Write-Host "  部署方式"
  Write-Host "  --------------------------------------------------------"
  if (Uses-Caddy) {
    Write-Host "    模式          域名 + 自动 HTTPS"
    Write-Host "    域名          $(Get-EnvValue 'SITE_DOMAIN')"
    Write-Host "    对外端口      80 / 443（由 Caddy 占用）"
  } else {
    Write-Host "    模式          纯 HTTP（无证书）"
    Write-Host "    端口          $(($appBind -split ':')[-1])"
  }
  if ($dbUrl) {
    $dbHost = ($dbUrl -replace '^[^:]+://[^@]*@([^/:]+).*$', '$1')
    Write-Host "    数据库        PostgreSQL $dbHost"
  } else {
    Write-Host "    数据库        SQLite"
  }
  if ($revision -eq '1') { Write-Host "    国内加速      已启用" }

  # 运行状态：容器在跑就问 /healthz
  $hp = Get-HealthPort
  $health = $null
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$hp/healthz" -TimeoutSec 3 } catch { }
  Write-Host ""
  Write-Host "  运行状态"
  Write-Host "  --------------------------------------------------------"
  if ($null -eq $health) {
    Write-Host "    [!] 服务未响应（容器可能没在运行）——执行 .\deploy\install.ps1 status 查看"
  } else {
    Write-Host "    版本          $($health.revision)"
    Write-Host "    已运行        $([TimeSpan]::FromSeconds([int]$health.uptimeSeconds).ToString())"
    if ($health.posts -ne $null) { Write-Host "    文章数        $($health.posts)" }
    Write-Host "    数据库        $($health.database)"
  }
  Write-Host ""
}

function Show-Doctor {
  if (-not (Test-Path $EnvFile)) { Write-Die "未找到 $EnvFile —— 这个目录还没有部署过？" }
  # 计数器用哈希表共享：嵌套 function 有自己的作用域，普通变量会写丢
  $tally = @{ ok = 0; warn = 0; fail = 0 }
  function Doc-Ok($m)   { $tally.ok++;   Write-Host "    [OK] $m" -ForegroundColor Green }
  function Doc-Warn($m) { $tally.warn++; Write-Host "    [!]  $m" -ForegroundColor Yellow }
  function Doc-Fail($m) { $tally.fail++; Write-Host "    [X]  $m" -ForegroundColor Red }

  Write-Host ""
  Write-Host "  轻语博客 · 一键体检"
  Write-Host "  --------------------------------------------------------"

  try { & docker info *> $null; if ($LASTEXITCODE -eq 0) { Doc-Ok "Docker Desktop 运行中" } else { Doc-Fail "Docker Desktop 没运行，请启动它" } }
  catch { Doc-Fail "未安装 Docker Desktop" }

  $appState = (& docker inspect -f '{{.State.Status}}' qingyu-app 2>$null)
  if ($LASTEXITCODE -eq 0 -and $appState) {
    if ($appState -eq 'running') { Doc-Ok "容器 qingyu-app 正在运行（$appState）" }
    else { Doc-Warn "容器 qingyu-app 已停止 —— .\deploy\install.ps1 start" }
  } else {
    Doc-Warn "找不到容器 qingyu-app —— 首次部署请执行 .\deploy\install.ps1"
  }

  $hp = Get-HealthPort
  $health = $null
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$hp/healthz" -TimeoutSec 3 } catch { }
  if ($health) { Doc-Ok "健康检查通过 http://127.0.0.1:$hp/healthz" }
  else { Doc-Fail "127.0.0.1:$hp 无响应 —— 查看日志：.\deploy\install.ps1 logs" }

  $bind = Get-EnvValue 'APP_BIND'
  if ($bind -like '0.0.0.0:*') { Doc-Ok "对外监听 $bind（局域网/公网可访问）" }
  elseif ($bind) { Doc-Warn "只绑在 $bind，外网访问不到 —— 改成 0.0.0.0:<端口> 再 restart" }
  else { Doc-Warn "APP_BIND 未设置" }

  if (Uses-Caddy) {
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue) {
      Doc-Ok "HTTPS 端口 443 在监听"
    } else {
      Doc-Fail "443 没监听 —— 证书可能签发失败，用 .\deploy\install.ps1 logs 查看 Caddy 日志"
    }
  } else {
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port $hp -InformationLevel Quiet -WarningAction SilentlyContinue) {
      Doc-Ok "端口 $hp 在监听"
    } else {
      Doc-Fail "端口 $hp 没在监听"
    }
    Write-Host "    提示：Windows 防火墙若拦截，管理员 PowerShell 执行：" -ForegroundColor DarkGray
    Write-Host "      New-NetFirewallRule -DisplayName Qingyu -Direction Inbound -LocalPort $hp -Protocol TCP -Action Allow" -ForegroundColor DarkGray
  }

  if (Get-EnvValue 'DATABASE_URL') { Doc-Ok "数据库：PostgreSQL" } else { Doc-Ok "数据库：SQLite（$InstallDir\data）" }

  Write-Host ""
  Write-Host "    [OK] $($tally.ok)    [!] $($tally.warn)    [X] $($tally.fail)"
  Write-Host ""
  if ($tally.fail -gt 0) { exit 1 }
}

function Show-Status {
  Write-Host ""
  & docker ps --filter 'name=qingyu-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  Write-Host ""
  $hp = Get-HealthPort
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$hp/healthz" -TimeoutSec 3
    Write-Ok "运行中：版本 $($health.revision) · 数据库 $($health.database)"
  } catch {
    Write-Warn "服务未响应 —— .\deploy\install.ps1 logs 看日志"
  }
  Write-Host ""
}

# ---------- 子命令 ----------
function Cmd-Install {
  Resolve-Docker
  if ($Image) { Set-EnvValue 'QINGYU_IMAGE' $Image }
  $setupKey = Ensure-Env
  if ($Mirror) {
    Set-EnvValue 'QINGYU_MIRROR' '1'
    Set-EnvValue 'NPM_REGISTRY' 'https://registry.npmmirror.com'
    Write-Step "已启用国内加速（npm 走 npmmirror）"
  }
  Write-Step "构建并启动容器（首次构建约 1-3 分钟）"
  if ($SkipBuild) { Invoke-Compose @('up','-d') } else { Invoke-Compose @('up','-d','--build') }
  Wait-Healthy (Get-HealthPort) | Out-Null
  if (-not (Uses-Caddy)) { Ensure-Firewall (Get-HealthPort) }
  Show-Summary $setupKey
}

function Cmd-Upgrade {
  Resolve-Docker
  if (-not (Test-Path $EnvFile)) { Write-Die "未找到 $EnvFile —— 这个目录还没有部署过？" }
  Cmd-Backup
  $rev = (& git -C $InstallDir rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $rev) { $rev = 'local' }
  Write-Step "重建容器（版本 $rev）"
  Invoke-Compose @('pull','--ignore-pull-failures')
  Invoke-Compose @('up','-d','--build')
  Wait-Healthy (Get-HealthPort) | Out-Null
  Write-Ok "升级完成"
  Show-Info
}

function Cmd-Backup {
  Resolve-Docker
  Write-Step "生成数据库快照到 data\backups"
  Invoke-Compose @('exec','-T','app','node','dist/cli/backup.js','/data/backups')
}

function Cmd-Restore {
  Resolve-Docker
  if (-not $File) { Write-Die "用法：.\deploy\install.ps1 restore <快照文件>" }
  if (-not (Test-Path $File)) { Write-Die "找不到快照：$File" }
  Write-Step "停止应用容器…"
  Invoke-Compose @('stop','app')
  & docker cp $File qingyu-app:/data/restore-incoming.db
  Invoke-Compose @('run','--rm','--no-deps','app','node','dist/cli/restore.js','/data/restore-incoming.db')
  Invoke-Compose @('up','-d','app')
  Wait-Healthy (Get-HealthPort) | Out-Null
  Write-Ok "恢复完成"
}

function Show-Usage {
  Write-Host @"
轻语博客 · 自托管通用版 一键部署（Windows / Docker Desktop）

  install                 安装并启动（默认）
  upgrade                 拉取新版本并重建（保留数据，自动先备份）
  start / stop / restart  启动 / 停止 / 重启
  status                  查看容器与健康状态
  logs                    查看应用日志
  info                    查看部署信息（访问地址、初始化密钥、版本…）
  doctor                  一键体检
  backup                  生成数据库快照
  restore <快照文件>       从快照恢复
  uninstall               停止并删除容器（数据卷保留）

选项：
  -Domain <域名>          对外域名，启用 Caddy + Let's Encrypt 自动 HTTPS
  -Port   <端口>          无域名时对外端口（默认 8080）
  -Ip     <地址>          无域名模式写入 SITE_URL 的地址（默认本机局域网 IP）
  -Database <数据库>     sqlite（默认） | postgres
  -Dir    <目录>          安装目录，默认脚本所在项目根目录
  -Image  <镜像>          使用预构建镜像而不是本地构建
  -SkipBuild              不重新构建，只启动已有镜像
  -Mirror                 国内网络加速（npm 走 npmmirror）
  -Yes                    不提问，全部使用默认值
"@
}

switch ($Command.ToLower()) {
  'install'   { Cmd-Install }
  'upgrade'   { Cmd-Upgrade }
  'start'     { Resolve-Docker; Write-Step "启动服务…"; Invoke-Compose @('up','-d');         Wait-Healthy (Get-HealthPort) | Out-Null }
  'stop'      { Resolve-Docker; Write-Step "停止服务（配置与数据全部保留）…"; Invoke-Compose @('stop') }
  'restart'   { Resolve-Docker; Write-Step "重启应用…"; Invoke-Compose @('restart','app'); Wait-Healthy (Get-HealthPort) | Out-Null }
  'status'    { Resolve-Docker; Show-Status }
  'logs'      { Resolve-Docker; Invoke-Compose @('logs','-f','app') }
  'info'      { Resolve-Docker; Show-Info }
  'doctor'    { Resolve-Docker; Show-Doctor }
  'backup'    { Cmd-Backup }
  'restore'   { Cmd-Restore }
  'uninstall' {
    Resolve-Docker
    Write-Step "停止并删除容器（数据卷保留，如需彻底删除请手动删除 data 与 volumes）…"
    Invoke-Compose @('down')
  }
  'help'      { Show-Usage }
  default     { Write-Die "未知子命令：$Command（可用：install / upgrade / start / stop / restart / status / logs / info / doctor / backup / restore / uninstall / help）" }
}