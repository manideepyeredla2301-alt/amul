# FrostFlow Online

This Cloudflare Worker keeps the catalogue, inventory, customers, routes,
distribution orders, invoices, payments and WhatsApp activity online when the
Amul Windows PC is unavailable. Cloudflare D1 stores controlled snapshots. The
Windows sync agent pushes up to 40 records per request and imports queued online
orders into the existing local order inbox when the PC reconnects.

The Worker requires these encrypted secrets:

- `APP_USER`
- `APP_PASSWORD` (use at least 16 random characters)
- `SYNC_SECRET` (use at least 32 random characters)
- `META_APP_SECRET`
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_ACCESS_TOKEN` (permanent System User token for outbound messages)

Deploy in this order:

```sh
npm install
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
