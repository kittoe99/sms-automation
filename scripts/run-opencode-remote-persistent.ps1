# Persistent OpenCode web runner - auto-restarts on crash, logs to file.
# Run this instead of start-opencode-remote.ps1 if OpenCode "keeps shutting down".
# Keep this window open OR install autostart (install-opencode-autostart.ps1).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\run-opencode-remote-persistent.ps1
#
# Requires OPENCODE_SERVER_PASSWORD to be set (no interactive prompt, so it
# also works from Task Scheduler). Set once with:
#   [Environment]::SetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","<strong-password>","User")

param(
  [int]$Port = 4096,
  [string]$Hostname = "0.0.0.0",
  [string]$ServeDir = ""
)

$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
# Serve the parent folder so ALL projects are visible in the web UI.
# Override with -ServeDir for a single project.
if ([string]::IsNullOrEmpty($ServeDir)) {
  # Default: the folder holding ALL projects (two levels above this script's
  # project root - covers the nested sms-automation-main/sms-automation-main layout).
  # Override with -ServeDir for a single project.
  $ServeDir = Split-Path -Parent (Split-Path -Parent $ProjectRoot)
  if (-not $ServeDir) { $ServeDir = $ProjectRoot }
}
Set-Location $ServeDir

$LogDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogFile = Join-Path $LogDir "opencode-web.log"

# Unblock: read password from user env (Task Scheduler sees it after re-login)
if ([string]::IsNullOrEmpty($env:OPENCODE_SERVER_PASSWORD)) {
  $env:OPENCODE_SERVER_PASSWORD = [Environment]::GetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","User")
}
if ([string]::IsNullOrEmpty($env:OPENCODE_SERVER_PASSWORD)) {
  Write-Host "ERROR: OPENCODE_SERVER_PASSWORD is not set." -ForegroundColor Red
  Write-Host 'Set it with: [Environment]::SetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","<strong-password>","User")' -ForegroundColor Yellow
  Write-Host "Then close and reopen PowerShell and run this script again." -ForegroundColor Yellow
  exit 1
}
if ($env:OPENCODE_SERVER_PASSWORD.Length -lt 8) {
  Write-Host "ERROR: password is shorter than 8 chars. Refusing to bind $Hostname." -ForegroundColor Red
  exit 1
}
if ([string]::IsNullOrEmpty($env:OPENCODE_SERVER_USERNAME)) {
  $env:OPENCODE_SERVER_USERNAME = [Environment]::GetEnvironmentVariable("OPENCODE_SERVER_USERNAME","User")
  if ([string]::IsNullOrEmpty($env:OPENCODE_SERVER_USERNAME)) { $env:OPENCODE_SERVER_USERNAME = "opencode" }
}

$OpenCodeCmd = Join-Path $env:APPDATA "npm\opencode.cmd"
if (-not (Test-Path $OpenCodeCmd)) {
  Write-Host "ERROR: opencode not found at $OpenCodeCmd" -ForegroundColor Red
  exit 1
}

# Port conflict check (common "instant shutdown" cause: two servers on one port).
# Wait for the old instance to release the port instead of crash-looping into it.
for ($w = 0; $w -lt 6; $w++) {
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $inUse) { break }
  $proc = Get-Process -Id $inUse.OwningProcess -ErrorAction SilentlyContinue
  Write-Host "Port $Port is held by PID $($inUse.OwningProcess) ($($proc.ProcessName)). Waiting 10s..." -ForegroundColor Yellow
  Start-Sleep -Seconds 10
}
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($inUse) {
  Write-Host "ERROR: port $Port still in use after 60s. Kill the old server or use -Port 4098." -ForegroundColor Red
  exit 1
}

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  $line | Tee-Object -FilePath $LogFile -Append | Write-Host
}

Write-Log "=== OpenCode persistent runner ==="
Write-Log "Serving : $ServeDir"
Write-Log "Listen  : http://${Hostname}:${Port} (user: $($env:OPENCODE_SERVER_USERNAME))"
Write-Log "Logs at : $LogFile (script lives under $ProjectRoot)"

$restart = 0
while ($true) {
  $restart++
  Write-Log "--- start #$restart ---"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $OpenCodeCmd web --port $Port --hostname $Hostname --print-logs 2>&1 | Tee-Object -FilePath $LogFile -Append
  $code = $LASTEXITCODE
  $sw.Stop()
  Write-Log "Exited with code $code after $([int]$sw.Elapsed.TotalSeconds)s"
  if ($sw.Elapsed.TotalSeconds -lt 10) {
    Write-Log "Crashed fast - likely config/port/password error. Waiting 10s. Check $LogFile tail."
    Start-Sleep -Seconds 10
  } else {
    Write-Log "Restarting in 3s (Ctrl+C to stop permanently)..."
    Start-Sleep -Seconds 3
  }
}
