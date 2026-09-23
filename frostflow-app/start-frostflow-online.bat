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
"%FROSTFLOW_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-central.ps1"
if errorlevel 1 pause
endlocal
