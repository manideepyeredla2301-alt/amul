#requires -Version 5.1
# Offline tests: no SQL Server or Cloudflare access. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File connector\test\connector.tests.ps1
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\AmulD1Connector.psm1') -Force
$script:failures = 0; $script:passes = 0
function It([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passes++; Write-Host "  ok   $Name" -ForegroundColor Green }
    catch { $script:failures++; Write-Host "  FAIL $Name :: $($_.Exception.Message)" -ForegroundColor Red }
}
function Assert-Equal($Expected, $Actual, [string]$What = 'value') { if ($Expected -ne $Actual) { throw "$What expected <$Expected> got <$Actual>" } }
function Assert-Throws([scriptblock]$Body) { $threw = $false; try { & $Body } catch { $threw = $true }; if (-not $threw) { throw 'expected an exception' } }

Write-Host 'Read-only guard'
It 'allows every fixed query' { foreach ($q in (Get-AmulQueries).Values) { Assert-ReadOnlySql $q } }
It 'rejects writes, batches and procedures' {
    foreach ($bad in 'UPDATE dbo.SalesInvoice SET SalNetAmt=0', 'SELECT 1; DELETE FROM dbo.Retailer', 'SELECT * INTO x FROM dbo.Retailer',
        'EXEC sp_who', 'SELECT 1 -- x', 'SELECT * FROM OPENROWSET(1)', '  DROP TABLE dbo.Product', 'SELECT 1 WAITFOR DELAY 1') { Assert-Throws { Assert-ReadOnlySql $bad } }
}
It 'invoice query is scoped by start date parameter' { if ((Get-AmulQueries).invoices -notmatch 'SalInvDate >= @startDate') { throw 'unscoped' } }
It 'route query takes the entire route master' { Assert-Equal 'SELECT * FROM dbo.RouteMaster' (Get-AmulQueries).routes }

Write-Host 'Credentials + Tailscale'
It 'parses the desktop credential file format' {
    $c = ConvertFrom-CredentialText 'Server: DESKTOP-IVHRL9V\SQLEXPRESSAMUL Database: 0002018303_GVR ENTERPRISES Username: sa Password: secret1'
    Assert-Equal 'DESKTOP-IVHRL9V' $c.Host; Assert-Equal 'SQLEXPRESSAMUL' $c.Instance; Assert-Equal '0002018303_GVR ENTERPRISES' $c.Database
    Assert-Equal 'sa' $c.User; Assert-Equal 'secret1' $c.Password
}
$tsJson = '{"BackendState":"Running","Self":{"HostName":"DESKTOP-IVHRL9V","DNSName":"desktop-ivhrl9v.tail1.ts.net.","TailscaleIPs":["100.105.240.98","fd7a::1"],"Online":true},"Peer":{"k1":{"HostName":"manideep-pc","DNSName":"manideep-pc.tail1.ts.net.","TailscaleIPs":["100.74.222.99"],"Online":false}}}'
It 'resolves a tailnet host to its IPv4 address' { Assert-Equal '100.105.240.98' (Resolve-TailnetAddress 'desktop-ivhrl9v' -StatusJson $tsJson) }
It 'refuses offline peers' { Assert-Throws { Resolve-TailnetAddress 'manideep-pc' -StatusJson $tsJson } }
It 'connection string is read-only intent over instance name' {
    $cs = New-AmulConnectionString -Address '100.105.240.98' -Instance 'SQLEXPRESSAMUL' -Database 'db' -User 'u' -Password 'p'
    if ($cs -notmatch 'ApplicationIntent=ReadOnly' -or $cs -notmatch '100\.105\.240\.98\\SQLEXPRESSAMUL') { throw $cs }
}

