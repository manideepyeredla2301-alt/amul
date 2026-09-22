$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source
if(!$node){$node=Join-Path $appRoot 'runtime\node.exe'}
if(!(Test-Path -LiteralPath $node)){throw 'Node.js 24 or runtime\node.exe is required.'}
if(!$env:FROSTFLOW_CLOUD_URL){throw 'FROSTFLOW_CLOUD_URL is required.'}
if(!$env:FROSTFLOW_SYNC_SECRET){throw 'FROSTFLOW_SYNC_SECRET is required.'}
& $node (Join-Path $appRoot 'scripts\cloud-sync-agent.js')
