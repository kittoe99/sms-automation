# OpenCode Remote Web Server - Tailscale / LAN
# Project: sms-automation-main
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-opencode-remote.ps1
#   or double-click start-opencode-remote.cmd
#
# This starts: opencode web --port 4096 --hostname 0.0.0.0
# with required basic-auth password (OPENCODE_SERVER_PASSWORD).
# For Tailscale: connect via http://<tailscale-ip>:4096
# For LAN: connect via http://<lan-ip>:4096

param(
  [int]$Port = 4096,
  [string]$Hostname = "0.0.0.0"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $ProjectRoot

$OpenCodeCmd = Join-Path $env:APPDATA "npm\opencode.cmd"
if (-not (Test-Path $OpenCodeCmd)) {
  Write-Host "opencode not found at $OpenCodeCmd" -ForegroundColor Red
  Write-Host "Install with: npm install -g --allow-scripts=opencode-ai opencode-ai" -ForegroundColor Yellow
  exit 1
}

# 1. Require password - never run 0.0.0.0 without auth
if ([string]::IsNullOrEmpty($env:OPENCODE_SERVER_PASSWORD)) {
  Write-Host ""
  Write-Host "OPENCODE_SERVER_PASSWORD is not set. Remote access requires a password." -ForegroundColor Yellow
  $sec = Read-Host "Enter a password for OpenCode web (min 12 chars, will not echo)" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  )
  if ($plain.Length -lt 8) {
    Write-Host "Password too short. Use at least 8 characters." -ForegroundColor Red
    exit 1
  }
  $env:OPENCODE_SERVER_PASSWORD = $plain
  Write-Host "Password set for this session only. To persist, run:" -ForegroundColor Cyan
  Write-Host '  [Environment]::SetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","<your-password>","User")'
  Write-Host ""
}

if ([string]::IsNullOrEmpty($env:OPENCODE_SERVER_USERNAME)) {
  $env:OPENCODE_SERVER_USERNAME = "opencode"
}
Write-Host "Auth user: $($env:OPENCODE_SERVER_USERNAME)" -ForegroundColor Green

# 2. Show addresses
Write-Host ""
Write-Host "Starting OpenCode web..." -ForegroundColor Cyan
Write-Host "  Project : $ProjectRoot"
Write-Host "  Listen  : http://${Hostname}:${Port}"
try {
  $lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*" } | Select-Object -First 1).IPAddress
  if ($lan) { Write-Host "  LAN     : http://${lan}:${Port}" -ForegroundColor Green }
} catch {}
try {
  $ts = (& tailscale ip -4 2>$null)
  if ($ts) { Write-Host "  Tailscale: http://${ts}:${Port}" -ForegroundColor Green }
  else { Write-Host "  Tailscale: not installed - install from https://tailscale.com/download" -ForegroundColor Yellow }
} catch {
  Write-Host "  Tailscale: not detected - install from https://tailscale.com/download" -ForegroundColor Yellow
}
Write-Host "  Local   : http://127.0.0.1:${Port}" -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# 3. Start server (foreground - keep this window open)
& $OpenCodeCmd web --port $Port --hostname $Hostname
