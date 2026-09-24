# Amul → Cloudflare D1 connector

A PowerShell 5.1 connector that syncs the Amul SQL Server database into the
central Cloudflare D1 database. It doesn't need Node.js or the SQLite cache.

- **Transport:** the SQL host is looked up in the tailnet through `tailscale status --json`
  (default `desktop-ivhrl9v\SQLEXPRESSAMUL`) and reached on its `100.x` address.
- **Read-only Amul:** only fixed `SELECT` projections are sent, and a guard rejects
  anything else (writes, `EXEC`, `INTO`, batches, comments). Each read uses
  `ApplicationIntent=ReadOnly` and runs inside a transaction that is always rolled back.
- **Async:** the source tables are read in parallel runspaces, each on its own session
  (at most 3 at once). Uploads are asynchronous `HttpClient` requests with up to 4 in flight.
  All datasets upload at the same time. On a 429 or 5xx response a chunk is retried with
  exponential backoff. A dataset's completion marker is sent only after all its chunks succeed.
- **Scope:**
  - products and stock
  - **every route** in `RouteMaster`, with the full source row, visit days and member count.
    Inactive routes are flagged, not dropped.
  - the retailer↔route map
  - all retailers
  - **invoices dated 2026-09-09 or later** (`invoiceStartDate`). On completion, the Worker
    hides (sets `deleted_at` on, never deletes) Amul invoices dated before that.
- **Cloud edits are protected:** the Worker only adds new records and records incoming
  Amul stock separately. It never overwrites existing customers, invoices, routes or product
  stock and prices, and it never deactivates rows missing from a snapshot. The exceptions are
  Amul-only route fields (visit days, member count, source details) and the retailer↔route map.
- **Failure handling:** a failed read never uploads.

## Setup (once)

```powershell
cd frostflow-app
powershell -ExecutionPolicy Bypass -File connector\amul-d1-connector.ps1 -ImportCredentialFile "$env:USERPROFILE\Desktop\Stocky SQL credentials.txt"
```

This stores the password with Windows DPAPI in `data\.amul-sql-secret`, for the current
Windows user only. The Cloudflare sync secret is read from the existing
`data\.cloud-sync-secret`, which `Install-Cloud-Sync.bat` creates.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File connector\amul-d1-connector.ps1 -DryRun   # read only, writes data\amul-d1-preview.json
powershell -ExecutionPolicy Bypass -File connector\amul-d1-connector.ps1           # one sync
powershell -ExecutionPolicy Bypass -File connector\install-connector-task.ps1      # every 5 minutes
```

You can also double-click `Sync-Amul-To-Cloudflare.bat`.

## Worker deployment

The route details, the `customer_routes` map and the Sep 9 invoice window need the Worker
from this repo and migration `0009_amul_routes_invoice_scope.sql`, which is already applied
in production. Against an older Worker, `customer_routes` is skipped with a warning.
Always deploy from an up-to-date `git pull`, never from a downloaded copy.

## Recommended

The desktop credential is `sa`, a sysadmin login. The connector limits itself to
guarded SELECTs, but a dedicated `db_datareader` login is safer.

## Tests

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File connector\test\connector.tests.ps1
```

The tests run offline against fixtures and a local mock Worker.
