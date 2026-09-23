@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required.
  pause
  exit /b 1
)
echo Syncing the complete FrostFlow catalogue, stock, customers, routes, orders, invoices and payments...
pwsh.exe -NoProfile -File "%~dp0scripts\run-cloud-sync-task.ps1"
if errorlevel 1 (
  echo.
  echo Sync failed. Review data\cloud-sync.log for the exact error.
  pause
  exit /b 1
)
echo.
echo Sync complete. The online application will now show the latest PC data.
pause
endlocal
