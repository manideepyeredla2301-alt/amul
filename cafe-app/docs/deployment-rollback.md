# Café deployment and rollback

Run these commands from `cafe-app/` after checking the changes locally. The Worker name is `frostflow-cafe`; the D1 database is `frostflow-online`. The ERP Worker is a separate deployment and must not be replaced.

## Before deploying

1. Confirm the Cloudflare account and Worker configuration in `wrangler.jsonc`.
2. Confirm the existing Worker has `CAFE_ADMIN_PASSWORD` and `CAFE_SESSION_SECRET` set as **secrets**. The owner username is configured separately. Do not place secret values in repository files, a command history, or a public URL.
3. Save a private D1 export and check it before any remote migration:

```sh
umask 077
npx wrangler d1 export frostflow-online --remote --output /private/path/frostflow-before-cafe.sql
```

4. Run `npm ci`, `npm run check`, the isolated local integration test, and `npx wrangler deploy --dry-run`. Review the migration files and confirm the separate café retail stock has its 20-piece opening balance per packaged product.

## Deploy

```sh
npx wrangler d1 migrations apply frostflow-online --remote
npx wrangler deploy
npx wrangler versions list
```

The new schema migrations are additive and use the café's separate migration table. `wrangler deploy` publishes the café Worker and its static photos. It does not deploy `frostflow-online` ERP code.

The former POS Worker, `frostflow-pos`, redirects page entries to `/pos/` on the canonical `frostflow-cafe` address. It retains its existing secrets and API compatibility for previously open sessions. Publish that redirect with:

```sh
npm run deploy:pos
npx wrangler deployments list --name frostflow-pos
```

Do not rerun database migrations just to update the redirect Worker. Staff should use one address: `https://frostflow-cafe.manideepyeredla2301.workers.dev/`.

After deployment, check the public menu has 68 café items and correct burger prices, then check the Staff link, owner login, Admin **+ Add product** and catalogue controls, the POS catalogue, kitchen tickets, a table QR, and a test order from creation through Ready. Confirm checkout requires customer name and mobile number; the order appears in **Billed orders**, a held cart appears in **Held orders**, and the WhatsApp action opens a prepared bill for staff to send. Check a receipt, the free-fries offer, and one manual payment. Confirm the former POS address redirects to the café site's POS. Record the deployed version ID and the test order number. Do not claim live HTTP verification if the deployment URL cannot be reached from the testing network.

## Roll back code

Find the previous version ID with `npx wrangler versions list`, then run:

```sh
npx wrangler rollback <previous-version-id> --message "Restore previous café release"
```

This rolls back the café Worker code and assets, not D1 data. Keep the new café tables and columns in place while investigating; additive schema should be harmless to the older café Worker. If data repair is needed, first export the current database as a second private backup. Because D1 is shared with the ERP, **do not import the full old export into production blindly**: it would erase ERP transactions created after the export. Restore only the affected café records after reviewing both backups, ideally on a staging copy first.

To roll back only the separate POS Worker, use `npx wrangler deployments list --name frostflow-pos` to find its previous version, then `npx wrangler rollback <previous-pos-version-id> --name frostflow-pos`.

## Backups and routine checks

Keep private D1 exports outside the repository. Take one before each schema change and on a regular schedule through the owner's infrastructure process. Periodically test restoring an export into an isolated database and inspect `PRAGMA quick_check`. Monitor order creation failures, staff sign-in failures, storage usage, and low stock in the admin dashboard.
