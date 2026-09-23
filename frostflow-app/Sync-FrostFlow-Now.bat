@echo off
setlocal
set "FROSTFLOW_PS=pwsh.exe"
where "%FROSTFLOW_PS%" >nul 2>nul
if errorlevel 1 set "FROSTFLOW_PS=powershell.exe"
where "%FROSTFLOW_PS%" >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell is not available.
  pause
  exit /b 1
)
echo Syncing the complete FrostFlow catalogue, stock, customers, routes, orders, invoices and payments...
"%FROSTFLOW_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-cloud-sync-task.ps1"
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
