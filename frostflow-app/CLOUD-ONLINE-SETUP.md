# FrostFlow PC-to-cloud setup

The live SQLite file remains the source of truth on the Amul Windows PC. Do not
upload `frostflow.sqlite`, its `-wal` file, credentials, or backups to GitHub.
Cloudflare D1 receives only validated product, stock, customer, route, order,
invoice and payment fields. Online orders are downloaded to the local review
inbox when the PC reconnects.

## Install on the Windows business PC

1. In FrostFlow, create a backup. Close FrostFlow only while replacing program
   files, and keep the existing `data` folder unchanged.
2. Copy the updated `frostflow-app` files over the program folder. Do not replace
   `data\frostflow.sqlite` with an empty database.
3. Double-click `Install-Cloud-Sync.bat`.
4. When asked for the sync secret, retrieve it on the deployment Mac with:

   ```sh
   security find-generic-password -a myeredla -s 'FrostFlow Online Sync Secret' -w
   ```

   Paste it into the hidden Windows prompt. It is encrypted with Windows DPAPI
   for the current Windows user and is never added to Git.
5. The first full sync runs immediately. Windows Task Scheduler then runs
   `FrostFlow Cloud Sync` every five minutes whenever a network is available.

If the live database is in a different folder, open PowerShell 7 in the app
folder and run:

```powershell
pwsh -NoProfile -File .\scripts\install-cloud-sync.ps1 `
  -DatabasePath 'D:\FrostFlow\data\frostflow.sqlite' `
  -DeviceId 'amul-pc'
```

Check `data\cloud-sync.log` after the first run. A successful line includes the
product count and customer/order/invoice/payment counts. The online app should
then stop showing “Waiting for PC sync.”

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

