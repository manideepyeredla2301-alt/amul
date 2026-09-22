param(
  [string]$Server = 'tcp:100.105.240.98,1433',
  [string]$Database = '0002018303_GVR ENTERPRISES',
  [switch]$NoAmul,
  [switch]$Restart
)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$port = if ($env:PORT) { [int]$env:PORT } else { 4317 }
$url = "http://127.0.0.1:$port/"

function Resolve-Node {
  $runtimeNode = Join-Path $appRoot 'runtime\node.exe'
  if (Test-Path -LiteralPath $runtimeNode) { return $runtimeNode }
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { return $nodeCommand.Source }
  $codexNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $codexNode) { return $codexNode }
  throw 'Node runtime not found. Install Node 24 or place node.exe in runtime\.'
}

function Resolve-AppBrowser {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Test-Ready {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "${url}api/health" -TimeoutSec 1 | Out-Null
    return $true
  } catch {
    return $false
  }
}

$nodePath = Resolve-Node
if ($Restart) {
  # Verify the application before using the listener PID. WMI is unavailable on some PCs.
  if (Test-Ready) {
    $health = Invoke-RestMethod -Uri "${url}api/health" -TimeoutSec 3
    if ($health.mode -ne 'offline-first') { throw 'Another application is using the FrostFlow port.' }
    $listenerIds = @(netstat -ano -p TCP | ForEach-Object {
      if ($_ -match "^\s*TCP\s+127\.0\.0\.1:$port\s+\S+\s+LISTENING\s+(\d+)\s*$") { [int]$Matches[1] }
    } | Select-Object -Unique)
    if (!$listenerIds.Count) { throw 'Cannot identify the FrostFlow service. Restart Windows, then reopen FrostFlow.' }
    foreach ($listenerId in $listenerIds) {
      $serviceProcess = Get-Process -Id $listenerId -ErrorAction Stop
      if ($serviceProcess.ProcessName -ne 'node') { throw 'The listener is not the expected FrostFlow Node service. Nothing was stopped.' }
      Stop-Process -Id $listenerId -Force -ErrorAction Stop
    }
  }
  Start-Sleep -Milliseconds 700
}
$alreadyRunning = Test-Ready
if (!$alreadyRunning) {
  $env:PORT = [string]$port
  if (!$NoAmul) {
    $env:FROSTFLOW_AMUL_ENABLED = '1'
    $env:FROSTFLOW_AMUL_SERVER = $Server
    $env:FROSTFLOW_AMUL_DATABASE = $Database
    $env:FROSTFLOW_AMUL_TRUST_SERVER_CERTIFICATE = '1'
    if (!$env:FROSTFLOW_AMUL_USER) { $env:FROSTFLOW_AMUL_USER = 'amuluser' }
    if (!$env:FROSTFLOW_AMUL_PASSWORD) {
      $credential = Get-Credential -UserName $env:FROSTFLOW_AMUL_USER -Message 'Read-only Amul SQL login for FrostFlow desktop'
      if (!$credential) { exit }
      $env:FROSTFLOW_AMUL_USER = $credential.UserName
      $env:FROSTFLOW_AMUL_PASSWORD = $credential.GetNetworkCredential().Password
    }
  }
  Start-Process -FilePath $nodePath -ArgumentList @('"' + (Join-Path $appRoot 'server.js') + '"') -WorkingDirectory $appRoot -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if (Test-Ready) { break }
    Start-Sleep -Milliseconds 350
  }
}

if (!(Test-Ready)) { throw 'FrostFlow did not start. Run start-frostflow-amul.bat once to see the error details.' }

$browser = Resolve-AppBrowser
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--new-window', '--disable-features=Translate') | Out-Null
} else {
  Start-Process $url | Out-Null
}
