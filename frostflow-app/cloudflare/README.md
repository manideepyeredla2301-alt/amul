# FrostFlow through Cloudflare Tunnel

FrostFlow remains on the Windows distribution PC because it uses SQLite and the
private Amul SQL Server. Cloudflare Tunnel publishes two encrypted routes without
opening a router port:

- `erp.<your-domain>` -> `http://127.0.0.1:4317`
- `webhook.<your-domain>` -> `http://127.0.0.1:4318`

The ERP route is additionally protected by FrostFlow HTTP authentication. The
webhook route must remain public; its verification token and Meta HMAC signature
checks authenticate requests.

## Cloudflare configuration

1. In Cloudflare Zero Trust, create one remotely managed tunnel for the Windows PC.
2. Add the two public hostnames above with their corresponding local services.
3. Install `cloudflared.exe` in `runtime\cloudflared.exe` or on Windows PATH.
4. Set the required environment variables in the Windows user account. Never put
   their values in this repository:

   - `CLOUDFLARE_TUNNEL_TOKEN`
   - `FROSTFLOW_PUBLIC_ORIGIN` (for example `https://erp.example.com`)
   - `FROSTFLOW_ONLINE_USER`
   - `FROSTFLOW_ONLINE_PASSWORD` (at least 16 characters)
   - `META_APP_SECRET`
   - `META_WEBHOOK_VERIFY_TOKEN`
   - `FROSTFLOW_WHATSAPP_TOKEN`
   - `META_PHONE_ID` (defaults to `1260169793854093`)

5. Run `start-frostflow-online.bat`. The PC and this process must stay online.
6. Configure Meta's callback as
   `https://webhook.<your-domain>/webhooks/whatsapp`, using the same webhook
   verification token, and subscribe the app to WABA `1135807005773575`.

Do not route port 4317 publicly without the online username/password. Do not put
Cloudflare tunnel tokens, Meta secrets, WhatsApp tokens, or the SQLite database in
Git.
