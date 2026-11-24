# Amul Café staff guide

## Customer QR orders

The customer scans a table, takeaway, counter, or general café QR code. The page opens without an app, shows current product prices and photos, and asks for a name, mobile number, and any table or preparation details. Customers place an order and get an order number and live status. Payment is made at the café; QR checkout does not collect it.

If a customer says an order did not appear, ask for the order number or tracking page. Do not make the same order again until you check the kitchen or Orders & payments screen.

## Tablet and counter POS

1. Open `https://frostflow-cafe.manideepyeredla2301.workers.dev/`, tap **Staff**, then **Counter & POS**. Sign in with your own staff account. The kitchen and owner controls are linked from the same site.
2. Choose **Dine in**, **Takeaway**, or **Counter sale**. Enter the table number for dine-in.
3. Tap café items or packaged retail items. Search by name, SKU, or barcode; a supported tablet camera can scan a barcode. Pick required sundae choices or optional extras and add any cook note.
4. Enter the customer's name and valid 10-digit Indian mobile number, then check the cart, quantity, and estimated total. The server confirms final prices and offers when the order is created.
5. Choose **Unpaid** unless payment has actually been received. Cash, UPI, card, and split entries are records of money taken outside the site.
6. Create the order. Give the customer the order number and print a 58 mm or 80 mm receipt if needed. To send a bill, tap **Open WhatsApp bill**, check the number and itemized draft, then tap **Send** in WhatsApp. The website does not send it automatically.

**Hold cart** saves a cart for later; customer details are optional until the cart is checked out. Tap **Held orders** to resume or remove saved carts, including those held on another signed-in device. Tap **Billed orders** to find recent QR and POS orders by order number, customer name, or phone, and filter Paid or Unpaid. Open any bill to view, print, record a later payment, or prepare its WhatsApp message. A packaged-only sale normally completes without a kitchen ticket. A mixed sale sends only the prepared lines to the kitchen. If a retail ice cream purchase earns the free Salted Fries offer, that complimentary food item still goes to the kitchen.

An owner or staff member with catalogue permission can use the **Catalogue** and **Add product** shortcuts in POS. The owner can also use the **Staff** shortcut. These controls open Admin on the same café address.

Imported packaged products appear in POS by name and SKU. A product marked **Price pending** or **Sold out** cannot be added until the owner verifies its price and café stock. Do not substitute a different pack size or flavour when the requested one is unavailable.

### When the connection fails

The POS displays an offline warning. You may save an order as **Unsynced** on that device. An unsynced order has no order number, kitchen ticket, payment record, or receipt. Tell the customer and kitchen staff that it has **not** been accepted. After reconnecting, open **Unsynced**, review current prices, stock, and customer details, then send it manually. Do not take or record a second payment until the order has a confirmed number. If the server reports a conflict, correct the cart or ask a manager; do not blindly resend a different order under the same request ID.

## Kitchen board and cook instructions

Open `/kitchen/` and sign in. Keep the board open on a visible screen. New orders appear automatically; enable **Sound** if the device permits it. The board reconnects after brief network interruptions and refreshes missed updates. Each ticket shows its order number, source, table or pickup context, elapsed time, quantities, selected extras, customer notes, and **step-by-step preparation instructions for each product**. Late orders are highlighted.

Move a new ticket through **Accepted → Preparing → Ready → Completed** as the work happens. Customers see the same status on their tracking page. Only cancel an order when it truly cannot be made, and tell the counter team. A complimentary Salted Fries line is marked free but still needs preparation.

Packaged Amul products are sold through staff POS and do not appear in the customer QR menu. Pick the exact pack and quantity, check its seal and best-before date, keep frozen items frozen until handover, and confirm the order number. A packaged-only POS sale is handled at the counter and does not create a kitchen ticket.

Follow the exact choices on the ticket. For example:

- **Classic Veg Burger:** cook one ready-made veg patty according to its package, toast one bun, add burger mayonnaise, lettuce, onion, and tomato, and add one Amul cheese slice only if selected.
- **Classic Chicken Burger:** cook one ready-made chicken patty thoroughly according to its package; use the same bun and salad assembly, adding cheese only if selected.
- **Frappes, cold coffees, shakes:** check the named flavour and garnish; use the café's approved recipe and a 300 ml clear cup. Use a dome lid when served takeaway and appropriate.
- **Premium sundaes:** check the named ice cream and toppings; serve in a 200 ml paper cup.
- **Build Your Own Sundae:** follow scoop count, flavours, cup/cone/bowl, sauce, topping, and paid extras. Waffle cones allow only one scoop, one sauce, and one dry topping, with no jelly or whipped cream.
- **Sandwiches:** use two slices of bread, the chosen bread type and extras, and the filling on the ticket. Cook chicken and egg fillings fully before serving.

The owner can correct or expand any item's cook steps in Admin → Products. If a house recipe, ingredient quantity, or food safety detail has not been approved by the café, ask the owner before improvising.

## Payments and problems

Cashiers can record payments and print receipts; price changes, discounts, returns, and refunds require the appropriate owner or manager permission. If a payment or order submission seems stuck, check the order list before trying again. Sign out of shared devices after your shift.
