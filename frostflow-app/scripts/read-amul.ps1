$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$connection = $null
$stage = 'connection'
try {
    $startDateText = if ($env:FROSTFLOW_AMUL_START_DATE) { $env:FROSTFLOW_AMUL_START_DATE } else { '2026-09-08' }
    $sinceText = if ($env:FROSTFLOW_AMUL_SINCE) { $env:FROSTFLOW_AMUL_SINCE } else { $null }
    $startDate = [DateTime]::ParseExact($startDateText, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    $sinceDate = if ($sinceText) { [DateTime]::Parse($sinceText, [Globalization.CultureInfo]::InvariantCulture) } else { $null }
    $options = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
    $options['Data Source'] = $env:FROSTFLOW_AMUL_SERVER
    $options['Initial Catalog'] = $env:FROSTFLOW_AMUL_DATABASE
    $options['User ID'] = $env:FROSTFLOW_AMUL_USER
    $options['Password'] = $env:FROSTFLOW_AMUL_PASSWORD
    $options['Encrypt'] = $true
    $trustServerCertificate = if ($env:FROSTFLOW_AMUL_TRUST_SERVER_CERTIFICATE) { $env:FROSTFLOW_AMUL_TRUST_SERVER_CERTIFICATE } else { '1' }
    $options['TrustServerCertificate'] = @('1','true','yes','on') -contains $trustServerCertificate.ToLowerInvariant()
    $options['ApplicationIntent'] = 'ReadOnly'
    $options['Application Name'] = 'FrostFlow read-only sync'
    $options['Connect Timeout'] = 8
    $connection = [System.Data.SqlClient.SqlConnection]::new($options.ConnectionString)
    $connection.Open()
    $clock = $connection.CreateCommand()
    $clock.CommandTimeout = 20
    $clock.CommandText = 'SET LOCK_TIMEOUT 5000; SELECT CONVERT(varchar(23), GETDATE(), 121)'
    $sourceCheckpoint = [string]$clock.ExecuteScalar()
    $clock.Dispose()
    @{dataset='__metadata';rows=@(@{start_date=$startDateText;since=$sinceText;source_checkpoint=$sourceCheckpoint});complete=$true} | ConvertTo-Json -Depth 6 -Compress

    # Fixed projections only. No caller SQL, procedures, writes, or credential tables.
    $queries = [ordered]@{
        products = 'PrdId,PrdDCode,PrdCCode,PrdName,EANCode,UomGroupId,TaxGroupId,PrdStatus'
        batches = 'PrdId,PrdBatId,PrdBatCode,MnfDate,ExpDate,Status,BatchSeqId,DefaultPriceId'
        stock = 'PrdId,PrdBatID,LcnId,PrdBatLcnSih,PrdBatLcnUih,PrdBatLcnFre,PrdBatLcnRessih,PrdBatLcnResUih,PrdBatLcnResFre'
        prices = 'PriceId,PrdBatId,PriceCode,BatchSeqId,SLNo,PrdBatDetailValue,DefaultPrice,PriceStatus'
        price_definitions = 'SlNo,BatchSeqId,RefCode,FieldDesc,Calculation,MRP,ListPrice,SelRte,ClmRte'
        units = 'UomGroupId,UomGroupCode,UomId,BaseUom,ConversionFactor'
        customers = 'RtrId,RtrCode,RtrName,RtrAdd1,RtrAdd2,RtrAdd3,RtrPinNo,RtrPhoneNo,RtrEmailId,RtrContactPerson,RtrStatus,RtrTaxable,RtrTaxType,RtrTINNo,RtrCSTNo,RtrCrBills,RtrCrLimit,RtrCrDays,GeoMainId,RMId,RtrShipId,TaxGroupId,RtrResPhone1,RtrOffPhone1,RtrRemark1,RtrOnAcc,RtrType,RtrPayment,RtrStdCode,RtrPanNo,Deleted,LastModDate,AuthDate'
        routes = 'RMId,RMCode,RMName,CmpId,RMDistance,RMPopulation,RMVanRoute,RMSRouteType,RMLocalUpcountry,RMMon,RMTue,RMWed,RMThu,RMSat,RMSun,RMstatus,Deleted,LastModDate,AuthDate'
        customer_routes = 'RtrId,RMId,Availability,LastModBy,LastModDate,AuthDate'
        customer_addresses = 'RtrShipId,RtrId,RtrShipAdd1,RtrShipAdd2,RtrShipAdd3,RtrShipPinNo,RtrShipPhoneNo,RtrShipDefaultAdd,TaxGroupId,StateId,GSTTinNo,Availability,LastModDate,AuthDate'
        salespeople = 'SMId,SMCode,SMName,SMPhoneNumber,SMEmailID,SMOtherDetails,SMCreditDays,CmpId,SalesForceMainId,Status,Deleted,VanSales,LastModDate,AuthDate'
        suppliers = 'SpmId,SpmCode,SpmName,SpmPhone'
        invoices = 'SalId,SalInvNo,SalInvDate,RtrId,LcnId,SMId,RMId,DlvRMId,RtrShipId,GSTIN,SalGrossAmount,SalTaxAmount,SalNetAmt,SalPayAmt,CRAdjAmount,DBAdjAmount,MarketRetAmount,OnAccountAmount,DlvSts,SalDlvDate,LastModDate,AuthDate'
        invoice_lines = 'SalId,SlNo,PrdId,PrdBatId,BaseQty,SalSchFreeQty,SalManFreeQty,PrdUnitMRP,PrdUnitSelRate,PrdTaxAmount,PrdNetAmount,ReturnedQty,ReturnedManFreeQty,PriceId,LastModDate,AuthDate'
        purchases = 'PurRcptId,PurRcptRefNo,SpmId,CmpInvNo,InvDate,GoodsRcvdDate,LcnId,NetAmount,TaxAmount,PaidAmount,Status,PaidStatus,CrAdjustAmt,DbAdjustAmt,LastModDate,AuthDate'
        purchase_lines = 'PurRcptId,PrdSlNo,PrdId,PrdBatId,RcvdGoodBaseQty,UnSalBaseQty,InvBaseQty,PrdUnitMRP,PrdUnitLSP,PrdUnitNetRate,PrdNetAmount,PrdTaxAmount,PriceId,LastModDate,AuthDate'
        receipts = 'InvRcpNo,InvRcpDate,InvRcpAmt,CollectedMode,InvCollectedDate,RcpType'
        receipt_allocations = 'InvRcpNo,InvRcpSno,SalId,SalInvRefNo,InvInsAmt,InvRcpMode,InvInsSta,CancelStatus,ExcessFlag,CancelDate'
    }
    $tables = @{
        products='Product'; batches='ProductBatch'; stock='ProductBatchLocation'; prices='ProductBatchDetails'
        price_definitions='BatchCreation'; units='UomGroup'; customers='Retailer'; routes='RouteMaster'
        customer_routes='RetailerMarket'; customer_addresses='RetailerShipAdd'; salespeople='Salesman'; suppliers='Supplier'
        invoices='SalesInvoice'; invoice_lines='SalesInvoiceProduct'; purchases='PurchaseReceipt'
        purchase_lines='PurchaseReceiptProduct'; receipts='Receipt'; receipt_allocations='ReceiptInvoice'
    }
    $salesScope = ' WHERE SalInvDate >= @startDate'
    $purchaseScope = ' WHERE InvDate >= @startDate'
    if ($sinceDate) {
        $salesScope += ' AND (LastModDate >= DATEADD(day,-2,@sinceDate) OR AuthDate >= DATEADD(day,-2,@sinceDate) OR LastModDate IS NULL OR EXISTS (SELECT 1 FROM dbo.SalesInvoiceProduct d WHERE d.SalId=dbo.SalesInvoice.SalId AND (d.LastModDate >= DATEADD(day,-2,@sinceDate) OR d.AuthDate >= DATEADD(day,-2,@sinceDate) OR d.LastModDate IS NULL)))'
        $purchaseScope += ' AND (LastModDate >= DATEADD(day,-2,@sinceDate) OR AuthDate >= DATEADD(day,-2,@sinceDate) OR LastModDate IS NULL OR EXISTS (SELECT 1 FROM dbo.PurchaseReceiptProduct d WHERE d.PurRcptId=dbo.PurchaseReceipt.PurRcptId AND (d.LastModDate >= DATEADD(day,-2,@sinceDate) OR d.AuthDate >= DATEADD(day,-2,@sinceDate) OR d.LastModDate IS NULL)))'
    }
    foreach ($name in $queries.Keys) {
        $stage = $name
        $command = $connection.CreateCommand()
        $command.CommandTimeout = 20
        $command.CommandText = 'SET LOCK_TIMEOUT 5000; SELECT ' + $queries[$name] + ' FROM [dbo].[' + $tables[$name] + ']'
        if ($name -eq 'prices') {
            $command.CommandText += ' WHERE PriceId IN (SELECT b.DefaultPriceId FROM dbo.ProductBatch b WHERE EXISTS (SELECT 1 FROM dbo.ProductBatchLocation l WHERE l.PrdBatID=b.PrdBatId AND (l.PrdBatLcnSih<>0 OR l.PrdBatLcnUih<>0 OR l.PrdBatLcnFre<>0)))'
        } elseif ($name -eq 'invoices') {
            $command.CommandText += $salesScope
        } elseif ($name -eq 'invoice_lines') {
            $command.CommandText += ' WHERE SalId IN (SELECT SalId FROM dbo.SalesInvoice' + $salesScope + ')'
        } elseif ($name -eq 'purchases') {
            $command.CommandText += $purchaseScope
        } elseif ($name -eq 'purchase_lines') {
            $command.CommandText += ' WHERE PurRcptId IN (SELECT PurRcptId FROM dbo.PurchaseReceipt' + $purchaseScope + ')'
        }
        if ($command.CommandText.Contains('@startDate')) {
            [void]$command.Parameters.Add('@startDate', [Data.SqlDbType]::DateTime)
            $command.Parameters['@startDate'].Value = $startDate
        }
        if ($command.CommandText.Contains('@sinceDate')) {
            [void]$command.Parameters.Add('@sinceDate', [Data.SqlDbType]::DateTime)
            $command.Parameters['@sinceDate'].Value = $sinceDate
        }
        $reader = $command.ExecuteReader()
        $rows = [Collections.Generic.List[object]]::new()
        while ($reader.Read()) {
            $row = [ordered]@{}
            for ($i=0; $i -lt $reader.FieldCount; $i++) {
                $value = $reader.GetValue($i)
                if ($value -is [DBNull]) { $value = $null }
                elseif ($value -is [DateTime]) { $value = $value.ToString('yyyy-MM-ddTHH:mm:ss.fff') }
                elseif ($value -is [decimal]) { $value = $value.ToString([Globalization.CultureInfo]::InvariantCulture) }
                $row[$reader.GetName($i)] = $value
            }
            $rows.Add($row)
            if ($rows.Count -ge 1000) {
                @{dataset=$name;rows=$rows.ToArray();complete=$false} | ConvertTo-Json -Depth 6 -Compress
                $rows.Clear()
            }
        }
        $reader.Close()
        $command.Dispose()
        @{dataset=$name;rows=$rows.ToArray();complete=$true} | ConvertTo-Json -Depth 6 -Compress
    }
} catch {
    # Never emit connection strings or credentials.
    $safeMessage = $_.Exception.GetBaseException().Message
    if ($env:FROSTFLOW_AMUL_PASSWORD) { $safeMessage = $safeMessage.Replace($env:FROSTFLOW_AMUL_PASSWORD, '[redacted]') }
    [Console]::Error.WriteLine('Amul read failed at ' + $stage + ': ' + $safeMessage)
    exit 1
} finally {
    if ($connection) { $connection.Dispose() }
    Remove-Item Env:FROSTFLOW_AMUL_PASSWORD -ErrorAction SilentlyContinue
}