Write-Host 'Transforms'
$data = @{
    products = @(@{ PrdId = 1; PrdDCode = 'ICCUVAN101'; PrdName = 'Vanilla Cup 100 ml'; PrdStatus = 1 }, @{ PrdId = 2; PrdDCode = 'X'; PrdName = 'Old Stick'; PrdStatus = 0 })
    batches = @(@{ PrdId = 1; PrdBatId = 10; DefaultPriceId = 100 }, @{ PrdId = 1; PrdBatId = 11; DefaultPriceId = 101 })
    stock = @(@{ PrdId = 1; PrdBatID = 10; LcnId = 1; PrdBatLcnSih = '12.000' }, @{ PrdId = 1; PrdBatID = 11; LcnId = 1; PrdBatLcnSih = '3' })
    prices = @(@{ PriceId = 100; BatchSeqId = 1; SLNo = 1; PrdBatDetailValue = '25.00' }, @{ PriceId = 100; BatchSeqId = 1; SLNo = 3; PrdBatDetailValue = '21.455' }, @{ PriceId = 100; BatchSeqId = 1; SLNo = 2; PrdBatDetailValue = '19.00' })
    # Real Amul layout: List Price (purchase cost) sits before Selling Price and must never become the retailer rate.
    price_definitions = @(@{ SlNo = 1; BatchSeqId = 1; FieldDesc = 'MRP' }, @{ SlNo = 2; BatchSeqId = 1; FieldDesc = 'List Price' }, @{ SlNo = 3; BatchSeqId = 1; FieldDesc = 'Selling Price' })
    routes = @(@{ RMId = 7; RMCode = 'R7'; RMName = 'Gachibowli'; RMstatus = 1; Deleted = $false; RMMon = 1; RMThu = 'Y'; RMFri = 0 },
        @{ RMId = 8; RMCode = 'R8'; RMName = 'Closed route'; RMstatus = 0; Deleted = $false })
    customer_routes = @(@{ RtrId = 50; RMId = 7 }, @{ RtrId = 51; RMId = 7 }, @{ RtrId = 51; RMId = 8 })
    customers = @(@{ RtrId = 50; RtrCode = 'C50'; RtrName = 'Sri Sai Stores'; RtrPhoneNo = '09014003991'; RtrStatus = 1; RMId = 7; RtrCrLimit = '5000.00'; RtrCrDays = '7' },
        @{ RtrId = 51; RtrCode = 'C51'; RtrName = 'Bad Phone'; RtrPhoneNo = '123'; RtrStatus = 1; RMId = $null; Deleted = 1 })
    invoices = @(@{ SalId = 900; SalInvNo = 'INV900'; SalInvDate = '2026-09-09T10:00:00.000'; RtrId = 50; RMId = 7; SalNetAmt = '1000.50'; SalPayAmt = '200' },
        @{ SalId = 899; SalInvNo = 'INV899'; SalInvDate = '2026-09-08T23:59:00.000'; RtrId = 50; RMId = 7; SalNetAmt = '10'; SalPayAmt = '0' },
        @{ SalId = 901; SalInvNo = ''; SalInvDate = '2026-09-20T09:00:00.000'; SalDlvDate = '2026-09-21T00:00:00.000'; RtrId = 51; DlvRMId = 8; SalNetAmt = '50'; SalPayAmt = '80' })
}
$payload = ConvertTo-D1Payload -Data $data -MinDate '2026-09-09'
It 'money converts to paise with away-from-zero rounding' { Assert-Equal 2146 (ConvertTo-Paise '21.455'); Assert-Equal 100050 (ConvertTo-Paise '1000.50'); Assert-Equal 0 (ConvertTo-Paise $null) }
It 'inventory sums batch stock and takes batch prices' {
    $p = $payload.inventory | Where-Object { $_.product_id -eq 'AMUL:1' }
    Assert-Equal 15 $p.stock_qty; Assert-Equal 2500 $p.mrp_paise; Assert-Equal 2146 $p.selling_price_paise; Assert-Equal '100 ml Cups' $p.category; Assert-Equal $true $p.active
    Assert-Equal $false ($payload.inventory | Where-Object { $_.product_id -eq 'AMUL:2' }).active
}
It 'all routes are migrated, inactive ones flagged, with visit days and members' {
    Assert-Equal 2 @($payload.routes).Count
    $r7 = $payload.routes | Where-Object { $_.id -eq 'AMUL:7' }
    Assert-Equal 'Mon,Thu' $r7.visit_days; Assert-Equal 2 $r7.customer_count; Assert-Equal $true $r7.active
    Assert-Equal 'Gachibowli' $r7.details.RMName
    Assert-Equal $false ($payload.routes | Where-Object { $_.id -eq 'AMUL:8' }).active
}
It 'customer-route mapping is deduplicated' { Assert-Equal 3 @($payload.customer_routes).Count }
It 'invoices before Sep 9 are excluded' {
    Assert-Equal 2 @($payload.invoices).Count
    if ($payload.invoices | Where-Object { $_.invoice_date -lt '2026-09-09' }) { throw 'old invoice kept' }
}
It 'invoice amounts, status, due date and route' {
    $i = $payload.invoices | Where-Object { $_.id -eq 'AMUL:900' }
    Assert-Equal 100050 $i.total_paise; Assert-Equal 20000 $i.paid_paise; Assert-Equal 80050 $i.outstanding_paise; Assert-Equal 'PART_PAID' $i.payment_status
    Assert-Equal '2026-09-11' $i.due_date; Assert-Equal 'Gachibowli' $i.route_name; Assert-Equal '919014003991' $i.mobile
    $j = $payload.invoices | Where-Object { $_.id -eq 'AMUL:901' }
    Assert-Equal 'PAID' $j.payment_status; Assert-Equal 5000 $j.paid_paise; Assert-Equal '901' $j.invoice_number; Assert-Equal '2026-09-23' $j.due_date; Assert-Equal 'Closed route' $j.route_name
}
It 'customers get route, balance and safe phones' {
    $c = $payload.customers | Where-Object { $_.id -eq 'AMUL:50' }
    Assert-Equal 'AMUL:7' $c.route_id; Assert-Equal 'Gachibowli' $c.route_name; Assert-Equal 80050 $c.balance_paise; Assert-Equal 500000 $c.credit_limit_paise
    $d = $payload.customers | Where-Object { $_.id -eq 'AMUL:51' }
    Assert-Equal '' $d.mobile; Assert-Equal 'AMUL:7' $d.route_id; Assert-Equal $false $d.active
}

