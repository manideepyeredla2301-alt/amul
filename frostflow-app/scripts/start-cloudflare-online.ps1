param(
  [string]$AppOrigin = $env:FROSTFLOW_PUBLIC_ORIGIN
)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent

function Require-Environment([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is required." }
  return $value
}

function Resolve-Command([string]$Name, [string[]]$Candidates) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw "$Name was not found."
}

$node = Resolve-Command 'node.exe' @((Join-Path $appRoot 'runtime\node.exe'))
$cloudflared = Resolve-Command 'cloudflared.exe' @(
  (Join-Path $appRoot 'runtime\cloudflared.exe'),
  (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
)

if ([string]::IsNullOrWhiteSpace($AppOrigin)) { throw 'FROSTFLOW_PUBLIC_ORIGIN must be the public HTTPS ERP origin.' }
$appUri = [Uri]$AppOrigin
if ($appUri.Scheme -ne 'https' -or $appUri.AbsolutePath -ne '/') { throw 'FROSTFLOW_PUBLIC_ORIGIN must look like https://erp.example.com' }

Require-Environment 'FROSTFLOW_ONLINE_USER' | Out-Null
if ((Require-Environment 'FROSTFLOW_ONLINE_PASSWORD').Length -lt 16) { throw 'FROSTFLOW_ONLINE_PASSWORD must contain at least 16 characters.' }
Require-Environment 'META_APP_SECRET' | Out-Null
Require-Environment 'META_WEBHOOK_VERIFY_TOKEN' | Out-Null
Require-Environment 'CLOUDFLARE_TUNNEL_TOKEN' | Out-Null

$env:FROSTFLOW_PUBLIC_ORIGIN = $AppOrigin.TrimEnd('/')
$env:META_PHONE_ID = if ($env:META_PHONE_ID) { $env:META_PHONE_ID } else { '1260169793854093' }
$env:PORT = '4317'
$env:WHATSAPP_WEBHOOK_PORT = '4318'
$env:TUNNEL_TOKEN = $env:CLOUDFLARE_TUNNEL_TOKEN

$app = Start-Process -FilePath $node -ArgumentList @((Join-Path $appRoot 'server.js')) -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru
$webhook = Start-Process -FilePath $node -ArgumentList @((Join-Path $appRoot 'whatsapp-webhook-server.js')) -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru

try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 400
    try { $appReady = (Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 2).ok } catch { $appReady = $false }
    try { $webhookReady = (Invoke-WebRequest 'http://127.0.0.1:4318/healthz' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $webhookReady = $false }
  } until (($appReady -and $webhookReady) -or (Get-Date) -gt $deadline)
  if (!$appReady -or !$webhookReady) { throw 'FrostFlow or its webhook did not become ready.' }

  Write-Host "FrostFlow is ready locally and protected at $AppOrigin"
  Write-Host 'Starting the Cloudflare Tunnel. Keep this window open.'
  & $cloudflared tunnel run
  if ($LASTEXITCODE -ne 0) { throw "cloudflared stopped with exit code $LASTEXITCODE." }
} finally {
  foreach ($process in @($webhook,$app)) {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
}
