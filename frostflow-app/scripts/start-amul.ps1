param([string]$Server='tcp:100.105.240.98,1433', [string]$Database='0002018303_GVR ENTERPRISES')
$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$nodePath=Join-Path $appRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $nodePath)) {
    $nodeCommand=Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath=$nodeCommand.Source }
    else { $nodePath=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
}
if (!(Test-Path -LiteralPath $nodePath)) { throw 'Node 24 is required. Install it or supply runtime/node.exe.' }
$env:PATH=$PSHOME+';'+$env:PATH
$credential=Get-Credential -UserName 'amuluser' -Message 'Read-only Amul SQL login (not saved to disk)'
if (!$credential) { exit }
try {
    $env:FROSTFLOW_AMUL_ENABLED='1'
    $env:FROSTFLOW_AMUL_SERVER=$Server
    $env:FROSTFLOW_AMUL_DATABASE=$Database
    $env:FROSTFLOW_AMUL_TRUST_SERVER_CERTIFICATE='1'
    $env:FROSTFLOW_AMUL_USER=$credential.UserName
    $env:FROSTFLOW_AMUL_PASSWORD=$credential.GetNetworkCredential().Password
    Write-Host 'Open http://127.0.0.1:4317 and select Amul - read-only. Stop any older FrostFlow server first.'
    & $nodePath (Join-Path $appRoot 'server.js')
} finally {
    Remove-Item Env:FROSTFLOW_AMUL_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:FROSTFLOW_AMUL_USER -ErrorAction SilentlyContinue
    Remove-Item Env:FROSTFLOW_AMUL_ENABLED -ErrorAction SilentlyContinue
}
