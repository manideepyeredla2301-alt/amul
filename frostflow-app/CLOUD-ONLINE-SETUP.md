# FrostFlow central Cloudflare setup

Cloudflare D1 is the operational source of truth used by the browser, tablet
and Windows desktop launcher. Local `amul-cloud-cache.sqlite` is only a replaceable
Amul read cache and protected job inbox. Do not upload it, its `-wal` file,
credentials, or backups to GitHub. Amul SQL remains read-only and is refreshed
before every cloud publication.

## Install on the Windows business PC

1. Back up the old local data before replacing program files.
2. Copy the updated `frostflow-app` files over the program folder.
3. Double-click `Install-Cloud-Sync.bat`. Enter the SELECT-only `amuluser`
   credential when prompted.
4. When asked for the sync secret, retrieve it on the deployment Mac with:

   ```sh
   security find-generic-password -a myeredla -s 'FrostFlow Online Sync Secret' -w
   ```

   Paste it into the hidden Windows prompt. It is encrypted with Windows DPAPI
   for the current Windows user and is never added to Git.
5. The first full Amul-to-D1 sync runs immediately. Windows Task Scheduler then
   runs `FrostFlow Cloud Sync` every five minutes whenever a network is available.
   Double-click `start-frostflow-online.bat` for the desktop app; it opens the
   same central Cloudflare application used by web and tablet users.

You can also double-click `Sync-FrostFlow-Now.bat` at any time to run and
verify a complete sync immediately.

To place the replaceable cache in a different folder, run:

```powershell
pwsh -NoProfile -File .\scripts\install-cloud-sync.ps1 `
  -DatabasePath 'D:\FrostFlow\data\amul-cloud-cache.sqlite' `
  -DeviceId 'amul-pc'
```

Check `data\cloud-sync.log` after the first run. A successful line includes the
product count and customer/order/invoice/payment counts. The online app should
then stop showing “Waiting for PC sync.”

The public customer catalogue does not wait for the PC and is available at:

```text
https://frostflow-online.manideepyeredla2301.workers.dev/catalog/
```

The protected management dashboard still needs the first Windows sync before
it can display live stock, customers, invoices, collections and local orders.

## WhatsApp production secrets

The access token previously pasted into chat must be revoked. Create a new
permanent Meta System User token with WhatsApp Business Messaging and WhatsApp
Business Management permissions. From `cloudflare-app`, enter both values at
the hidden Wrangler prompts:

```sh
./node_modules/.bin/wrangler secret put META_APP_SECRET
./node_modules/.bin/wrangler secret put META_ACCESS_TOKEN
./node_modules/.bin/wrangler deploy
```

The callback URL is:

```text
https://frostflow-online.manideepyeredla2301.workers.dev/webhooks/whatsapp
```

Retrieve its verification token locally with:

```sh
security find-generic-password -a myeredla -s 'FrostFlow Meta Webhook Verify Token' -w
```

After the callback is saved in the Meta app, subscribe the WABA to the app and
test one inbound message. Free-form outbound replies work only in Meta's active
customer-service window; use an approved template outside that window.

## Network note

The current office/Mac network returns a Cisco Umbrella block page for generic
`workers.dev` addresses. The deployment is active, but this network policy can
prevent opening it. Test once on mobile data. For dependable office access,
attach a domain that you own to the Worker; this changes only the URL and does
not change the D1 database or sync process.
