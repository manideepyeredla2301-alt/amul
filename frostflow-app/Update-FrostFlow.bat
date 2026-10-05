@echo off
setlocal
cd /d "%~dp0.."
where git.exe >nul 2>nul
if errorlevel 1 (
  echo Git for Windows is required to update FrostFlow.
  pause
  exit /b 1
)
git fetch origin main
if errorlevel 1 goto :failed
git merge --ff-only origin/main
if errorlevel 1 goto :failed
echo.
echo FrostFlow application files are up to date. Local data and protected secrets were preserved.
pause
exit /b 0
:failed
echo.
echo Update stopped safely. No local files were overwritten. Review the Git message above.
pause
exit /b 1
