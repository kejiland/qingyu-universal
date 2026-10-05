# ============================================================
# 轻语博客 · 让 WSL 中的站点可从局域网 / 公网访问
# ------------------------------------------------------------
# 用法（普通 PowerShell 即可，脚本会自行请求管理员权限）：
#   .\deploy\windows\expose-wsl.ps1 -Port 8080 -Distro Debian -TryUpnp
#
# 它做三件事：
#   1. Windows 端口转发：0.0.0.0:PORT -> 当前 WSL IP:PORT
#   2. Windows 防火墙放行 TCP PORT
#   3. 可选：尝试通过 UPnP 在路由器上添加端口映射
#
# 注意：WSL IP 会在重启后变化；需要重新运行本脚本（或在系统启动时运行）。
# ============================================================
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$Distro = 'Debian',
  [switch]$Remove,
  [switch]$TryUpnp
)

$ErrorActionPreference = 'Stop'
$RuleName = "Qingyu Blog WSL $Port"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]$identity
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'),
    '-Port', $Port,
    '-Distro', ('"' + $Distro + '"')
  )
  if ($Remove) { $arguments += '-Remove' }
  if ($TryUpnp) { $arguments += '-TryUpnp' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
  exit 0
}

function Remove-PortForward {
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

if ($Remove) {
  Remove-PortForward
  Write-Host "已移除端口 $Port 的 WSL 转发与防火墙规则。" -ForegroundColor Green
  exit 0
}

$wslIp = (((wsl.exe -d $Distro -- hostname -I) -join ' ').Trim() -split '\s+') | Select-Object -First 1
if (-not $wslIp) { throw "无法获取 WSL 发行版 $Distro 的 IP，请先启动 WSL。" }

$service = Get-Service -Name iphlpsvc -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Running') { Start-Service -Name iphlpsvc }

netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=$wslIp | Out-Null

Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null

$lanIp = (Get-NetIPConfiguration | Where-Object {
  $_.IPv4DefaultGateway -and $_.InterfaceAlias -notmatch 'WSL|vEthernet|Loopback|sb-tun'
} | Select-Object -First 1).IPv4Address.IPAddress
if (-not $lanIp) { $lanIp = '本机局域网IP' }

Write-Host "WSL 站点转发已设置：" -ForegroundColor Green
Write-Host "  WSL IP       $wslIp"
Write-Host ("  局域网地址   http://" + $lanIp + ":$Port")
Write-Host ("  端口转发     0.0.0.0:" + $Port + " -> " + $wslIp + ":" + $Port)
Write-Host "  防火墙规则   $RuleName"
Write-Host ""

if ($TryUpnp) {
  foreach ($name in @('SSDPSRV', 'upnphost', 'FDResPub')) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($service) {
      if ($service.StartType -eq 'Disabled') { Set-Service -Name $name -StartupType Automatic }
      if ($service.Status -ne 'Running') { Start-Service -Name $name -ErrorAction SilentlyContinue }
    }
  }
  try {
    $nat = New-Object -ComObject HNetCfg.NATUPnP
    $mappings = $nat.StaticPortMappingCollection
    if ($null -eq $mappings) { throw '路由器未启用 UPnP 或当前网络不支持。' }
    try { $mappings.Remove($Port, 'TCP') | Out-Null } catch {}
    $mappings.Add($Port, 'TCP', $Port, $lanIp, $true, 'Qingyu Blog') | Out-Null
    Write-Host "已尝试通过 UPnP 添加路由器端口映射。" -ForegroundColor Green
  } catch {
    Write-Host "UPnP 自动映射失败：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host ("  请登录路由器，把公网 TCP " + $Port + " 转发到 " + $lanIp + ":" + $Port + "。") -ForegroundColor Yellow
  }
}

try {
  $externalIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 10).Trim()
  if ($externalIp) { Write-Host ("  公网地址     http://" + $externalIp + ":$Port") }
  $body = @{ host = $externalIp; ports = @($Port) } | ConvertTo-Json -Compress
  $check = Invoke-RestMethod -Uri 'https://portchecker.io/api/query' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
  $open = [bool]($check.check | Where-Object { $_.port -eq $Port } | Select-Object -First 1).status
  if ($open) {
    Write-Host "  公网端口检测 已开放" -ForegroundColor Green
  } else {
    Write-Host "  公网端口检测 尚未开放（通常还需要路由器端口映射，或运营商封锁了端口）" -ForegroundColor Yellow
  }
} catch {
  Write-Host "  公网端口检测 暂时无法完成：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Read-Host '按回车关闭'
