#requires -Version 5.1
# Registers "FrostFlow Amul D1 Connector" to run every five minutes for the current user.
param([int]$IntervalMinutes = 5)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'amul-d1-connector.ps1'
$powerShell = (Get-Command powershell.exe).Source
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName 'FrostFlow Amul D1 Connector' -Action $action -Trigger $trigger -Settings $settings -Description 'Read-only Amul SQL (Tailscale) to Cloudflare D1 sync.' -Force | Out-Null
Write-Host "Scheduled every $IntervalMinutes minutes. Log: data\amul-d1-connector.log" -ForegroundColor Green
