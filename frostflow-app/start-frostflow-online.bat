@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required.
  pause
  exit /b 1
)
pwsh.exe -NoProfile -File "%~dp0scripts\start-cloudflare-online.ps1"
if errorlevel 1 pause
endlocal
