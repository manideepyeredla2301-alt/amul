param([string]$CloudUrl='')
$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$configPath=Join-Path $appRoot 'data\cloud-sync.json'
if(!$CloudUrl -and (Test-Path -LiteralPath $configPath)){$CloudUrl=(Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).cloudUrl}
if(!$CloudUrl){$CloudUrl='https://frostflow-online.manideepyeredla2301.workers.dev'}
if($CloudUrl -notmatch '^https://'){throw 'The central FrostFlow URL must use HTTPS.'}

$task=Get-ScheduledTask -TaskName 'FrostFlow Cloud Sync' -ErrorAction SilentlyContinue
if($task){Start-ScheduledTask -TaskName 'FrostFlow Cloud Sync'}

$candidates=@(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
)
$browser=$candidates | Where-Object {$_ -and (Test-Path -LiteralPath $_)} | Select-Object -First 1
if($browser){Start-Process -FilePath $browser -ArgumentList @("--app=$($CloudUrl.TrimEnd('/'))",'--new-window','--disable-features=Translate') | Out-Null}
else{Start-Process $CloudUrl | Out-Null}
Write-Host 'FrostFlow Central opened. Cloudflare D1 is the operational database.' -ForegroundColor Green
