@echo off
setlocal
echo Syncing Amul (read-only, via Tailscale) to Cloudflare D1: products, stock, all routes, customers, invoices from 09 Sep 2026...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0connector\amul-d1-connector.ps1" %*
if errorlevel 1 (
  echo.
  echo Sync failed. See data\amul-d1-connector.log
  pause
  exit /b 1
)
echo.
echo Sync complete.
pause
endlocal
