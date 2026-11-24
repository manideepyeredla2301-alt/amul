# FrostFlow Café QR Ordering

This is a separate Cloudflare Worker in the FrostFlow account. It shares the
`frostflow-online` D1 database but uses only `cafe_` tables and its own migration
history. It does not replace the existing FrostFlow ERP Worker or use its
wholesale order workflow.

## Pages

- `/` — mobile customer menu, cart, dine-in or takeaway ordering, and tracking
- `/?table=7` — the same menu with table 7 selected from its QR code
- `/kitchen/` — kitchen sign-in, order queue, and status controls
- `/kitchen/qr` — printable counter and table QR cards (1–999)

There is no online payment form or payment endpoint. Customers pay at the café.
The menu is defined in `src/menu.json`; the Worker computes every order total
from that file and ignores client-supplied prices. In the original menu,
Blueberry Cheesecake Sandwich was marked optional. The build-your-own sundae
did not specify how many sauces or toppings were included, so this app includes
one of each and charges for a second via the listed add-ons.

## Operations

Use Node 24 or later. From this directory:

```sh
npm ci
npm run check
npx wrangler d1 migrations apply frostflow-online --remote
npx wrangler deploy --secrets-file /path/to/private-secrets.json
```

The deployment secrets file must contain `CAFE_ADMIN_PASSWORD` (at least 16
random characters) and `CAFE_SESSION_SECRET` (at least 32 random characters).
Do not commit it. The kitchen username is `kitchen` in `wrangler.jsonc`.
Authentication uses a separate kitchen password, a hashed, expiring session in
D1, a secure HttpOnly cookie, same-origin write checks, and sign-in throttling.
Public orders are also rate limited per connection. Order statuses are
`RECEIVED → PREPARING → READY → COMPLETED`, with cancellation allowed before
the order is ready.

For local development, put the two secrets in a Git-ignored `.dev.vars` file,
run `npx wrangler d1 migrations apply frostflow-online --local`, then `npm run dev`.
