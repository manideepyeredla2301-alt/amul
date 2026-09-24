#requires -Version 5.1
# Amul SQL Server (read-only, reached over Tailscale) -> Cloudflare D1 connector.
# Reads run in parallel runspaces on separate read-only sessions; uploads are
# asynchronous HttpClient requests with a bounded in-flight window and retries.
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Security

$script:Invariant = [Globalization.CultureInfo]::InvariantCulture
$script:ForbiddenSql = '(?i)\b(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|OPENROWSET|OPENQUERY|OPENDATASOURCE|INTO|WAITFOR|SHUTDOWN|KILL|RECONFIGURE|DECLARE|SP_\w+|XP_\w+)\b'
$script:ChunkSize = 40

# ---------------------------------------------------------------- read-only SQL

function Assert-ReadOnlySql {
    param([Parameter(Mandatory)][string]$Sql)
    if ($Sql -notmatch '^\s*SELECT\s') { throw 'Read-only guard: only SELECT statements may be sent to Amul SQL.' }
    if ($Sql.Contains(';') -or $Sql.Contains('--') -or $Sql.Contains('/*')) { throw 'Read-only guard: statement batches and comments are not allowed.' }
    if ($Sql -match $script:ForbiddenSql) { throw "Read-only guard: '$($Matches[1])' is not allowed in Amul queries." }
}

# Fixed projections only. Nothing here is built from caller input.
function Get-AmulQueries {
    [ordered]@{
        products          = 'SELECT PrdId,PrdDCode,PrdCCode,PrdName,EANCode,PrdStatus FROM dbo.Product'
        batches           = 'SELECT PrdId,PrdBatId,PrdBatCode,ExpDate,DefaultPriceId FROM dbo.ProductBatch'
        stock             = 'SELECT PrdId,PrdBatID,LcnId,PrdBatLcnSih FROM dbo.ProductBatchLocation'
        prices            = 'SELECT PriceId,PrdBatId,BatchSeqId,SLNo,PrdBatDetailValue FROM dbo.ProductBatchDetails WHERE PriceId IN (SELECT b.DefaultPriceId FROM dbo.ProductBatch b WHERE EXISTS (SELECT 1 FROM dbo.ProductBatchLocation l WHERE l.PrdBatID=b.PrdBatId AND (l.PrdBatLcnSih<>0 OR l.PrdBatLcnUih<>0 OR l.PrdBatLcnFre<>0)))'
        price_definitions = 'SELECT SlNo,BatchSeqId,RefCode,FieldDesc FROM dbo.BatchCreation'
        routes            = 'SELECT * FROM dbo.RouteMaster'
        customer_routes   = 'SELECT RtrId,RMId,Availability,LastModDate FROM dbo.RetailerMarket'
        customers         = 'SELECT RtrId,RtrCode,RtrName,RtrAdd1,RtrAdd2,RtrAdd3,RtrPinNo,RtrPhoneNo,RtrResPhone1,RtrTINNo,RtrStatus,RtrCrLimit,RtrCrDays,RMId,Deleted,LastModDate FROM dbo.Retailer'
        invoices          = 'SELECT SalId,SalInvNo,SalInvDate,RtrId,RMId,DlvRMId,SalNetAmt,SalPayAmt,DlvSts,SalDlvDate,LastModDate FROM dbo.SalesInvoice WHERE SalInvDate >= @startDate'
    }
}

