const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { ERPService, AppError } = require('../src/services/erp-service');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frostflow-test-'));
  const db = openDatabase(path.join(directory, 'erp.sqlite'));
  const erp = new ERPService(db);
  return { directory, db, erp };
}

test('purchase, POS sale, customer credit and receipt keep the inventory and ledger consistent', () => {
  const { directory, db, erp } = fixture();
  try {
    const product = erp.createProduct({ sku: 'TEST-BAR', name: 'Test Ice Cream Bar', retailPrice: 40, wholesalePrice: 30, gstBps: 1800, reorderLevel: 2 });
    const supplier = erp.createParty({ partyType: 'SUPPLIER', name: 'Frozen Supplier' });
    const customer = erp.createParty({ partyType: 'CUSTOMER', name: 'Corner Store', creditDays: 2 });
    const purchase = erp.receivePurchase({ supplierId: supplier.id, billDate: '2026-09-10', items: [{ productId: product.id, quantity: 10, unitCost: 20, batchNumber: 'A1', expiryDate: '2027-01-31' }] });
    assert.equal(purchase.total, 23600);
    const retail = erp.createInvoice({ channel: 'RETAIL', invoiceDate: '2026-09-10', items: [{ productId: product.id, quantity: 2 }], payments: [{ method: 'CASH', amount: 94.4 }] });
    assert.equal(retail.paymentStatus, 'PAID');
    assert.equal(erp.listProducts()[0].stock_qty, 8);
    const distribution = erp.createInvoice({ channel: 'DISTRIBUTION', customerId: customer.id, invoiceDate: '2026-09-10', deliveryDate: '2026-09-10', items: [{ productId: product.id, quantity: 3 }] });
    assert.equal(distribution.dueDate, '2026-09-12');
    assert.equal(distribution.total, 10620);
    const receipt = erp.recordReceipt({ partyId: customer.id, invoiceId: distribution.id, amount: 50, method: 'UPI', paymentDate: '2026-09-10' });
    assert.match(receipt.receiptNumber, /^RCPT-/);
    const invoice = erp.invoices().find((row) => row.id === distribution.id);
    assert.equal(invoice.paid_paise, 5000);
    assert.equal(invoice.payment_status, 'PART_PAID');
    const balance = erp.listParties('CUSTOMER').find((row) => row.id === customer.id).balance_paise;
    assert.equal(balance, 5620);
    assert.equal(erp.listProducts()[0].stock_qty, 5);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an oversold invoice is rejected and all partial writes roll back', () => {
  const { directory, db, erp } = fixture();
  try {
    const product = erp.createProduct({ sku: 'LIMITED', name: 'Limited Stock', retailPrice: 20, wholesalePrice: 15, gstBps: 0 });
    const supplier = erp.createParty({ partyType: 'SUPPLIER', name: 'Supplier' });
    erp.receivePurchase({ supplierId: supplier.id, billDate: '2026-09-10', items: [{ productId: product.id, quantity: 1, unitCost: 10, batchNumber: 'ONE', expiryDate: '2027-01-31' }] });
    assert.throws(() => erp.createInvoice({ channel: 'RETAIL', invoiceDate: '2026-09-10', items: [{ productId: product.id, quantity: 2 }], payments: [{ method: 'CASH', amount: 40 }] }), AppError);
    assert.equal(erp.listProducts()[0].stock_qty, 1);
    assert.equal(erp.invoices().length, 0);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('damage adjustments remain traceable in the stock and audit ledgers', () => {
  const { directory, db, erp } = fixture();
  try {
    const product = erp.createProduct({ sku: 'DAMAGED', name: 'Damage Test', retailPrice: 10, wholesalePrice: 8, gstBps: 0 });
    const supplier = erp.createParty({ partyType: 'SUPPLIER', name: 'Supplier' });
    erp.receivePurchase({ supplierId: supplier.id, billDate: '2026-09-10', items: [{ productId: product.id, quantity: 3, unitCost: 5, batchNumber: 'D1', expiryDate: '2027-01-31' }] });
    erp.adjustStock({ productId: product.id, type: 'DAMAGE', quantity: 1, reason: 'Freezer door left open' });
    assert.equal(erp.listProducts()[0].stock_qty, 2);
    assert.ok(erp.auditLog().some((entry) => entry.entity_type === 'STOCK_ADJUSTMENT'));
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('sales and purchase returns reference their source lines and cannot exceed them', () => {
  const { directory, db, erp } = fixture();
  try {
    const product = erp.createProduct({ sku: 'RETURN', name: 'Return Test', retailPrice: 50, wholesalePrice: 40, gstBps: 0 });
    const supplier = erp.createParty({ partyType: 'SUPPLIER', name: 'Supplier' });
    const purchase = erp.receivePurchase({ supplierId: supplier.id, billDate: '2026-09-10', items: [{ productId: product.id, quantity: 4, unitCost: 25, batchNumber: 'RET1', expiryDate: '2027-01-31' }] });
    const purchaseItem = erp.purchaseDetail(purchase.id).items[0];
    erp.createPurchaseReturn({ purchaseBillId: purchase.id, returnDate: '2026-09-10', reason: 'Factory defect', items: [{ purchaseItemId: purchaseItem.id, quantity: 1 }] });
    assert.equal(erp.listProducts()[0].stock_qty, 3);
    const retail = erp.createInvoice({ channel: 'RETAIL', invoiceDate: '2026-09-10', items: [{ productId: product.id, quantity: 2 }], payments: [{ method: 'CASH', amount: 100 }] });
    const invoiceItem = erp.invoiceDetail(retail.id).items[0];
    erp.createSalesReturn({ invoiceId: retail.id, returnDate: '2026-09-10', reason: 'Customer refused', items: [{ invoiceItemId: invoiceItem.id, quantity: 1 }] });
    assert.equal(erp.listProducts()[0].stock_qty, 2);
    assert.throws(() => erp.createSalesReturn({ invoiceId: retail.id, returnDate: '2026-09-10', items: [{ invoiceItemId: invoiceItem.id, quantity: 2 }] }), AppError);
    assert.equal(erp.returns().length, 2);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
