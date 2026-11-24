# FrostFlow café technical assessment

## Existing project reviewed

The existing FrostFlow service is a Cloudflare Worker with D1 storage. The live `frostflow-online` ERP Worker has its own working functionality and data. A simpler café QR Worker, `frostflow-cafe`, already existed in the same Cloudflare account with its own `cafe_` tables and migration history. This project extends the café Worker and leaves the ERP Worker alone. The shared D1 database was exported before the platform migrations; the SQL export was restored in a local SQLite check and passed `PRAGMA quick_check`.

The café uses a static frontend on Workers Assets and JavaScript Worker APIs. Customer, staff, POS, kitchen, and admin pages now use one canonical `frostflow-cafe` site and the same D1 tables. The former dedicated POS Worker redirects page entries to the canonical site's POS while retaining API compatibility for older open sessions. The site has a database-backed catalogue, server-calculated customizations, QR and POS orders, live kitchen revision polling, staff sessions and role checks, payments, stock movements and batches, ingredients and recipes, reports, offers, managed QR codes, and audit entries. The schema includes an outlet entity for later expansion; this deployment operates as one café.

## Storage and security decisions

Cloudflare R2 returned account error 10042 because R2 is not enabled. The owner chose database storage for now. Built-in generated photos are static Worker assets; replacement photos uploaded by the owner are validated, size limited, and stored in D1 BLOBs. The owner can replace every photo. If R2 is enabled later, the upload code has an optional image binding path.

Owner credentials and session secrets remain in Cloudflare Worker secrets. Staff passwords are salted PBKDF2 hashes, sessions use secure HttpOnly cookies, and role checks run on the server. Public APIs exclude cost and stock internals. Customer prices are recalculated from database products and option groups; write requests use same-origin checks, size limits, validation, and throttling. QR codes can be disabled. Orders use idempotency keys and an intent hash; repeated submissions of the same order return the same order, while a changed cart with a reused key is rejected. D1 batches make order creation and stock deduction atomic.

No online payment gateway is configured. Staff can only record manual cash, UPI, and card payments after an external payment. Customer payment selection is a preference and never a success signal. POS checkout requires a customer name and valid Indian mobile number. The contact migration stores optional numbers on existing and future orders and held carts; authenticated staff order and receipt views may show them, while public tracking and kitchen lists omit them. The POS uses WhatsApp click-to-chat to open an itemized draft. Staff explicitly sends the message inside WhatsApp; the system has no automatic WhatsApp Business API delivery.

## Operational limits

- CSV and native `.xlsx` imports are supported. Excel conversion runs in the admin browser with a locally bundled parser, then uses the same server dry run and validation as CSV. Files are limited to 1 MB and 200 products, and only the first worksheet is imported.
- New photos are capped at 1 MB while stored in D1. This is suitable for cropped menu images; R2 can be enabled later for larger media libraries.
- The POS keeps unsynced orders on the originating device when offline. Staff must review and submit them after reconnection; there is no automatic kitchen or payment side effect for an unsynced order.
- Retail sales consume batches by expiry order and block expired stock. Ingredient recipe consumption updates ingredient totals and movements, but does not allocate that consumption across individual ingredient batches.
- The current deployment is one outlet. The schema prepares for multi-outlet expansion, but no cross-outlet routing or consolidated reporting is active.