$script:ReadWorker = {
    param($ConnectionString, $Dataset, $Sql, $StartDate, $ForbiddenSql)
    $ErrorActionPreference = 'Stop'
    # Defense in depth: re-check inside the worker before anything reaches the server.
    if ($Sql -notmatch '^\s*SELECT\s' -or $Sql.Contains(';') -or $Sql -match $ForbiddenSql) { throw "Read-only guard rejected $Dataset." }
    $connection = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
    $transaction = $null
    try {
        $connection.Open()
        # Every read runs inside a transaction that is always rolled back, so even a
        # privileged login cannot leave a change behind.
        $transaction = $connection.BeginTransaction([Data.IsolationLevel]::ReadCommitted)
        $setup = $connection.CreateCommand(); $setup.Transaction = $transaction
        $setup.CommandText = 'SET LOCK_TIMEOUT 5000'; [void]$setup.ExecuteNonQuery(); $setup.Dispose()
        $command = $connection.CreateCommand(); $command.Transaction = $transaction
        $command.CommandTimeout = 30
        $command.CommandText = $Sql
        if ($Sql.Contains('@startDate')) { [void]$command.Parameters.Add('@startDate', [Data.SqlDbType]::DateTime); $command.Parameters['@startDate'].Value = $StartDate }
        $reader = $command.ExecuteReader()
        $rows = New-Object System.Collections.Generic.List[object]
        $inv = [Globalization.CultureInfo]::InvariantCulture
        while ($reader.Read()) {
            $row = @{}
            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                $value = $reader.GetValue($i)
                if ($value -is [DBNull]) { $value = $null }
                elseif ($value -is [DateTime]) { $value = $value.ToString('yyyy-MM-ddTHH:mm:ss.fff', $inv) }
                elseif ($value -is [decimal] -or $value -is [double] -or $value -is [single]) { $value = $value.ToString($inv) }
                elseif ($value -is [byte[]]) { $value = $null }
                $row[$reader.GetName($i)] = $value
            }
            $rows.Add($row)
        }
        $reader.Close(); $command.Dispose()
        return @{ dataset = $Dataset; rows = $rows.ToArray(); error = $null }
    } catch {
        return @{ dataset = $Dataset; rows = @(); error = $_.Exception.GetBaseException().Message }
    } finally {
        if ($transaction) { try { $transaction.Rollback() } catch {} }
        $connection.Dispose()
    }
}

function Read-AmulDatasets {
    param([Parameter(Mandatory)][string]$ConnectionString, [Parameter(Mandatory)][datetime]$StartDate, [int]$MaxConcurrency = 3, [string]$Password = '')
    $queries = Get-AmulQueries
    foreach ($sql in $queries.Values) { Assert-ReadOnlySql $sql }
    $pool = [RunspaceFactory]::CreateRunspacePool(1, [Math]::Max(1, $MaxConcurrency))
    $pool.Open()
    $pending = @()
    try {
        foreach ($name in $queries.Keys) {
            $ps = [PowerShell]::Create(); $ps.RunspacePool = $pool
            [void]$ps.AddScript($script:ReadWorker).AddArgument($ConnectionString).AddArgument($name).AddArgument($queries[$name]).AddArgument($StartDate).AddArgument($script:ForbiddenSql)
            $pending += [pscustomobject]@{ Name = $name; Shell = $ps; Handle = $ps.BeginInvoke() }
        }
        $result = @{}
        $errors = @()
        foreach ($job in $pending) {
            $output = $job.Shell.EndInvoke($job.Handle)
            $value = $output | Select-Object -Last 1
            if (-not $value) { $errors += "$($job.Name): no result"; continue }
            if ($value.error) {
                $message = [string]$value.error
                if ($Password) { $message = $message.Replace($Password, '[redacted]') }
                $errors += "$($job.Name): $message"; continue
            }
            $result[$job.Name] = @($value.rows)
        }
        if ($errors.Count) { throw ('Amul read failed; D1 was not changed. ' + ($errors -join ' | ')) }
        return $result
    } finally {
        foreach ($job in $pending) { $job.Shell.Dispose() }
        $pool.Close(); $pool.Dispose()
    }
}

# ------------------------------------------------------------- Tailscale + creds

function Get-TailscaleExe {
    $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $default) { return $default }
    throw 'Tailscale is not installed on this PC.'
}

function Resolve-TailnetAddress {
    param([Parameter(Mandatory)][string]$HostName, $StatusJson = $null)
    if (-not $StatusJson) { $StatusJson = (& (Get-TailscaleExe) status --json) | Out-String }
    $status = $StatusJson | ConvertFrom-Json
    if ($status.BackendState -and $status.BackendState -ne 'Running') { throw "Tailscale is not connected (state: $($status.BackendState))." }
    $nodes = @()
    if ($status.Self) { $nodes += [pscustomobject]@{ Node = $status.Self; IsSelf = $true } }
    if ($status.Peer) { foreach ($p in $status.Peer.PSObject.Properties) { $nodes += [pscustomobject]@{ Node = $p.Value; IsSelf = $false } } }
    $short = $HostName.Split('.')[0]
    $match = $nodes | Where-Object { $_.Node.HostName -ieq $short -or ([string]$_.Node.DNSName).Split('.')[0] -ieq $short } | Select-Object -First 1
    if (-not $match) { throw "Tailscale node '$HostName' was not found in this tailnet." }
    if (-not $match.IsSelf -and -not $match.Node.Online) { throw "Tailscale node '$HostName' is offline." }
    $ip = @($match.Node.TailscaleIPs) | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
    if (-not $ip) { throw "Tailscale node '$HostName' has no IPv4 address." }
    return $ip
}

