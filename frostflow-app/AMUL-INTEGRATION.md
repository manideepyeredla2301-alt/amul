# Amul read-only background sync

Amul SQL Server owns Amul stock, prices, invoices, purchases and collections. The connector executes only fixed SELECT queries. It does not execute Amul procedures or post any transaction. Use a SELECT-only SQL account: ApplicationIntent is a routing hint, not a permission boundary.

SQLite's `amul_records` contains replaceable source copies. FrostFlow also materializes Amul products, inventory, retailers, routes, purchases and invoices into local working tables. Amul SQL remains read-only. Local POS sales from Amul synced items consume only the local FrostFlow copy and are reapplied after each sync, so they do not post back into Amul.

## Start

On this PC, double-click `FrostFlow-Desktop.bat` after closing the old FrostFlow server. It starts the local engine silently and opens FrostFlow in a desktop-style app window. The current desktop launcher uses the configured Amul read-only connection for this PC.

For troubleshooting, stop the older FrostFlow server, then run `scripts/start-amul.ps1` from Windows PowerShell 5.1 or PowerShell 7 with Node 24 on PATH (or packaged runtime/node.exe for Node). Normal start without Amul leaves sync disabled and the existing cache readable. The connector does not change the machine-wide Windows execution policy.

The default source is tcp:192.168.0.106,57868 / 0002018303_GVR ENTERPRISES. Override the script's Server and Database parameters if needed. The connector keeps SQL encryption enabled and trusts the server certificate for this LAN SQL Server because the installed SQL certificate is not chained to a Windows-trusted authority. Passwords exist only in process memory/environment; protect this Windows account and local database/backups, which contain business records.

## Refresh behavior

The first valid sync imports sales and purchases from 2026-09-08 onward, plus the current Amul masters needed to understand those records. The start date can be changed with `FROSTFLOW_AMUL_START_DATE=yyyy-MM-dd` before the first scoped import. After a successful sync, the connector stores the Amul SQL Server timestamp captured at the beginning of that read. Later manual and background syncs send that source checkpoint back to SQL Server and fetch changed sales and purchases using `LastModDate` / `AuthDate` with a two-day overlap. Changed headers and all of their lines replace the copied local rows by Amul source ID. Customer, route, address, salesperson, product, stock, price and receipt masters are refreshed as replaceable current copies.

Background refresh repeats five minutes after completion. Failures back off to 40 minutes. A manual refresh is available. Overlapping requests share one job. Failed or oversized reads preserve the previous cache. Last-success, sync mode, source checkpoint and stale/error indicators remain visible offline. Shutdown waits for the bounded read to finish.

Source tables are read sequentially at READ COMMITTED, not as one SQL snapshot. Do not treat cross-table cache totals as reconciled accounts. There is no NOLOCK or source-side schema change. Each SELECT has a 20-second command timeout and five-second lock timeout; the child process has a ten-minute bound. Records stream in batches of 1,000 into a separate SQLite run. A single atomic pointer change makes the completed run visible. Old or failed staging rows are removed in small batches. The browser requests 50 rows per page, with server-side search. There is no 100,000-row history truncation. Pages exceeding 8 MB fail safely. Because hard deletions and backdated edits can be missed when the source does not update modification timestamps, schedule an occasional full scoped refresh before relying on formal accounts.

The prices dataset contains default prices for batches with nonzero stock (saleable, unsaleable, or free). It intentionally excludes obsolete and zero-stock price history. Invoice and purchase lines retain their original source price fields. No price interpretation is assumed from numeric codes.

## Included and pending

Included: product, batch, stock, price-definition, UOM, customer, route, customer-route, shipping-address, salesperson, supplier, sales header/line, purchase header/line, receipt and receipt-allocation browser with search and paging. Synced Amul products appear in Products, Inventory and POS; synced Amul invoices appear in Sales/Invoices and retailer accounts with local payment-status edits. Monetary SQL decimals remain strings to avoid rounding during transport. Raw status codes are intentionally preserved.

Pending: deeper cancellation/delivery status mapping, formal GST reconciliation, formatted Amul invoice printing, and Amul Excel exports.
