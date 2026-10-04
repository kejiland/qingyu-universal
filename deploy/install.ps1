# ============================================================
# 轻语博客 · 自托管通用版 —— Windows 一键部署（Docker Desktop）
# ------------------------------------------------------------
# 用法（PowerShell）：
#   .\deploy\install.ps1 -Domain blog.example.com
# 要求：已安装并启动 Docker Desktop。
# ============================================================
[CmdletBinding()]
param(
  [string]$Domain = "",
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Image = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function New-Secret([int]$bytes = 32) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

Write-Step "检查 Docker"
try { docker version --format '{{.Server.Version}}' | Out-Null }
catch { throw "未检测到可用的 Docker。请先安装并启动 Docker Desktop。" }
docker compose version | Out-Null

$envFile = Join-Path $InstallDir '.env'
$setupKey = $null
if (Test-Path $envFile) {
  Write-Step ".env 已存在，保持不覆盖"
} else {
  Write-Step "生成 .env 与随机密钥"
  $setupKey = 'qy-' + (New-Secret 9)
  $siteUrl = if ($Domain) { "https://$Domain" } else { "http://localhost" }
  @"
# 由 deploy/install.ps1 生成
PORT=8787
HOST=127.0.0.1
SITE_URL=$siteUrl
SITE_DOMAIN=$Domain
DATA_DIR=./data
TRUST_PROXY=1

BLOG_ADMIN_SETUP_KEY=$setupKey
BLOG_WRITE_TOKEN=$(New-Secret)

S3_ENDPOINT=
S3_REGION=auto
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_MEDIA_BUCKET=
S3_MEDIA_PUBLIC_BASE=
S3_MUSIC_BUCKET=
S3_MUSIC_PUBLIC_BASE=
S3_BACKUP_BUCKET=

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=0
RESEND_API_KEY=
BLOG_MAIL_FROM=

AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
"@ | Set-Content -Path $envFile -Encoding utf8
}

if ($Image) { $env:QINGYU_IMAGE = $Image }

Push-Location $InstallDir
try {
  Write-Step "构建并启动容器（首次构建约 1-3 分钟）"
  if ($SkipBuild) { docker compose up -d } else { docker compose up -d --build }

  Write-Step "等待服务就绪"
  $healthy = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $res = Invoke-RestMethod -Uri 'http://localhost:8787/healthz' -TimeoutSec 3
      if ($res.ok) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { Write-Warn "健康检查超时，请运行：docker compose logs -f app" }

  $scheme = if ($Domain) { 'https' } else { 'http' }
  $host_ = if ($Domain) { $Domain } else { 'localhost' }
  $key = if ($setupKey) { $setupKey } elseif ((Get-Content $envFile | Select-String '^BLOG_ADMIN_SETUP_KEY=')) { ((Get-Content $envFile | Select-String '^BLOG_ADMIN_SETUP_KEY=').Line -split '=',2)[1] } else { '（见 .env）' }

  Write-Host ""
  Write-Host "  轻语博客 · 自托管通用版 部署完成" -ForegroundColor Green
  Write-Host ""
  Write-Host "    访问地址    $scheme://$host_"
  Write-Host "    管理后台    $scheme://$host_/admin"
  Write-Host "    初始化密钥  $key"
  Write-Host "    数据目录    $InstallDir\data"
  Write-Host ""
} finally {
  Pop-Location
}