function ConvertFrom-CredentialText {
    param([Parameter(Mandatory)][string]$Text)
    $pattern = '(?is)Server:\s*(?<server>\S+)\s+Database:\s*(?<database>.+?)\s+User(?:name)?:\s*(?<user>\S+)\s+Password:\s*(?<password>\S+)'
    if ($Text -notmatch $pattern) { throw 'Credential file must contain Server:, Database:, Username: and Password:.' }
    $server = $Matches.server
    $hostPart = $server; $instance = ''
    if ($server.Contains('\')) { $hostPart = $server.Split('\')[0]; $instance = $server.Split('\')[1] }
    [pscustomobject]@{ Host = $hostPart; Instance = $instance; Database = $Matches.database.Trim(); User = $Matches.user; Password = $Matches.password }
}

function Protect-Text([string]$Plain) {
    $secure = New-Object System.Security.SecureString
    foreach ($ch in $Plain.ToCharArray()) { $secure.AppendChar($ch) }
    return ($secure | ConvertFrom-SecureString)
}

function Unprotect-TextFile([string]$Path) {
    $secure = (Get-Content -LiteralPath $Path -Raw).Trim().TrimStart([char]0xFEFF) | ConvertTo-SecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function New-AmulConnectionString {
    param([Parameter(Mandatory)][string]$Address, [string]$Instance, [int]$Port = 0, [Parameter(Mandatory)][string]$Database, [Parameter(Mandatory)][string]$User, [Parameter(Mandatory)][string]$Password)
    $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    if ($Port -gt 0) { $b['Data Source'] = "tcp:$Address,$Port" }
    elseif ($Instance) { $b['Data Source'] = "$Address\$Instance" }
    else { $b['Data Source'] = "tcp:$Address,1433" }
    $b['Initial Catalog'] = $Database
    $b['User ID'] = $User
    $b['Password'] = $Password
    $b['Encrypt'] = $true
    # The SQL certificate is self-issued; traffic is already inside the Tailscale WireGuard tunnel.
    $b['TrustServerCertificate'] = $true
    $b['ApplicationIntent'] = 'ReadOnly'
    $b['Application Name'] = 'FrostFlow Amul->D1 read-only connector'
    $b['Connect Timeout'] = 10
    $b['Pooling'] = $false
    return $b.ConnectionString
}

function Test-AmulLogin {
    param([Parameter(Mandatory)][string]$ConnectionString)
    $sql = "SELECT IS_SRVROLEMEMBER('sysadmin') is_sysadmin, CONVERT(varchar(23), GETDATE(), 121) server_time"
    Assert-ReadOnlySql $sql
    $c = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
    try {
        $c.Open(); $tx = $c.BeginTransaction()
        $cmd = $c.CreateCommand(); $cmd.Transaction = $tx; $cmd.CommandText = $sql; $cmd.CommandTimeout = 15
        $r = $cmd.ExecuteReader(); [void]$r.Read()
        $info = [pscustomobject]@{ IsSysAdmin = ($r.GetValue(0) -eq 1); ServerTime = [string]$r.GetValue(1) }
        $r.Close(); $tx.Rollback()
        return $info
    } finally { $c.Dispose() }
}

# ------------------------------------------------------------------- transforms

function Test-Truthy($Value) {
    if ($null -eq $Value) { return $false }
    if ($Value -is [bool]) { return $Value }
    $s = ([string]$Value).Trim().ToUpperInvariant()
    return @('1', 'Y', 'YES', 'TRUE', 'T') -contains $s
}

function ConvertTo-Paise($Value) {
    if ($null -eq $Value -or [string]$Value -eq '') { return 0 }
    $d = [decimal]::Parse([string]$Value, [Globalization.NumberStyles]::Float, $script:Invariant)
    return [long][Math]::Round($d * 100, [MidpointRounding]::AwayFromZero)
}

function ConvertTo-Ymd($Value) {
    $s = [string]$Value
    if ($s.Length -ge 10 -and $s -match '^\d{4}-\d{2}-\d{2}') { return $s.Substring(0, 10) }
    return ''
}

function Limit-Text($Value, [int]$Max) {
    $s = ([string]$Value).Trim()
    if ($s.Length -gt $Max) { return $s.Substring(0, $Max) }
    return $s
}

function ConvertTo-SafePhone($Value) {
    $d = ([string]$Value) -replace '\D', ''
    if ($d -match '^0[6-9]\d{9}$') { $d = $d.Substring(1) }
    if ($d -match '^[6-9]\d{9}$') { return "91$d" }
    if ($d -match '^[1-9]\d{7,14}$') { return $d }
    return ''
}

function Get-ProductCategory([string]$Name) {
    $n = $Name.ToLowerInvariant()
    if ($n -match 'tricone|tricon') { return 'Tricones' }
    if ($n -match 'stick|kulfi|chocobar|frostik') { return 'Sticks & Kulfi' }
    if ($n -match '\b60\s*ml\b') { return '60 ml Cups' }
    if ($n -match '\b100\s*ml\b') { return '100 ml Cups' }
    if ($n -match 'cup') { return 'Cups' }
    if ($n -match '750\s*ml|combo') { return '750 ml & Combos' }
    if ($n -match 'tub|family|bulk|\b[125]\s*l\b') { return 'Tubs & Family Packs' }
    if ($n -match 'butter|cheese|paneer|milk|ghee|curd|lassi') { return 'Dairy' }
    if ($n -match 'chocolate|wafer') { return 'Chocolates' }
    if ($n -match 'snack|fries|patty|samosa|nugget') { return 'Frozen Snacks' }
    return 'Other'
}

function Get-PriceMap($Prices, $Definitions) {
    $labels = @{}
    foreach ($d in @($Definitions)) {
        $label = [string]$d.FieldDesc; if (-not $label) { $label = [string]$d.RefCode }
        $labels["$($d.BatchSeqId):$($d.SlNo)"] = $label.ToLowerInvariant()
    }
    $map = @{}
    foreach ($p in @($Prices)) {
        $id = [string]$p.PriceId
        if (-not $map.ContainsKey($id)) { $map[$id] = @{ mrp = [long]0; selling = [long]0 } }
        $label = $labels["$($p.BatchSeqId):$($p.SLNo)"]
        if (-not $label) { continue }
        $paise = ConvertTo-Paise $p.PrdBatDetailValue
        if ($label.Contains('mrp')) { $map[$id].mrp = $paise }
        if ($label.Contains('sel') -or $label.Contains('list')) { $map[$id].selling = $paise }
    }
    return $map
}

function ConvertTo-InventoryItems($Products, $Batches, $Stock, $PriceMap) {
    $batchById = @{}; foreach ($b in @($Batches)) { $batchById[[string]$b.PrdBatId] = $b }
    $totals = @{}
    foreach ($s in @($Stock)) {
        $batch = $batchById[[string]$s.PrdBatID]
        $productId = [string]$s.PrdId
        if ($batch -and $batch.PrdId) { $productId = [string]$batch.PrdId }
        if (-not $productId) { continue }
        if (-not $totals.ContainsKey($productId)) { $totals[$productId] = @{ stock = [double]0; mrp = [long]0; selling = [long]0 } }
        $t = $totals[$productId]
        $qty = 0.0; if ($null -ne $s.PrdBatLcnSih) { $qty = [double]::Parse([string]$s.PrdBatLcnSih, $script:Invariant) }
        $t.stock += $qty
        if ($batch) {
            $price = $PriceMap[[string]$batch.DefaultPriceId]
            if ($price) { if (-not $t.mrp) { $t.mrp = $price.mrp }; if (-not $t.selling) { $t.selling = $price.selling } }
        }
    }
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($p in @($Products)) {
        $name = Limit-Text $p.PrdName 200
        if (-not $name) { continue }
        $t = $totals[[string]$p.PrdId]; if (-not $t) { $t = @{ stock = 0.0; mrp = 0; selling = 0 } }
        $items.Add([ordered]@{
            product_id = 'AMUL:' + $p.PrdId; sku = Limit-Text $p.PrdDCode 100; product_name = $name
            category = Get-ProductCategory $name; unit = 'PCS'; stock_qty = [Math]::Max(0.0, [double]$t.stock)
            mrp_paise = $t.mrp; selling_price_paise = $t.selling
            active = -not ($null -ne $p.PrdStatus -and [string]$p.PrdStatus -eq '0'); source_updated_at = ''
        })
    }
    return , $items.ToArray()
}

function Get-VisitDays($Route) {
    $days = @()
    foreach ($d in 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun') {
        if ($Route.ContainsKey("RM$d") -and (Test-Truthy $Route["RM$d"])) { $days += $d }
    }
    return ($days -join ',')
}

function Test-RouteActive($Route) {
    $status = $null; foreach ($k in 'RMstatus', 'RMStatus') { if ($Route.ContainsKey($k)) { $status = $Route[$k] } }
    $deleted = $null; if ($Route.ContainsKey('Deleted')) { $deleted = $Route['Deleted'] }
    if ($null -ne $status -and [string]$status -eq '0') { return $false }
    if (Test-Truthy $deleted) { return $false }
    return $true
}

# Every route master row is migrated, including inactive ones (flagged active=false).
function ConvertTo-RouteItems($Routes, $CustomerRoutes, $Customers) {
    $members = @{}
    foreach ($m in @($CustomerRoutes)) { if ($m.RMId -and $m.RtrId) { $k = [string]$m.RMId; if (-not $members[$k]) { $members[$k] = @{} }; $members[$k][[string]$m.RtrId] = $true } }
    foreach ($c in @($Customers)) { if ($c.RMId -and $c.RtrId) { $k = [string]$c.RMId; if (-not $members[$k]) { $members[$k] = @{} }; $members[$k][[string]$c.RtrId] = $true } }
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($r in @($Routes)) {
        if ($null -eq $r.RMId) { continue }
        $id = [string]$r.RMId
        $name = Limit-Text $r.RMName 150; if (-not $name) { $name = "Route $id" }
        $details = [ordered]@{}
        foreach ($k in ($r.Keys | Sort-Object)) { $details[$k] = $r[$k] }
        if ((ConvertTo-Json $details -Compress -Depth 3).Length -gt 7800) {
            $details = [ordered]@{}; foreach ($k in ($r.Keys | Where-Object { $_ -like 'RM*' -or $_ -eq 'Deleted' } | Sort-Object)) { $details[$k] = Limit-Text $r[$k] 120 }
        }
        $count = 0; if ($members[$id]) { $count = $members[$id].Count }
        $updated = ''; if ($r.ContainsKey('LastModDate')) { $updated = [string]$r.LastModDate }
        $items.Add([ordered]@{
            id = 'AMUL:' + $id; source = 'AMUL'; source_id = $id; code = Limit-Text $r.RMCode 80; name = $name
            active = (Test-RouteActive $r); visit_days = Get-VisitDays $r; customer_count = $count; details = $details
            source_updated_at = Limit-Text $updated 40
        })
    }
    return , $items.ToArray()
}

function ConvertTo-CustomerRouteItems($CustomerRoutes, $Customers) {
    $seen = @{}
    $items = New-Object System.Collections.Generic.List[object]
    $pairs = @()
    foreach ($m in @($CustomerRoutes)) { $pairs += , @([string]$m.RtrId, [string]$m.RMId, [string]$m.LastModDate) }
    foreach ($c in @($Customers)) { $pairs += , @([string]$c.RtrId, [string]$c.RMId, [string]$c.LastModDate) }
    foreach ($p in $pairs) {
        if (-not $p[0] -or -not $p[1]) { continue }
        $key = "$($p[0]):$($p[1])"; if ($seen[$key]) { continue }; $seen[$key] = $true
        $items.Add([ordered]@{ id = "AMUL:$key"; source = 'AMUL'; source_id = $key; customer_id = 'AMUL:' + $p[0]; route_id = 'AMUL:' + $p[1]; active = $true; source_updated_at = Limit-Text $p[2] 40 })
    }
    return , $items.ToArray()
}

function ConvertTo-InvoiceItems($Invoices, $Customers, $Routes, [string]$MinDate) {
    $customerById = @{}; foreach ($c in @($Customers)) { $customerById[[string]$c.RtrId] = $c }
    $routeById = @{}; foreach ($r in @($Routes)) { $routeById[[string]$r.RMId] = $r }
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($i in @($Invoices)) {
        $invoiceDate = ConvertTo-Ymd $i.SalInvDate
        if (-not $invoiceDate -or $invoiceDate -lt $MinDate) { continue }
        $c = $customerById[[string]$i.RtrId]
        $routeId = [string]$i.RMId; if (-not $routeId) { $routeId = [string]$i.DlvRMId }
        $route = $routeById[$routeId]
        $total = [Math]::Max([long]0, (ConvertTo-Paise $i.SalNetAmt))
        $paid = [Math]::Min($total, [Math]::Max([long]0, (ConvertTo-Paise $i.SalPayAmt)))
        $outstanding = $total - $paid
        $status = 'UNPAID'; if ($outstanding -eq 0) { $status = 'PAID' } elseif ($paid -gt 0) { $status = 'PART_PAID' }
        $dueBase = ConvertTo-Ymd $i.SalDlvDate; if (-not $dueBase) { $dueBase = $invoiceDate }
        $due = ([datetime]::ParseExact($dueBase, 'yyyy-MM-dd', $script:Invariant)).AddDays(2).ToString('yyyy-MM-dd', $script:Invariant)
        $name = ''; $mobile = ''
        if ($c) { $name = Limit-Text $c.RtrName 200; $mobile = ConvertTo-SafePhone $c.RtrPhoneNo; if (-not $mobile) { $mobile = ConvertTo-SafePhone $c.RtrResPhone1 } }
        if (-not $name) { $name = "Retailer $($i.RtrId)" }
        $number = Limit-Text $i.SalInvNo 100; if (-not $number) { $number = [string]$i.SalId }
        $routeName = ''; if ($route) { $routeName = Limit-Text $route.RMName 150 }
        $customerId = ''; if ($i.RtrId) { $customerId = 'AMUL:' + $i.RtrId }
        $items.Add([ordered]@{
            id = 'AMUL:' + $i.SalId; source = 'AMUL'; source_id = [string]$i.SalId; invoice_number = $number
            invoice_date = $invoiceDate; due_date = $due; customer_id = $customerId; customer_name = $name; mobile = $mobile
            route_name = $routeName; total_paise = $total; paid_paise = $paid; outstanding_paise = $outstanding
            payment_status = $status; status = 'POSTED'; source_updated_at = Limit-Text $i.LastModDate 40
        })
    }
    return , $items.ToArray()
}

function ConvertTo-CustomerItems($Customers, $CustomerRoutes, $Routes, $InvoiceItems) {
    $routeById = @{}; foreach ($r in @($Routes)) { $routeById[[string]$r.RMId] = $r }
    $firstRoute = @{}; foreach ($m in @($CustomerRoutes)) { $k = [string]$m.RtrId; if ($k -and $m.RMId -and -not $firstRoute[$k]) { $firstRoute[$k] = [string]$m.RMId } }
    $balance = @{}; foreach ($i in @($InvoiceItems)) { if ($i.customer_id) { $balance[$i.customer_id] = [long]$balance[$i.customer_id] + [long]$i.outstanding_paise } }
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($c in @($Customers)) {
        if ($null -eq $c.RtrId) { continue }
        $id = 'AMUL:' + $c.RtrId
        $routeId = [string]$c.RMId; if (-not $routeId) { $routeId = $firstRoute[[string]$c.RtrId] }
        $route = $null; if ($routeId) { $route = $routeById[$routeId] }
        $name = Limit-Text $c.RtrName 200; if (-not $name) { $name = "Retailer $($c.RtrId)" }
        $mobile = ConvertTo-SafePhone $c.RtrPhoneNo; if (-not $mobile) { $mobile = ConvertTo-SafePhone $c.RtrResPhone1 }
        $address = Limit-Text ((@($c.RtrAdd1, $c.RtrAdd2, $c.RtrAdd3, $c.RtrPinNo) | Where-Object { $_ -and ([string]$_).Trim() }) -join ', ') 500
        $days = 0; if ($c.RtrCrDays) { $days = [Math]::Max(0, [int][double]::Parse([string]$c.RtrCrDays, $script:Invariant)) }
        $active = -not (([string]$c.RtrStatus -eq '0') -or (Test-Truthy $c.Deleted))
        $routeName = ''; if ($route) { $routeName = Limit-Text $route.RMName 150 }
        $routeRef = ''; if ($routeId) { $routeRef = 'AMUL:' + $routeId }
        $items.Add([ordered]@{
            id = $id; source = 'AMUL'; source_id = [string]$c.RtrId; code = Limit-Text $c.RtrCode 80; name = $name
            mobile = $mobile; whatsapp_number = $mobile; gstin = Limit-Text $c.RtrTINNo 30; address = $address; city = ''
            route_id = $routeRef; route_name = $routeName; credit_days = $days
            credit_limit_paise = [Math]::Max([long]0, (ConvertTo-Paise $c.RtrCrLimit)); balance_paise = [long]$balance[$id]
            active = $active; source_updated_at = Limit-Text $c.LastModDate 40
        })
    }
    return , $items.ToArray()
}

function ConvertTo-D1Payload {
    param([Parameter(Mandatory)]$Data, [Parameter(Mandatory)][string]$MinDate)
    $invoices = ConvertTo-InvoiceItems $Data.invoices $Data.customers $Data.routes $MinDate
    [ordered]@{
        inventory       = ConvertTo-InventoryItems $Data.products $Data.batches $Data.stock (Get-PriceMap $Data.prices $Data.price_definitions)
        routes          = ConvertTo-RouteItems $Data.routes $Data.customer_routes $Data.customers
        customer_routes = ConvertTo-CustomerRouteItems $Data.customer_routes $Data.customers
        customers       = ConvertTo-CustomerItems $Data.customers $Data.customer_routes $Data.routes $invoices
        invoices        = $invoices
    }
}

# --------------------------------------------------------------- async uploads

function New-UploadPlan {
    param([Parameter(Mandatory)]$Payload, [Parameter(Mandatory)][string]$DeviceId, [Parameter(Mandatory)][string]$SnapshotId, [Parameter(Mandatory)][string]$CapturedAt, [Parameter(Mandatory)][string]$MinDate)
    $groups = @()
    foreach ($name in $Payload.Keys) {
        $rows = @($Payload[$name])
        $route = '/api/sync/business'; if ($name -eq 'inventory') { $route = '/api/sync/snapshot' }
        $base = [ordered]@{ device_id = $DeviceId; snapshot_id = $SnapshotId; captured_at = $CapturedAt }
        if ($name -ne 'inventory') { $base.dataset = $name }
        $chunks = @()
        for ($o = 0; $o -lt $rows.Count; $o += $script:ChunkSize) {
            $b = [ordered]@{}; foreach ($k in $base.Keys) { $b[$k] = $base[$k] }
            $b.complete = $false; $b.items = @($rows[$o..([Math]::Min($rows.Count, $o + $script:ChunkSize) - 1)])
            $chunks += (ConvertTo-Json $b -Compress -Depth 6)
        }
        $done = [ordered]@{}; foreach ($k in $base.Keys) { $done[$k] = $base[$k] }
        $done.complete = $true; $done.items = @()
        if ($name -eq 'invoices') { $done.prune = $true; $done.min_date = $MinDate }
        # Never finalize an empty inventory snapshot: it would deactivate every product.
        if ($name -eq 'inventory' -and $rows.Count -eq 0) { throw 'Amul returned no products; refusing to publish an empty inventory snapshot.' }
        $groups += [pscustomobject]@{ Name = $name; Route = $route; Chunks = $chunks; Completion = (ConvertTo-Json $done -Compress -Depth 4); Optional = ($name -eq 'customer_routes'); Rows = $rows.Count }
    }
    return $groups
}

function Send-UploadPlan {
    param([Parameter(Mandatory)][string]$BaseUrl, [Parameter(Mandatory)][string]$Secret, [Parameter(Mandatory)]$Groups,
        [int]$MaxInFlight = 4, [int]$MaxAttempts = 5, [int]$TimeoutSeconds = 60, [scriptblock]$Log = { param($m) Write-Host $m })
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $state = @{}
    $queue = New-Object System.Collections.Generic.List[object]
    # Interleave chunks across datasets so every dataset progresses concurrently.
    $max = 0; foreach ($g in $Groups) { $state[$g.Name] = @{ Remaining = $g.Chunks.Count; Failed = $false; Done = $false; Group = $g }; if ($g.Chunks.Count -gt $max) { $max = $g.Chunks.Count } }
    for ($i = 0; $i -lt $max; $i++) { foreach ($g in $Groups) { if ($i -lt $g.Chunks.Count) { $queue.Add(@{ Group = $g.Name; Route = $g.Route; Body = $g.Chunks[$i]; Attempt = 0; NotBefore = [datetime]::MinValue; Final = $false }) } } }
    foreach ($g in $Groups) { if ($g.Chunks.Count -eq 0) { $queue.Add(@{ Group = $g.Name; Route = $g.Route; Body = $g.Completion; Attempt = 0; NotBefore = [datetime]::MinValue; Final = $true }) } }
    $inflight = New-Object System.Collections.Generic.List[object]
    $sent = 0
    try {
        while ($queue.Count -or $inflight.Count) {
            $now = [datetime]::UtcNow
            for ($q = 0; $q -lt $queue.Count -and $inflight.Count -lt $MaxInFlight; ) {
                $job = $queue[$q]
                if ($state[$job.Group].Failed) { $queue.RemoveAt($q); continue }
                if ($job.NotBefore -gt $now) { $q++; continue }
                $queue.RemoveAt($q)
                $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Post), ($BaseUrl + $job.Route)
                $request.Headers.TryAddWithoutValidation('Authorization', "Bearer $Secret") | Out-Null
                $request.Content = New-Object System.Net.Http.StringContent ($job.Body, [Text.Encoding]::UTF8, 'application/json')
                $job.Attempt++
                $inflight.Add(@{ Job = $job; Task = $client.SendAsync($request); Request = $request })
            }
            if (-not $inflight.Count) { Start-Sleep -Milliseconds 200; continue }
            $tasks = [System.Threading.Tasks.Task[]]@($inflight | ForEach-Object { $_.Task })
            [void][System.Threading.Tasks.Task]::WaitAny($tasks, 1000)
            foreach ($entry in @($inflight | Where-Object { $_.Task.IsCompleted })) {
                [void]$inflight.Remove($entry)
                $job = $entry.Job; $st = $state[$job.Group]
                $code = 0; $body = ''; $transient = $true
                if ($entry.Task.Status -eq 'RanToCompletion') {
                    $response = $entry.Task.Result
                    $code = [int]$response.StatusCode
                    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                    $response.Dispose()
                    $transient = ($code -eq 429 -or $code -ge 500)
                } elseif ($entry.Task.Exception) { $body = $entry.Task.Exception.GetBaseException().Message }
                else { $body = 'request timed out' }
                $entry.Request.Dispose()
                if ($code -ge 200 -and $code -lt 300) {
                    $sent++
                    if ($job.Final) { $st.Done = $true; & $Log ("  {0}: published {1} rows" -f $job.Group, $st.Group.Rows) }
                    else { $st.Remaining--; if ($st.Remaining -eq 0) { $queue.Add(@{ Group = $job.Group; Route = $job.Route; Body = $st.Group.Completion; Attempt = 0; NotBefore = [datetime]::MinValue; Final = $true }) } }
                    continue
                }
                if ($transient -and $job.Attempt -lt $MaxAttempts) {
                    $job.NotBefore = [datetime]::UtcNow.AddSeconds([Math]::Min(30, [Math]::Pow(2, $job.Attempt)))
                    $queue.Add($job); continue
                }
                $message = "{0} upload failed (HTTP {1}): {2}" -f $job.Group, $code, ($body -replace '\s+', ' ').Substring(0, [Math]::Min(300, ($body -replace '\s+', ' ').Length))
                if ($st.Group.Optional) { $st.Failed = $true; & $Log "  WARNING $message (deploy the updated Worker to enable this dataset)"; continue }
                throw $message
            }
        }
    } finally {
        foreach ($entry in $inflight) { try { $entry.Task.Wait(5000) | Out-Null } catch {} }
        $client.Dispose()
    }
    $summary = [ordered]@{}; foreach ($g in $Groups) { $summary[$g.Name] = if ($state[$g.Name].Done) { $g.Rows } else { 'skipped' } }
    return [pscustomobject]@{ Requests = $sent; Datasets = $summary }
}

Export-ModuleMember -Function Assert-ReadOnlySql, Get-AmulQueries, Read-AmulDatasets, Resolve-TailnetAddress, ConvertFrom-CredentialText, Protect-Text, Unprotect-TextFile,
New-AmulConnectionString, Test-AmulLogin, ConvertTo-Paise, ConvertTo-SafePhone, Get-ProductCategory, Get-PriceMap, ConvertTo-InventoryItems, ConvertTo-RouteItems,
ConvertTo-CustomerRouteItems, ConvertTo-InvoiceItems, ConvertTo-CustomerItems, ConvertTo-D1Payload, New-UploadPlan, Send-UploadPlan
