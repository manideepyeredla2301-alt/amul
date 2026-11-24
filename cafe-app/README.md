# Amul Ice Cream & Café on FrostFlow

The café runs as the `frostflow-cafe` Cloudflare Worker in the existing FrostFlow account. It shares the `frostflow-online` D1 database, uses only `cafe_` tables, and has a separate `cafe_migrations` history. The existing FrostFlow ERP Worker is not changed by this project.

## Open the system

Use one address for the whole café: `https://frostflow-cafe.manideepyeredla2301.workers.dev/`. The **Staff** link on the customer page opens the staff hub at `/staff/`, with links to the counter, kitchen, and owner controls.

| Page | Purpose |
| --- | --- |
| `/` | Customer menu, QR context, cart, checkout, tracking, reorder |
| `/staff/` | Staff entry to POS, kitchen, and owner controls |
| `/pos/` | Tablet and retail counter orders, payment records, receipts |
| `/kitchen/` | Live prepared-food queue and cook instructions |
| `/admin/` | Owner catalogue, stock, reports, staff, offers, settings |
| `/ads/` | Looping café commercial for a TV, plus the complete customer menu |
| `/kitchen/qr.html` | Managed and printable QR cards |

All pages use the same database-backed API. New QR orders have an active managed QR ID. Staff POS orders do not need a QR code. Retail-only transactions complete without a kitchen ticket; a promotional free prepared item still creates a kitchen ticket. Customer checkout never collects money or marks a payment complete. Cash, UPI, and card are recorded manually by staff after the payment happens outside the site. Checkout takes the customer's name and Indian mobile number. The POS **Billed orders** screen shows recent QR and counter orders, including paid and unpaid orders; **Held orders** shows saved carts separately. A bill can be opened, printed, or prepared as a WhatsApp message for staff to send manually.

The former `frostflow-pos` address redirects its page entries to the POS on the café address. Staff should use the café address above for a single sign-in and shared navigation. Deploy the legacy redirect with `npm run deploy:pos` when its Worker changes.

The seed migrations import 79 prepared café products and prices, including ₹90 veg and ₹120 chicken burgers with an optional ₹10 cheese slice. Eleven regular ice-cream scoops are sold at the listed cup prices, with a cone option for ₹10 extra; Pineapple is ₹40. Each scoop has its own blue-AMUL cup photo and cook steps. The retail migration adds 243 distinct products from FrostFlow's curated Amul catalogue to the staff POS, including all 167 listed packaged ice creams. Retail categories remain hidden from customer QR ordering. Current printed MRPs are used as price candidates; 45 products with missing or conflicting prices or pack details need owner review before sale. A separate opening-stock migration adds 20 pieces per packaged SKU (4,860 pieces total), with individual inventory movements and batches; café stock remains separate from FrostFlow distribution inventory. Batch expiry dates were not supplied. The 48 distinct matched source pack photos are included; other products show an image placeholder until an accurate photo is uploaded. Every prepared café product has a distinct original photo at `public/images/products/<product-id>.jpg` and editable preparation steps. Uploaded replacement photos are cropped in the admin browser and persisted in D1 as image BLOBs because R2 is not enabled on this account. The upload limit is 1 MB when stored in D1. Admin bulk import accepts CSV and `.xlsx` Excel files.

The `/ads/` display is designed for a 16:9 TV, with a 42-second loop when an offer is active (36 seconds without one), large text, natural cream and sage colours, and blue AMUL lettering. It shows all customer-visible menu categories and prices beneath the highlights. Playback, next/previous, and full-screen controls are on the display. It reloads the public menu and currently usable offers every five minutes; owner changes in Admin appear on the next refresh. The former POS site redirects `/ads` page visits to this canonical café address.

## Code and storage

- `src/platform*.js`: authenticated API, catalogue pricing, orders, POS, kitchen events, payments, inventory, reports, staff, offers, and QR codes.
- `migrations/20261124_cafe_platform*.sql` and `migrations/20261124_cafe_staff_checkout_contact.sql`: additive schema and editable seed data. Earlier café migrations remain in place.
- `src/prep.json`: initial cook instructions. The database copy can be edited in Admin → Products without a deployment.
- `public/`: customer, staff, POS, kitchen, and admin pages and generated product photos.
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
