$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
$node=if($nodeCommand){$nodeCommand.Source}else{Join-Path $appRoot 'runtime\node.exe'}
if(!(Test-Path -LiteralPath $node)){throw 'Node.js 24 or the FrostFlow runtime\node.exe is required.'}
$authFile=Join-Path $appRoot 'data\wholesale-lan-auth.json'
if(!(Test-Path -LiteralPath $authFile)){
  Write-Host 'First-time setup: create the MR Enterprises wholesale owner login.'
  $password=Read-Host 'Password for rachana' -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
  try{
    $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $payload=@{username='rachana';role='OWNER';password=$plain}|ConvertTo-Json -Compress
    $payload|& $node (Join-Path $appRoot 'scripts\configure-wholesale-lan.js')
    if($LASTEXITCODE){throw 'Could not save the owner login.'}
  }finally{
    if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
    $plain=$null;$payload=$null
  }
}
if(!$env:FROSTFLOW_LAN_HOST){
  $candidates=Get-NetIPConfiguration|Where-Object {$_.IPv4DefaultGateway -and $_.IPv4Address}|ForEach-Object {$_.IPv4Address.IPAddress}
  $env:FROSTFLOW_LAN_HOST=($candidates|Where-Object {$_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'}|Select-Object -First 1)
  if(!$env:FROSTFLOW_LAN_HOST){throw 'No private Wi-Fi or Ethernet address was found. Connect the Windows PC to your local network.'}
}
$scheme=if($env:FROSTFLOW_LAN_TLS_CERT){'https'}else{'http'}
Write-Host "Open $($scheme)://$($env:FROSTFLOW_LAN_HOST):4318/ on phones connected to the same Wi-Fi."
Write-Host 'If Windows Firewall blocks the phone, run Enable-Wholesale-LAN-Firewall.bat once as administrator.'
& $node (Join-Path $appRoot 'wholesale-lan.js')
exit $LASTEXITCODE
