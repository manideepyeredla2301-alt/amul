#requires -Version 5.1
$ErrorActionPreference='Stop'
$taskName='FrostFlow Cloud Sync'
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if(!$task){throw "Scheduled task '$taskName' is missing. Run Install-Cloud-Sync.bat first."}
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
Set-ScheduledTask -TaskName $taskName -Action $task.Actions -Trigger $trigger -Settings $task.Settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'FrostFlow Cloud Sync now runs every 30 minutes. A sync was started now.' -ForegroundColor Green
