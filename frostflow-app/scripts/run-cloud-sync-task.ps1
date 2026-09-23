$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$configPath=Join-Path $appRoot 'data\cloud-sync.json'
$secretPath=Join-Path $appRoot 'data\.cloud-sync-secret'
$amulSecretPath=Join-Path $appRoot 'data\.amul-read-secret'
$logPath=Join-Path $appRoot 'data\cloud-sync.log'
if(!(Test-Path -LiteralPath $configPath)){throw 'Cloud sync is not configured. Run Install-Cloud-Sync.bat first.'}
if(!(Test-Path -LiteralPath $secretPath)){throw 'The protected cloud sync secret is missing. Run Install-Cloud-Sync.bat again.'}
if(!(Test-Path -LiteralPath $amulSecretPath)){throw 'The protected Amul read password is missing. Run Install-Cloud-Sync.bat again.'}
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$secure=Get-Content -LiteralPath $secretPath -Raw | ConvertTo-SecureString
$amulSecure=Get-Content -LiteralPath $amulSecretPath -Raw | ConvertTo-SecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$amulPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($amulSecure)
try{
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:FROSTFLOW_CLOUD_URL=$config.cloudUrl
  $env:FROSTFLOW_SYNC_SECRET=$plain
  $env:FROSTFLOW_DEVICE_ID=$config.deviceId
  $env:FROSTFLOW_DB=$config.databasePath
  $env:FROSTFLOW_AMUL_ENABLED='1'
  $env:FROSTFLOW_AMUL_SERVER=$config.amulServer
  $env:FROSTFLOW_AMUL_DATABASE=$config.amulDatabase
  $env:FROSTFLOW_AMUL_USER=$config.amulUser
  $env:FROSTFLOW_AMUL_PASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($amulPointer)
  $env:FROSTFLOW_AMUL_TRUST_SERVER_CERTIFICATE='1'
  $env:FROSTFLOW_AMUL_START_DATE='2026-09-08'
  $node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if(!$node){$node=Join-Path $appRoot 'runtime\node.exe'}
  if(!(Test-Path -LiteralPath $node)){throw 'Node.js 24 or runtime\node.exe is required.'}
  & $node (Join-Path $appRoot 'scripts\amul-cloud-bridge.js') --once 2>&1 | Tee-Object -FilePath $logPath -Append
  if($LASTEXITCODE){throw "Cloud sync exited with code $LASTEXITCODE."}
}finally{
  if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
  if($amulPointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($amulPointer)}
  Remove-Item Env:FROSTFLOW_SYNC_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:FROSTFLOW_AMUL_PASSWORD -ErrorAction SilentlyContinue
}
