# Amul Café owner guide

## Start here

Open the deployed café address with `/admin/` at the end. Sign in with the owner username `rachana` and the password already configured in FrostFlow. Keep that password private. Use **Sign out** when leaving a shared device.

The sidebar has Overview, Products, Categories, Inventory, Orders & payments, Reports, Offers, QR codes, Staff, and Settings. Shortcuts open the tablet POS and kitchen board.

## Add or change a menu item

1. Open **Products** and choose **Add product**. Pick the category and choose **Prepared** for café food or drink, or **Retail** for a packaged product.
2. Enter the selling price, name, description, and availability. Add GST only if it applies to that item; the system does not assume one rate for every product.
3. Upload a photo. Adjust the square crop and preview it, then save. Replacement photos persist in the café database. Keep uploads under 1 MB while database image storage is active.
4. Add option groups for variants and extras. The initial burgers already have one optional Amul cheese slice at ₹10. The sundae configurator enforces scoop, serving, sauce, and topping rules.
5. Enter **Kitchen steps** for prepared items. These steps appear on every kitchen ticket and can be edited without changing code.
6. Save and check the public menu or POS. Use **Sold out** or **Unavailable** when an item should stop accepting new orders; existing orders keep their original price and details.

Use **Categories** to rename, reorder, and control visibility in the QR menu, POS, or retail area. A category with products cannot be deleted until its products are moved or archived. The import control accepts CSV or `.xlsx` Excel files with up to 200 products. Excel import reads the first worksheet. Review the dry run before applying an import.

## Set up packaged ice creams

The retail categories start empty so no SKU, MRP, cost, tax, or opening stock is guessed. In **Products**, create each packaged item with its actual SKU or barcode, pack size, MRP, selling price, cost, tax, and stock tracking. In **Inventory**, enter opening stock or a purchase; add batch number, manufacturing date, and expiry when available. Confirm a test barcode lookup in the POS before using it for sales.

Stock is deducted when a sale is confirmed. Authorized returns add packaged stock back. A sale is rejected if tracked stock would become negative. For prepared items, you can track a finished-item quantity; if an ingredient recipe is configured, the recipe consumes ingredients instead of also deducting finished-item stock. Edit ingredients and recipe quantities in **Inventory**.

## Orders, payments, and receipts

**Orders & payments** shows QR, tablet, counter, and retail transactions. Open an order to see items, notes, payment status, and receipt. Staff may record cash, UPI, or card only after confirming that payment outside the website. Split payments are supported. Owners and authorized managers can handle returns and refunds; the audit log records these actions. Receipts print at 58 mm or 80 mm widths.

Customer QR checkout shows a preferred in-café payment method, but never takes payment online. You can enable or disable methods in **Settings**. No gateway is configured.

## Offers and QR cards

The initial offer gives one **Salted Fries at ₹0** when eligible ice cream purchases are **strictly above ₹250**. Burgers, sandwiches, coffee, frappes, and snacks do not count toward that threshold. The free item appears on the customer order, receipt, and kitchen ticket. Change or disable the offer in **Offers**.

In **QR codes**, manage the general, counter pickup, takeaway, and table codes. Disable a lost or retired code; it will stop accepting new orders. Print cards from **QR cards** or the supplied printable PDF. Check that a table card opens with the correct table number before placing it on a table. The initial print set includes tables 1–12; create further managed codes in Admin before printing their cards.

## Staff and reports

Create each person under **Staff** with a unique username, a password of at least 12 characters, and a role. Cashiers can use POS and record payments; kitchen staff can view tickets and change preparation status. The backend checks permissions on every action. Avoid sharing the owner login.

**Reports** uses the café's Asia/Kolkata business day. Use Today, Yesterday, Last 7 days, This month, or custom dates; export CSV for Excel. Overview highlights sales, payments, refunds, stock alerts, and popular products.

## Daily opening check

1. Open the kitchen board and enable its sound alert if desired.
2. Check the connection indicator and refresh if it shows an error.
3. Mark unavailable products sold out and confirm retail stock.
4. Place one small test order through a table QR, confirm it appears in the kitchen, then cancel the test order if appropriate.
5. Check the receipt printer's paper width and that the correct QR cards are displayed.
