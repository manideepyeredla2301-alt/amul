# MR Enterprises wholesale checklist

This local web app lets staff record phone orders, pull in online orders already received by the Windows FrostFlow sync, pick each line, and prepare an invoice **draft** from the picked quantities. It does not post an official invoice to the Amul billing database or deduct stock.

## On the Windows billing computer

1. Stop FrostFlow and its cloud-sync task before replacing application files. Keep the existing `data` folder; it contains the business database and protected sync settings. Do not copy the `data` folder to staff devices.
2. Copy the updated application files into the existing FrostFlow folder. Node.js 24 or the existing `runtime\node.exe` must be available.
3. Double-click `Start-Wholesale-LAN.bat`. The first start asks for a password for the owner login `rachana` and stores a salted password hash in `data\wholesale-lan-auth.json`. The password is not stored in the application source.
4. If phones cannot open the address displayed in the window, run `Enable-Wholesale-LAN-Firewall.bat` once as administrator. Its rule permits TCP 4318 only on Windows **Private** networks and only from the local subnet.
5. Keep the Wholesale LAN window open. Open the displayed `http://<Windows-PC-IP>:4318/` address on a phone connected to the same Wi-Fi. Bookmark it.
6. To let another person take or pick orders, double-click `Add-Wholesale-Staff.bat` on the Windows PC and create a separate staff username and password. Staff accounts cannot prepare or view invoice drafts.

If FrostFlow's cloud-sync task is configured, the app reads its `data\cloud-sync.json` database path. Otherwise it opens `data\frostflow.sqlite`. To choose a different existing local database, set `FROSTFLOW_DB` before starting. It refuses to start against a missing file, preventing accidental use of an empty replacement database.

## Daily flow

1. **Take an order:** Search the existing MR/Amul retailer records, or enter a new customer name. Browse the product category chips or search by name, SKU or barcode, then tap a product tile to add it to the order list. Use **Load more products** for large categories. Set each quantity, unit and rate, then save. Taking an order does not reserve or deduct stock.
2. **Bring in online orders:** The existing Windows cloud-sync task saves new online orders into the local inbox. Select **Import online orders** in the queue to add them to the same checklist. Repeating import does not duplicate an order. New orders appear after the next sync run.
3. **Pick:** Select an order card from the queue on a phone. Check a line in full or enter the quantity actually picked. A short or skipped line needs a reason. Put the order on hold if work pauses. Mark it ready after every line has been checked.
4. **Prepare draft:** The owner reviews the ready order and creates a locked invoice draft. The draft includes only lines with a picked quantity above zero. Print it or save it as a PDF from the browser, then verify prices, GST and customer details in the authorised billing system before issuing the final invoice there.

The app displays a warning when an Amul item has no recorded selling price. A rate must be entered before a picked item can appear in a draft. The synced Amul product cache does not supply a verified GST rate, so Amul draft totals show tax as provisional and require review in the billing system.

## Access and data

- The app binds to one private Wi-Fi or Ethernet IPv4 address and serves only the wholesale pages and API. The rest of the FrostFlow ERP stays on its existing local-only address.
- Accounts use salted scrypt password hashes. Browser sessions expire after 12 hours. Write requests require a session token and a same-origin check.
- The default local Wi-Fi address uses HTTP. Use only a trusted private network. To enable HTTPS when you have a certificate and key, set `FROSTFLOW_LAN_TLS_CERT` and `FROSTFLOW_LAN_TLS_KEY` before launch and use the displayed `https://` address.
- Order checklists and invoice drafts are stored in new tables in the selected Windows FrostFlow SQLite database. Source Amul SQL tables are read-only.
- The owner should continue the existing daily database backup routine. Invoice drafts and checklist data are included in that database backup.

## Troubleshooting

- **No products or customers:** Run the Windows Amul/FrostFlow sync and confirm that `data\cloud-sync.json` points to the active database. The app searches synced Amul records and local FrostFlow records.
- **No online orders:** Run the existing cloud-sync task, then select **Import online orders**. The task must have valid cloud sync configuration and must have received new online orders.
- **Phone cannot connect:** Confirm the phone and PC are on the same Wi-Fi, the PC network profile is Private, the Wholesale LAN window is open, and the firewall rule was enabled. Use the IP address shown at start.
- **Rate missing:** Enter the actual rate when taking or checking the order. The draft blocks picked items with a zero rate.
- **Draft will not open for staff:** Staff can take and pick orders; only the owner account can prepare and view invoice drafts.
