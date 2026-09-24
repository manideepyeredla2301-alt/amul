#requires -Version 5.1
<#
.SYNOPSIS
  Sync the Amul SQL Server database (read-only, via Tailscale) into Cloudflare D1.

.EXAMPLE
  # One-time: import the SQL login from the Desktop credentials file (stored with Windows DPAPI).
  .\amul-d1-connector.ps1 -ImportCredentialFile "$env:USERPROFILE\Desktop\Stocky SQL credentials.txt"

.EXAMPLE
  .\amul-d1-connector.ps1 -DryRun          # read + transform only, writes data\amul-d1-preview.json
  .\amul-d1-connector.ps1                  # one full sync
  .\amul-d1-connector.ps1 -Loop            # keep syncing every IntervalMinutes (backs off on failure)
#>
param(
    [string]$ConfigPath = '',
    [string]$ImportCredentialFile = '',
    [switch]$DryRun,
    [switch]$Loop,
    [int]$IntervalMinutes = 5
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Import-Module (Join-Path $PSScriptRoot 'AmulD1Connector.psm1') -Force

$appRoot = Split-Path $PSScriptRoot -Parent
$dataDir = Join-Path $appRoot 'data'
if (-not $ConfigPath) { $ConfigPath = Join-Path $dataDir 'cloud-sync.json' }
$sqlSecretPath = Join-Path $dataDir '.amul-sql-secret'
$syncSecretPath = Join-Path $dataDir '.cloud-sync-secret'
$logPath = Join-Path $dataDir 'amul-d1-connector.log'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Write-Log([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Read-Config {
    $config = [ordered]@{
        cloudUrl = 'https://frostflow-online.manideepyeredla2301.workers.dev'; deviceId = 'amul-pc'
        amulTailnetHost = 'desktop-ivhrl9v'; amulInstance = 'SQLEXPRESSAMUL'; amulPort = 0
        amulDatabase = '0002018303_GVR ENTERPRISES'; amulSqlUser = ''; invoiceStartDate = '2026-09-09'
        maxReadConcurrency = 3; maxUploadConcurrency = 4
    }
    if (Test-Path -LiteralPath $ConfigPath) {
        $saved = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        foreach ($p in $saved.PSObject.Properties) { $config[$p.Name] = $p.Value }
    }
    return $config
}

function Save-Config($Config) { $Config | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8 }

if ($ImportCredentialFile) {
    $cred = ConvertFrom-CredentialText (Get-Content -LiteralPath $ImportCredentialFile -Raw)
    $config = Read-Config
    $config.amulTailnetHost = $cred.Host.ToLowerInvariant()
    if ($cred.Instance) { $config.amulInstance = $cred.Instance }
    $config.amulDatabase = $cred.Database
    $config.amulSqlUser = $cred.User
    Set-Content -LiteralPath $sqlSecretPath -Value (Protect-Text $cred.Password) -Encoding UTF8
    Save-Config $config
    $address = Resolve-TailnetAddress $config.amulTailnetHost
    Write-Log "Imported SQL login '$($cred.User)' for $($config.amulTailnetHost)\$($config.amulInstance) (Tailscale $address). Password stored with Windows DPAPI."
    return
}

function Invoke-ConnectorRun {
    $config = Read-Config
    if (-not $config.amulSqlUser -or -not (Test-Path -LiteralPath $sqlSecretPath)) { throw 'No Amul SQL login imported. Run with -ImportCredentialFile first.' }
    $minDate = [string]$config.invoiceStartDate
    $startDate = [datetime]::ParseExact($minDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    $address = Resolve-TailnetAddress $config.amulTailnetHost
    $password = Unprotect-TextFile $sqlSecretPath
    try {
        $cs = New-AmulConnectionString -Address $address -Instance $config.amulInstance -Port ([int]$config.amulPort) -Database $config.amulDatabase -User $config.amulSqlUser -Password $password
        $login = Test-AmulLogin $cs
        if ($login.IsSysAdmin) { Write-Log "NOTE: '$($config.amulSqlUser)' is a sysadmin login. The connector only sends guarded SELECTs inside rolled-back transactions; a db_datareader-only login is still recommended." }
        Write-Log "Reading Amul over Tailscale ($address), invoices from $minDate, server time $($login.ServerTime)..."
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $data = Read-AmulDatasets -ConnectionString $cs -StartDate $startDate -MaxConcurrency ([int]$config.maxReadConcurrency) -Password $password
    } finally { $password = $null; $cs = $null }
    $payload = ConvertTo-D1Payload -Data $data -MinDate $minDate
    $counts = ($payload.Keys | ForEach-Object { "$_=$(@($payload[$_]).Count)" }) -join ', '
    Write-Log ("Read complete in {0:n1}s: {1}" -f $watch.Elapsed.TotalSeconds, $counts)

    if ($DryRun) {
        $preview = Join-Path $dataDir 'amul-d1-preview.json'
        $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $preview -Encoding UTF8
        Write-Log "Dry run: nothing uploaded. Preview written to $preview"
        return
    }
    if (-not (Test-Path -LiteralPath $syncSecretPath)) { throw 'The protected Cloudflare sync secret is missing (data\.cloud-sync-secret).' }
    $cloudUrl = ([string]$config.cloudUrl).TrimEnd('/')
    if ($cloudUrl -notmatch '^https://' -and $cloudUrl -notmatch '^http://127\.0\.0\.1[:/]') { throw 'cloudUrl must be an HTTPS URL.' }
    $snapshotId = [guid]::NewGuid().ToString()
    $plan = New-UploadPlan -Payload $payload -DeviceId $config.deviceId -SnapshotId $snapshotId -CapturedAt ((Get-Date).ToUniversalTime().ToString('o')) -MinDate $minDate
    $secret = Unprotect-TextFile $syncSecretPath
    try {
        $result = Send-UploadPlan -BaseUrl $cloudUrl -Secret $secret.Trim() -Groups $plan -MaxInFlight ([int]$config.maxUploadConcurrency) -Log { param($m) Write-Log $m }
    } finally { $secret = $null }
    Write-Log ("Cloudflare D1 sync complete in {0:n1}s ({1} requests, snapshot {2})." -f $watch.Elapsed.TotalSeconds, $result.Requests, $snapshotId)
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\FrostFlowAmulD1Connector')
if (-not $mutex.WaitOne(0)) { Write-Log 'Another connector run is in progress; skipping.'; return }
try {
    $delay = $IntervalMinutes
    do {
        try { Invoke-ConnectorRun; $delay = $IntervalMinutes; $exit = 0 }
        catch { Write-Log "Sync failed; previous D1 data kept. $($_.Exception.Message)"; $delay = [Math]::Min(40, [Math]::Max($IntervalMinutes, $delay * 2)); $exit = 1 }
        if ($Loop) { Start-Sleep -Seconds ($delay * 60) }
    } while ($Loop)
    exit $exit
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
