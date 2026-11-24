# Amul Café owner guide

## Start here

Open `https://frostflow-cafe.manideepyeredla2301.workers.dev/` and tap **Staff**, then **Owner Admin**. You can also open `/admin/` on the same address. Sign in with the owner username `rachana` and the password already configured in FrostFlow. Keep that password private. Use **Sign out** when leaving a shared device.

The top of Admin has **Product catalogue**, **+ Add product**, **Staff**, **Orders & bills**, and **Open POS** shortcuts. The sidebar also has Overview, Products, Categories, Inventory, Orders & payments, Reports, Offers, QR codes, Staff, and Settings. POS and Kitchen are on this same café address at `/pos/` and `/kitchen/`. Catalogue and product creation are shown to the owner or staff with catalogue permission.

## Add or change a menu item

1. Tap **+ Add product** at the top of Admin or in **Product catalogue**. Pick the category and choose **Prepared** for café food or drink, or **Retail** for a packaged product.
2. Enter the selling price, name, description, and availability. Add GST only if it applies to that item; the system does not assume one rate for every product.
3. Upload a photo. Adjust the square crop and preview it, then save. Replacement photos persist in the café database. Keep uploads under 1 MB while database image storage is active.
4. Add option groups for variants and extras. The initial burgers already have one optional Amul cheese slice at ₹10. The sundae configurator enforces scoop, serving, sauce, and topping rules.
5. Enter **Kitchen steps** for prepared items. These steps appear on every kitchen ticket and can be edited without changing code.
6. Save and check the public menu or POS. Use **Sold out** or **Unavailable** when an item should stop accepting new orders; existing orders keep their original price and details.

Use **Categories** to rename, reorder, and control visibility in the QR menu, POS, or retail area. A category with products cannot be deleted until its products are moved or archived. The import control accepts CSV or `.xlsx` Excel files with up to 200 products. Excel import reads the first worksheet. Review the dry run before applying an import.

## Set up packaged Amul products

The café database contains 243 distinct products from FrostFlow's curated Amul catalogue, including 167 ice creams. They appear in the staff POS and are hidden from the customer QR menu. Their printed MRPs are starting prices, and 45 products with missing or conflicting prices or pack details are disabled for owner review. Check the product's actual package before enabling one of those items. Items with no verified MRP show **Price pending**. Existing FrostFlow distribution stock is not counted as café counter stock.

Each imported retail product now has an opening balance of 20 pieces, entered at your request. In **Inventory**, compare that balance with the physical café quantity and adjust it as needed. The opening batches are labelled **UNSPECIFIED** because actual batch numbers and expiry dates were not supplied; check each pack's date before selling. In **Products**, review the selling price and enable any item marked for review after checking its pack. Barcode values were not present in the source catalogue; add the actual barcode from the pack before relying on barcode scanning. The existing SKU is searchable in POS. Upload an accurate product photo for any item showing an image placeholder.

Stock is deducted when a sale is confirmed. Authorized returns add packaged stock back. A sale is rejected if tracked stock would become negative. A packaged-only POS sale completes at the counter. For prepared items, you can track a finished-item quantity; if an ingredient recipe is configured, the recipe consumes ingredients instead of also deducting finished-item stock. Edit ingredients and recipe quantities in **Inventory**.

## Orders, payments, and receipts

**Orders & payments** shows QR, tablet, counter, and retail transactions. POS also has a prominent **Billed orders** button for the latest 200 server orders, with search and Paid/Unpaid filters. Open a bill to print it, record a later payment, or open an itemized WhatsApp draft for the customer's mobile number. Staff must review and tap **Send** in WhatsApp; opening the draft does not send it. **Held orders** in POS shows saved carts that have not been billed, and they can be resumed on another signed-in device. Open an order in Admin to see items, notes, payment status, and receipt. Staff may record cash, UPI, or card only after confirming that payment outside the website. Split payments are supported. Owners and authorized managers can handle returns and refunds; the audit log records these actions. Receipts print at 58 mm or 80 mm widths.

Counter checkout requires a customer name and a valid Indian mobile number. The QR checkout asks for both as well. Phone numbers are available to authenticated staff for bills; public order tracking and kitchen tickets do not show them. Customer QR checkout shows a preferred in-café payment method, but never takes payment online. You can enable or disable methods in **Settings**. No gateway is configured.

## Offers and QR cards

The initial offer gives one **Salted Fries at ₹0** when eligible ice cream purchases are **strictly above ₹250**. Burgers, sandwiches, coffee, frappes, and snacks do not count toward that threshold. The free item appears on the customer order, receipt, and kitchen ticket. Change or disable the offer in **Offers**.

In **QR codes**, manage the general, counter pickup, takeaway, and table codes. Disable a lost or retired code; it will stop accepting new orders. Print cards from **QR cards** or the supplied printable PDF. Check that a table card opens with the correct table number before placing it on a table. The initial print set includes tables 1–12; create further managed codes in Admin before printing their cards. Packaged Amul categories are not visible through these QR codes unless the owner later enables them for QR ordering.

## Staff and reports

Create each person under **Staff** with a unique username, a password of at least 12 characters, and a role. Cashiers can use POS and record payments; kitchen staff can view tickets and change preparation status. The backend checks permissions on every action. Avoid sharing the owner login.

**Reports** uses the café's Asia/Kolkata business day. Use Today, Yesterday, Last 7 days, This month, or custom dates; export CSV for Excel. Overview highlights sales, payments, refunds, stock alerts, and popular products.

## Daily opening check

1. Open the kitchen board and enable its sound alert if desired.
2. Check the connection indicator and refresh if it shows an error.
3. Mark unavailable products sold out and confirm retail stock.
4. Place one small test order through a table QR, confirm it appears in the kitchen, then cancel the test order if appropriate.
5. Check the receipt printer's paper width and that the correct QR cards are displayed.
