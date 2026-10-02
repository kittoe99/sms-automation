# OpenCode firewall rule for remote access.
# Allows TCP 4096 inbound. Just run it - it asks for admin rights itself (UAC).
#
# Usage (normal PowerShell, no admin needed to start):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-opencode-firewall.ps1
# Or double-click scripts\setup-opencode-firewall.cmd
# To remove:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-opencode-firewall.ps1 -Remove

param(
  [int]$Port = 4096,
  [switch]$Remove
)

$RuleName = "OpenCode Web $Port"

# Self-elevate: re-launch as admin if needed (UAC prompt appears)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Requesting administrator rights (click Yes on the UAC prompt)..." -ForegroundColor Yellow
  $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if ($Remove) { $argList += " -Remove" }
  if ($Port -ne 4096) { $argList += " -Port $Port" }
  Start-Process powershell.exe -ArgumentList $argList -Verb RunAs
  exit 0
}

if ($Remove) {
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  Write-Host "Removed firewall rule: $RuleName" -ForegroundColor Green
  exit 0
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Rule already exists: $RuleName" -ForegroundColor Yellow
  exit 0
}

New-NetFirewallRule -DisplayName $RuleName `
  -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Private,Domain `
  -Description "Allow OpenCode web remote access (Tailscale/LAN). Only Private+Domain, not Public." | Out-Null

Write-Host "Firewall rule created: $RuleName (TCP $Port, Private+Domain only)" -ForegroundColor Green
Write-Host "Tip: keep Windows network profile set to Private, not Public." -ForegroundColor Cyan
