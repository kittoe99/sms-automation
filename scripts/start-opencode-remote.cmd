@echo off
REM Double-click launcher for OpenCode remote web server
REM Bypasses PowerShell execution policy for this script only
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-opencode-remote.ps1" %*
pause
