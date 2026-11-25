$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
$node=if($nodeCommand){$nodeCommand.Source}else{Join-Path $appRoot 'runtime\node.exe'}
if(!(Test-Path -LiteralPath $node)){throw 'Node.js 24 or the FrostFlow runtime\node.exe is required.'}
$authFile=Join-Path $appRoot 'data\wholesale-lan-auth.json'
if(!(Test-Path -LiteralPath $authFile)){throw 'Start Wholesale LAN once to create the owner login first.'}
$username=Read-Host 'Staff username'
$password=Read-Host 'Staff password' -AsSecureString
$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
try{
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $payload=@{username=$username;role='STAFF';password=$plain}|ConvertTo-Json -Compress
  $payload|& $node (Join-Path $appRoot 'scripts\configure-wholesale-lan.js')
  if($LASTEXITCODE){throw 'Staff login was not saved.'}
}finally{
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  $plain=$null;$payload=$null
}
