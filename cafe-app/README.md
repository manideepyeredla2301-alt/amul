# Amul Ice Cream & Café on FrostFlow

The café runs as the `frostflow-cafe` Cloudflare Worker in the existing FrostFlow account. It shares the `frostflow-online` D1 database, uses only `cafe_` tables, and has a separate `cafe_migrations` history. The existing FrostFlow ERP Worker is not changed by this project.

## Open the system

| Page | Purpose |
| --- | --- |
| `/` | Customer menu, QR context, cart, checkout, tracking, reorder |
| `/pos/` | Tablet and retail counter orders, payment records, receipts |
| `/kitchen/` | Live prepared-food queue and cook instructions |
| `/admin/` | Owner catalogue, stock, reports, staff, offers, settings |
| `/kitchen/qr.html` | Managed and printable QR cards |

All five pages use the same database-backed API. New QR orders have an active managed QR ID. Staff POS orders do not need a QR code. Retail-only transactions complete without a kitchen ticket; a promotional free prepared item still creates a kitchen ticket. Customer checkout never collects money or marks a payment complete. Cash, UPI, and card are recorded manually by staff after the payment happens outside the site.

The seed migration imports the 68 finalized café products and prices, including ₹90 veg and ₹120 chicken burgers with an optional ₹10 cheese slice. It creates empty retail categories without inventing packaged SKUs or stock. Every café product has a distinct original photo at `public/images/products/<product-id>.jpg` and editable preparation steps. Uploaded replacement photos are cropped in the admin browser and persisted in D1 as image BLOBs because R2 is not enabled on this account. The upload limit is 1 MB when stored in D1. Admin bulk import accepts CSV and `.xlsx` Excel files.

## Code and storage

- `src/platform*.js`: authenticated API, catalogue pricing, orders, POS, kitchen events, payments, inventory, reports, staff, offers, and QR codes.
- `migrations/20261124_cafe_platform*.sql`: additive schema and editable seed data. Earlier café migrations remain in place.
- `src/prep.json`: initial cook instructions. The database copy can be edited in Admin → Products without a deployment.
- `public/`: customer, POS, kitchen, and admin pages and generated product photos.
- `test/pricing.test.js`: price tests.
- `test/platform.integration.mjs`: isolated local API journey covering ordering, stock, payment, staff, and promotion cases.

## Local checks

Use Node 24 or later from this directory. Keep local secrets in an ignored `.dev.vars` file. Set `CAFE_ADMIN_USER`, `CAFE_ADMIN_PASSWORD`, and a random `CAFE_SESSION_SECRET` of at least 32 characters there. Do not use production passwords in tests or commit them.

```sh
npm ci
npx wrangler d1 migrations apply frostflow-online --local
npm run check
npm run dev -- --port 8790
```

Run the integration journey against a **disposable local D1 database**, never production:

```sh
CAFE_TEST_PASSWORD='<local test password>' npm run check:integration
```

It uses `http://localhost:8790` by default; override with `CAFE_TEST_BASE_URL`. The test creates orders, products, a cashier, payments, returns, and refunds.

See `docs/owner-guide.md`, `docs/staff-guide.md`, `docs/technical-assessment.md`, and `docs/deployment-rollback.md` for operation and deployment.
