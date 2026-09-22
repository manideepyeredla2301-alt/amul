param(
  [string]$CloudUrl='https://frostflow-online.manideepyeredla2301.workers.dev',
  [string]$DatabasePath='',
  [string]$DeviceId='amul-pc'
)
$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
if(!$DatabasePath){$DatabasePath=Join-Path $appRoot 'data\frostflow.sqlite'}
if(!(Test-Path -LiteralPath $DatabasePath)){throw "SQLite database not found: $DatabasePath"}
$DatabasePath=(Resolve-Path -LiteralPath $DatabasePath).Path
$CloudUrl=$CloudUrl.TrimEnd('/')
if($CloudUrl -notmatch '^https://'){throw 'CloudUrl must start with https://'}
Write-Host 'Checking FrostFlow Online...'
$health=Invoke-RestMethod -Uri "$CloudUrl/api/health" -Method Get -TimeoutSec 30
if(!$health.ok){throw 'FrostFlow Online health check failed.'}
$secret=Read-Host 'Paste the FrostFlow sync secret (input is hidden)' -AsSecureString
$plainPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try{
  $length=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($plainPointer).Length
  if($length -lt 32){throw 'The sync secret must contain at least 32 characters.'}
}finally{if($plainPointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($plainPointer)}}
$dataDir=Join-Path $appRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$secret | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $dataDir '.cloud-sync-secret') -Encoding UTF8
[ordered]@{cloudUrl=$CloudUrl;databasePath=$DatabasePath;deviceId=$DeviceId} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDir 'cloud-sync.json') -Encoding UTF8
$runner=Join-Path $PSScriptRoot 'run-cloud-sync-task.ps1'
$pwsh=(Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if(!$pwsh){throw 'PowerShell 7 (pwsh.exe) is required.'}
Write-Host 'Running the first protected sync...'
& $pwsh -NoProfile -File $runner
if($LASTEXITCODE){throw 'The first sync failed. Check data\cloud-sync.log.'}
$action=New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -WindowStyle Hidden -File `"$runner`""
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'FrostFlow Cloud Sync' -Action $action -Trigger $trigger -Settings $settings -Description 'Securely sync FrostFlow SQLite with Cloudflare every five minutes.' -Force | Out-Null
Write-Host 'Cloud sync installed. It will run every five minutes while this Windows user is signed in.' -ForegroundColor Green
Write-Host "Database: $DatabasePath"
Write-Host "Online:   $CloudUrl"

