# FrostFlow migration handoff — 23 September 2026

## User intent and safety boundaries

Cloudflare is intended to replace the local FrostFlow ERP as the operational source of truth. Preserve custom local invoices and all business history. The latest instruction was to migrate the existing local data, superseding the earlier September-only filter. Amul SQL must remain **read-only**. Do not retire the local app until full reconciliation and feature parity are verified. Never commit databases, SQL data exports, customer details or credentials to this public repository.

## Verified deployed state

- Worker: https://frostflow-online.manideepyeredla2301.workers.dev
- Latest deployment from this work: `21ef9645-5c82-4cd5-b7aa-b51fc5dd4fdf`.
- D1 binding and resource IDs are in `cloudflare-app/wrangler.jsonc`.
- Migration `0009_source_stock.sql` was applied remotely.
- `npm run check` in `cloudflare-app` passed all 8 tests, including the new SQLite stock-upsert regression test.
- Health endpoint returned healthy. Unsigned webhook POST returned 403. This is **not** an end-to-end Meta delivery test.
- No customer test messages were sent during this work.

## Data imported and preserved

The local SQLite database was backed up with SQLite's backup API and passed `PRAGMA quick_check`. The existing D1 database was exported before import. Import scripts validated generated statements against a local copy of the D1 export, including foreign keys.

1. Imported 2 custom LOCAL invoices, 2 lines, their referenced products and customer; combined invoice value 46,300 paise. Imported stock was not deducted again.
2. Added 3,472 product records, 233 customers, 15 routes, 2 distribution orders and 47 non-deleted Amul invoice headers. The source contained 70 Amul invoice rows, including locally deleted records; those were not all exposed as active invoices.
3. Added `local_migration_archive` with 1,909 source rows, including invoice lines, ledger entries, adjustments and message history. Its schema is `(source_table TEXT, row_key TEXT, payload TEXT, imported_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_table,row_key))`. This archive is **not a fully operational online ledger**.
4. Verification showed 3,609 inventory records and 234 customers. Existing 9 cloud orders and 93 WhatsApp events remained intact. Existing cloud invoice was retained alongside imported invoices.

Imports were additive: overlapping records were preserved, not reconciled or overwritten. Product duplicates across LOCAL, AMUL and catalogue seed namespaces remain a potential issue. Counts alone do not establish accounting/stock parity.

## Code changes in this commit

- Amul invoice detail falls back to archived source lines when normalized online lines are absent. Source tax amounts are displayed instead of fabricating GST percentages. Quantities are explicitly labelled base stock units; packing conversions still need integration.
- Webhook stores all statement batches rather than silently truncating after the first 50. Event IDs provide retry deduplication. Actual Meta callback/subscription and incoming-message delivery still need verification.
- Sync rejects non-AMUL IDs. Existing stock, reservations, price, active status and ownership are preserved. Incoming stock is recorded in `source_stock_qty`/`source_stock_seen_at` on existing rows. New products still receive their initial source stock.
- Existing business records are skipped by sync to avoid replacing cloud edits/balances. This is a conservative guard, **not completed incremental reconciliation**. Upstream changes to existing customers/invoices will currently not be applied.
- Missing rows no longer deactivate existing cloud inventory/customers/routes.
- Bridge route query supports local schemas without `amul_routes.local_deleted`.

## Connector and credential status

Cloudflare Wrangler OAuth authorization is working on the current Windows PC. User authorized rotating `SYNC_SECRET`: a fresh random key was uploaded and successfully authenticated against the read-only sync orders endpoint. It is stored with Windows DPAPI at `frostflow-app/data/.cloud-sync-secret` in the working checkout, not in Git. Other connectors using the previous key need updating.

No automatic sync task was enabled. No saved `cloud-sync.json`/SQL password was found in the inspected connector directory. User provided an SQL password privately in the conversation; do not put it into source/docs/logs. Securely configure the connector rather than repeatedly asking for it in chat. SQL TCP endpoint was reachable during the last check; actual SQL authentication and schema read still need testing.

**Do not run the existing bulk connector unchanged:** it still emits LOCAL rows (now rejected by server), may acknowledge downloaded orders into a bridge cache, and may fetch invoice jobs. Amul writes remain prohibited. The connector should send only AMUL observations and preserve cloud-created data; it must also import/upsert invoice line detail rather than only headers.

## Required next work

1. Reconcile duplicate products and opening/current stock, invoices, tax, customer balances and source payment tracking. Do not infer pack conversions or tax rates from names/rounded values.
2. Implement versioned/retry-safe reconciliation for existing Amul records. Current preservation guards intentionally prevent updates. Prevent check-then-upsert races and stale/out-of-order snapshot replacement before enabling concurrent sync.
3. Extend normal invoice/ledger/purchase/return/expense APIs and UI to use migrated records; archive storage alone is not feature parity. POS history also remains archived rather than fully normalized.
4. Configure a dedicated read-only Amul bridge on a PC with network access, encrypted credentials and a separate replaceable cache. Correct its dataset filtering and failure exit handling, test one complete run, then enable scheduling. Do not reuse the original business DB as a disposable cache.
5. Verify real incoming Meta events, persisted messages, delivery statuses and order creation without sending unsolicited customer messages. Cloud secrets exist but were not read back. Use current configured phone ID rather than stale IDs from earlier conversation.
6. Test financial totals, stock consumption, payments, Excel workflows, print/barcode support and other local features online. Only declare cutover complete after reconciliation and a restore test.

## Local-only recovery artifacts (not committed)

Original workspace: `C:/Users/manid/Documents/Codex/2026-09-10/master-prompt-ice-cream-distribution-retail`.

- Original DB: `data/frostflow.sqlite` (left intact).
- Backup: `data/backups/pre-cloud-migration-1790181189613.sqlite`.
- Cloud exports: `work/cloud-before-local-import.sql`, `work/cloud-current.sql`.
- Import preparation/audit scripts: `scripts/audit-cloud-migration.js`, `scripts/prepare-custom-invoice-import.js`, `scripts/prepare-business-import.js`.
- Key rotation helper: `scripts/rotate-cloud-sync-key.ps1`.
- Generated SQL imports: `work/custom-invoice-import.sql`, `work/business-import.sql`.

These import helpers are one-off and intentionally fail on some overlaps. Do not blindly rerun after import. Secure local artifacts contain private business data and must remain outside Git.