Write-Host 'Upload plan'
$plan = New-UploadPlan -Payload $payload -DeviceId 'amul-pc' -SnapshotId 'snap-1' -CapturedAt '2026-09-23T00:00:00Z' -MinDate '2026-09-09'
It 'invoice completion requests pruning before Sep 9' {
    $done = (($plan | Where-Object { $_.Name -eq 'invoices' }).Completion | ConvertFrom-Json)
    Assert-Equal $true $done.prune; Assert-Equal '2026-09-09' $done.min_date; Assert-Equal 0 @($done.items).Count
}
It 'refuses an empty inventory snapshot' { Assert-Throws { New-UploadPlan -Payload ([ordered]@{ inventory = @() }) -DeviceId d -SnapshotId s -CapturedAt c -MinDate '2026-09-09' } }

Write-Host 'Async uploader against a local mock Worker'
$port = Get-Random -Minimum 20000 -Maximum 40000
$log = [Collections.ArrayList]::Synchronized((New-Object Collections.ArrayList))
$server = [PowerShell]::Create()
[void]$server.AddScript({
    param($Port, $Log)
    $l = New-Object Net.HttpListener; $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start()
    $n = 0
    while ($l.IsListening) {
        $ctx = $l.GetContext(); $n++
        $body = (New-Object IO.StreamReader($ctx.Request.InputStream)).ReadToEnd()
        if ($ctx.Request.Url.AbsolutePath -eq '/stop') { $ctx.Response.Close(); $l.Stop(); break }
        $req = $body | ConvertFrom-Json
        $status = 200
        if ($ctx.Request.Headers['Authorization'] -ne 'Bearer test-secret') { $status = 401 }
        elseif ($req.dataset -eq 'customer_routes') { $status = 400 }
        elseif ($n % 4 -eq 0) { $status = 503 }
        if ($status -eq 200) { [void]$Log.Add(@{ path = $ctx.Request.Url.AbsolutePath; dataset = [string]$req.dataset; complete = [bool]$req.complete; items = @($req.items).Count }) }
        $bytes = [Text.Encoding]::UTF8.GetBytes('{"accepted":true}')
        $ctx.Response.StatusCode = $status; $ctx.Response.ContentType = 'application/json'; $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length); $ctx.Response.Close()
    }
}).AddArgument($port).AddArgument($log)
$handle = $server.BeginInvoke()
Start-Sleep -Milliseconds 500
try {
    $result = Send-UploadPlan -BaseUrl "http://127.0.0.1:$port" -Secret 'test-secret' -Groups $plan -MaxInFlight 4 -Log { param($m) }
    It 'every row arrives despite injected 503s' {
        $inv = @($log | Where-Object { $_.path -eq '/api/sync/snapshot' -and -not $_.complete } | ForEach-Object { $_.items } | Measure-Object -Sum).Sum
        Assert-Equal @($payload.inventory).Count $inv 'inventory rows'
        foreach ($name in 'routes', 'customers', 'invoices') {
            $rows = @($log | Where-Object { $_.dataset -eq $name -and -not $_.complete } | ForEach-Object { $_.items } | Measure-Object -Sum).Sum
            Assert-Equal @($payload[$name]).Count $rows "$name rows"
        }
    }
    It 'completion markers arrive after their data chunks, exactly once' {
        foreach ($name in 'routes', 'customers', 'invoices') {
            $entries = @($log | Where-Object { $_.dataset -eq $name })
            Assert-Equal 1 @($entries | Where-Object { $_.complete }).Count "$name completions"
            if (-not $entries[-1].complete) { throw "$name completion was not last" }
        }
    }
    It 'optional customer_routes failure (old Worker) does not abort the sync' { Assert-Equal 'skipped' $result.Datasets.customer_routes; Assert-Equal 2 $result.Datasets.invoices }
    It 'bad secret fails loudly' { Assert-Throws { Send-UploadPlan -BaseUrl "http://127.0.0.1:$port" -Secret 'wrong' -Groups @($plan | Where-Object { $_.Name -eq 'routes' }) -MaxAttempts 1 -Log { param($m) } } }
} finally {
    try { (New-Object Net.WebClient).DownloadString("http://127.0.0.1:$port/stop") | Out-Null } catch {}
    $server.EndInvoke($handle) | Out-Null; $server.Dispose()
}

# Large-volume plan: 5,000 invoices -> 125 chunks + completion
It 'chunks large datasets at 40 rows' {
    $many = [ordered]@{ inventory = @($payload.inventory); invoices = @(1..5000 | ForEach-Object { [ordered]@{ id = "AMUL:$_" } }) }
    $p = New-UploadPlan -Payload $many -DeviceId d -SnapshotId s -CapturedAt c -MinDate '2026-09-09'
    Assert-Equal 125 ($p | Where-Object { $_.Name -eq 'invoices' }).Chunks.Count
}

Write-Host ("{0} passed, {1} failed" -f $script:passes, $script:failures)
if ($script:failures) { exit 1 }
