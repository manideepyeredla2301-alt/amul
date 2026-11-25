@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\add-wholesale-staff.ps1"
if errorlevel 1 pause
