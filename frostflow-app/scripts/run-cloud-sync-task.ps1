$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$configPath=Join-Path $appRoot 'data\cloud-sync.json'
$secretPath=Join-Path $appRoot 'data\.cloud-sync-secret'
$logPath=Join-Path $appRoot 'data\cloud-sync.log'
if(!(Test-Path -LiteralPath $configPath)){throw 'Cloud sync is not configured. Run Install-Cloud-Sync.bat first.'}
if(!(Test-Path -LiteralPath $secretPath)){throw 'The protected cloud sync secret is missing. Run Install-Cloud-Sync.bat again.'}
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$secure=Get-Content -LiteralPath $secretPath -Raw | ConvertTo-SecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:FROSTFLOW_CLOUD_URL=$config.cloudUrl
  $env:FROSTFLOW_SYNC_SECRET=$plain
  $env:FROSTFLOW_DEVICE_ID=$config.deviceId
  $env:FROSTFLOW_DB=$config.databasePath
  $node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if(!$node){$node=Join-Path $appRoot 'runtime\node.exe'}
  if(!(Test-Path -LiteralPath $node)){throw 'Node.js 24 or runtime\node.exe is required.'}
  & $node (Join-Path $appRoot 'scripts\cloud-sync-agent.js') --once 2>&1 | Tee-Object -FilePath $logPath -Append
  if($LASTEXITCODE){throw "Cloud sync exited with code $LASTEXITCODE."}
}finally{
  if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
  Remove-Item Env:FROSTFLOW_SYNC_SECRET -ErrorAction SilentlyContinue
}

