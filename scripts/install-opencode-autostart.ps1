# Install OpenCode web as a Windows Scheduled Task (auto-start at logon + restart on failure).
# Run once as Administrator if you want SYSTEM-level, or as your user for logon task.
#
# Usage (PowerShell, your user is fine):
#   powershell -ExecutionPolicy Bypass -File scripts\install-opencode-autostart.ps1
# Uninstall:
#   powershell -ExecutionPolicy Bypass -File scripts\install-opencode-autostart.ps1 -Uninstall

param([switch]$Uninstall)

$TaskName = "OpenCode-Web"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Script = Join-Path $ProjectRoot "scripts\run-opencode-remote-persistent.ps1"
$LogDir = Join-Path $ProjectRoot "logs"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task: $TaskName" -ForegroundColor Green
  exit 0
}

if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","User"))) {
  Write-Host "ERROR: set OPENCODE_SERVER_PASSWORD first (user env), otherwise the task will exit immediately." -ForegroundColor Red
  Write-Host '  [Environment]::SetEnvironmentVariable("OPENCODE_SERVER_PASSWORD","<strong-password>","User")' -ForegroundColor Yellow
  exit 1
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$Script`"" `
  -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "OpenCode web UI (persistent, logs to $LogDir)" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host "Installed and started task: $TaskName" -ForegroundColor Green
Write-Host "Logs: $LogDir\opencode-web.log" -ForegroundColor Cyan
Write-Host "Manage: Task Scheduler -> $TaskName (Stop/Disable to shut down)" -ForegroundColor Cyan
