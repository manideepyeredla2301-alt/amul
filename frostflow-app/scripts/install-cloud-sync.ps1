param(
  [string]$CloudUrl='https://frostflow-online.manideepyeredla2301.workers.dev',
  [string]$DatabasePath='',
  [string]$DeviceId='amul-pc',
  [string]$AmulServer='tcp:100.105.240.98,1433',
  [string]$AmulDatabase='0002018303_GVR ENTERPRISES',
  [string]$AmulUser='amuluser'
)
$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
if(!$DatabasePath){$DatabasePath=Join-Path $appRoot 'data\amul-cloud-cache.sqlite'}
$DatabasePath=[IO.Path]::GetFullPath($DatabasePath)
$cacheParent=Split-Path $DatabasePath -Parent
New-Item -ItemType Directory -Path $cacheParent -Force | Out-Null
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
$amulCredential=Get-Credential -UserName $AmulUser -Message 'Read-only Amul SQL login for the central Cloudflare sync'
if(!$amulCredential){throw 'Amul read-only credentials are required.'}
$dataDir=Join-Path $appRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$secret | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $dataDir '.cloud-sync-secret') -Encoding UTF8
$amulCredential.Password | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $dataDir '.amul-read-secret') -Encoding UTF8
[ordered]@{cloudUrl=$CloudUrl;databasePath=$DatabasePath;deviceId=$DeviceId;amulServer=$AmulServer;amulDatabase=$AmulDatabase;amulUser=$amulCredential.UserName;startDate='2026-09-08'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDir 'cloud-sync.json') -Encoding UTF8
$runner=Join-Path $PSScriptRoot 'run-cloud-sync-task.ps1'
$pwsh=(Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if(!$pwsh){throw 'PowerShell 7 (pwsh.exe) is required.'}
Write-Host 'Running the first protected sync...'
& $pwsh -NoProfile -File $runner
if($LASTEXITCODE){throw 'The first sync failed. Check data\cloud-sync.log.'}
$action=New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -WindowStyle Hidden -File `"$runner`""
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'FrostFlow Cloud Sync' -Action $action -Trigger $trigger -Settings $settings -Description 'Refresh Amul read-only data and publish the central Cloudflare database every five minutes.' -Force | Out-Null
Write-Host 'Central sync installed. Every run refreshes Amul read-only data first, then updates Cloudflare D1.' -ForegroundColor Green
Write-Host "Replaceable cache: $DatabasePath"
Write-Host "Online:   $CloudUrl"
