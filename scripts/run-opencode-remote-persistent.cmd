@echo off
REM Persistent launcher - auto-restarts OpenCode web on crash, logs to logs\opencode-web.log
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-opencode-remote-persistent.ps1" %*
pause
