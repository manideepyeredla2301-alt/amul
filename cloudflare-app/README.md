# FrostFlow Online

This Cloudflare Worker keeps the catalogue, inventory, customers, routes,
distribution orders, invoices, payments and WhatsApp activity online when the
Amul Windows PC is unavailable. Cloudflare D1 stores controlled snapshots. The
Windows sync agent pushes up to 40 records per request and imports queued online
orders into the existing local order inbox when the PC reconnects.

The protected Orders view searches both online and PC-synced orders by order
number, customer, phone, product or status. Staff can also add a one-off custom
product with quantity, unit and price when it is missing from the catalogue.
Custom items remain attached to the order and do not pollute searchable stock.

The Worker requires these encrypted secrets:

- `APP_USER`
- `APP_PASSWORD` (use at least 16 random characters)
- `SYNC_SECRET` (use at least 32 random characters)
- `META_APP_SECRET`
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_ACCESS_TOKEN` (permanent System User token for outbound messages)

The customer catalogue is public at `/catalog/`. It contains all products from
the repository catalogue, category and product-group filters, search, product
images, and a multi-product `+`/`−` cart. The final cart is reviewed and sent
to the business number in WhatsApp. The management application at `/` remains
protected with HTTP Basic authentication.

Every new WhatsApp sender receives the catalogue link automatically. Further
messages do not trigger repeated replies for 24 hours, unless the customer
explicitly sends `catalogue`, `catalog`, `menu`, `products`, or `price list`.
The webhook records successful and failed automatic replies in D1.
The protected WhatsApp dashboard also has an anytime-message form. It loads
approved Meta templates automatically, renders their body variables, and
requires confirmation that the recipient opted in. Payment reminder buttons
pre-fill the approved `payment_remainder` fields from synced invoices. Order
cards pre-fill `order_delivery_update` after Meta approves that Utility
template. This does not change or replace the live webhook.
It also safely stores the Coexistence webhook fields `account_update`,
`history`, `smb_app_state_sync`, and `smb_message_echoes`, so the backend is
ready when Meta approves the app for Tech Provider onboarding.

Deploy in this order:

```sh
npm install
npm run build:catalog
npx wrangler login
npx wrangler d1 create frostflow-online
# Replace REPLACE_AFTER_D1_CREATE in wrangler.jsonc with the returned database ID.
npx wrangler d1 migrations apply frostflow-online --remote
npx wrangler d1 execute frostflow-online --remote --file schema/triggers.sql
npx wrangler secret put APP_USER
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SYNC_SECRET
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
npx wrangler secret put META_ACCESS_TOKEN
npm run deploy
```

Then set the Meta callback URL to
`https://<worker-name>.<account-subdomain>.workers.dev/webhooks/whatsapp` and use
the same verification token. Do not commit any secret or business database.

On the Windows business PC, place the updated `frostflow-app` folder beside the
existing `data` folder and run `Install-Cloud-Sync.bat`. Enter the sync secret
when prompted. It is protected with Windows DPAPI for that Windows user, the
first full sync runs immediately, and Task Scheduler repeats it every five
minutes whenever the network is available.

The Workers Free plan is the initial target. Static assets are free; Workers allow
100,000 requests per day, and D1 includes 5 million rows read, 100,000 rows written
per day and 5 GB total storage. Add indexes and monitor the Cloudflare usage page.
