@echo off
REM Firewall setup for OpenCode remote access - double-click, click Yes on UAC prompt
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-opencode-firewall.ps1" %*
pause
