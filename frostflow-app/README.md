# FrostFlow ERP

FrostFlow is an offline-first Windows ERP foundation for a single-PC Indian ice-cream distributor and retail counter. It uses only Node.js built-ins: a local SQLite database, a local HTTP service, and a browser-based desktop workspace. No cloud account or internet connection is needed for core work.

## Run locally

1. Ensure Node.js 24+ is installed.
2. Double-click `start-frostflow.bat`, or run `node server.js` from this folder.
3. Open `http://127.0.0.1:4317` if it did not open automatically.

The local database is created at `data/frostflow.sqlite`. Backups are written to `data/backups/`. Copy this folder to a safe external drive as part of the daily close.

## Included workflow

- Product catalogue with HSN/GST, stock threshold, batch and expiry details.
- Single shared inventory ledger for purchases, distribution invoices, POS sales, returns, write-offs, and corrections.
- FEFO allocation (earliest non-expired batch first) with stock validation inside the database transaction.
- Retail POS with split payment, tax invoice, receipt number, and instant inventory deduction.
- Distribution orders, delivery-to-invoice workflow, customer credit days, receivables and overdue status.
- Purchases, supplier balance, expense log, customer payments, stock alerts, GST summary, audit trail, and local backups.
- Monetary data is persisted in paise (integers), not floating-point values. Posted documents are never silently edited; corrections use a documented reversal/return flow.

## Boundaries for the first delivery

This is a functioning single-PC local foundation, not a replacement for a CA-reviewed accounting product. Before live use, configure tax rates, company details, document numbering, users/roles, printer settings, payment accounts, and WhatsApp provider credentials. GST filings and e-invoicing need validation against the rules and services applicable at deployment time.

## Architecture and migration path

`public/` is the presentation layer. `src/services/erp-service.js` contains application workflows and transaction rules. `src/db.js` owns the relational schema and access helpers. `server.js` exposes a narrow local API.

The service is intentionally separate from the UI: Electron/Tauri can host the same local API, and the repository layer can be exchanged for PostgreSQL when LAN, multi-user, mobile, or cloud deployment is needed. SQLite is configured with WAL and foreign keys for durable single-machine operation.
