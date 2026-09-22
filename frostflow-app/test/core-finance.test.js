const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, inTransaction } = require('../src/db');
const { ERPService, AppError } = require('../src/services/erp-service');
const { paise, dateOnly, businessToday } = require('../src/domain');

function fixture(t, options = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const erp = new ERPService(db);
  const product = erp.createProduct({ sku: 'BAR',name: 'Ice Cream Bar',purchasePrice: 10,wholesalePrice: 20,retailPrice: 30,gstBps: options.gstBps || 0 });
  const supplier = erp.createParty({ partyType: 'SUPPLIER',name: 'Supplier' });
  const customer = erp.createParty({ partyType: 'CUSTOMER',name: 'Customer',creditDays: 2 });
  function receive(quantity = 20, unitCost = 10, batchNumber = 'LOT-A', expiryDate = '2099-12-31') {
    return erp.receivePurchase({ supplierId: supplier.id,billDate: '2000-01-01',items: [{ productId: product.id,quantity,unitCost,batchNumber,expiryDate }] });
  }
  function invoice(quantity = 1, input = {}) {
    return erp.createInvoice({ channel: 'DISTRIBUTION',customerId: customer.id,invoiceDate: '2000-01-02',deliveryDate: '2000-01-02',items: [{ productId: product.id,quantity }],...input });
  }
  return { db,erp,product,supplier,customer,receive,invoice };
}

test('money is exact and malformed dates, unsafe integers and credit-as-cash are rejected atomically', (t) => {
  const { db,erp,product,customer,receive,invoice } = fixture(t);
  assert.equal(paise('90071992547409.91'),Number.MAX_SAFE_INTEGER);
  assert.equal(paise('0.29'),29);
  for (const amount of ['1.001','-1','NaN','1e4','90071992547409.92',true]) assert.throws(() => paise(amount),AppError);
  assert.throws(() => dateOnly('2026-02-30'),AppError);
  assert.throws(() => dateOnly('2026-13-01'),AppError);
  receive();
  const auditCount = erp.auditLog().length;
  assert.throws(() => erp.updateProduct(product.id,{ wholesalePrice: '1.001' }),AppError);
  assert.throws(() => invoice(1,{ payments: [{ amount: 20,method: 'CREDIT' }] }),AppError);
  assert.throws(() => erp.recordReceipt({ partyId: customer.id,amount: 10,method: 'CREDIT' }),AppError);
  assert.equal(erp.auditLog().length,auditCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,0);
});

test('price updates preserve historic batch cost and purchases reject changed cost on the same lot', (t) => {
  const { erp,product,receive } = fixture(t);
  receive(5,10);
  erp.updateProduct(product.id,{ purchasePrice: 99,wholesalePrice: 25,retailPrice: 35 });
  const stock = erp.inventorySummary();
  assert.equal(stock.cost_value_paise,5000);
  assert.equal(stock.wholesale_value_paise,12500);
  assert.equal(stock.retail_value_paise,17500);
  assert.equal(erp.getProduct(product.id).purchase_price_paise,9900);
  const audits = erp.auditLog().length;
  assert.throws(() => receive(5,11),{ code: 'BATCH_COST_CONFLICT' });
  assert.equal(erp.auditLog().length,audits);
  assert.equal(erp.purchaseBills().length,1);
  assert.equal(erp.inventorySummary().cost_value_paise,5000);
  receive(5,11,'LOT-B');
  assert.equal(erp.inventorySummary().cost_value_paise,10500);
  assert.equal(erp.getProduct(product.id).purchase_price_paise,1100);
});

test('nested services survive preview rollback and an invalid batch rolls back the whole import', (t) => {
  const { db,erp,product } = fixture(t);
  db.exec('SAVEPOINT excel_preview');
  erp.updateProduct(product.id,{ wholesalePrice: 99 });
  erp.setBatchStock({ productId: product.id,batchNumber: 'COUNT',quantity: 8,unitCost: 10,reason: 'Opening count' });
  assert.equal(erp.listProducts()[0].stock_qty,8);
  db.exec('ROLLBACK TO excel_preview'); db.exec('RELEASE excel_preview');
  assert.equal(erp.listProducts()[0].stock_qty,0);
  assert.equal(erp.getProduct(product.id).wholesale_price_paise,2000);
  const audits = erp.auditLog().length;
  assert.throws(() => inTransaction(db,() => {
    erp.setBatchStock({ productId: product.id,batchNumber: 'COUNT',quantity: 8,unitCost: 10,reason: 'Opening count' });
    erp.setBatchStock({ productId: product.id,batchNumber: 'COUNT',quantity: 9,unitCost: 20,reason: 'Wrong cost' });
  }),{ code: 'BATCH_COST_CONFLICT' });
  assert.equal(erp.listProducts()[0].stock_qty,0);
  assert.equal(erp.auditLog().length,audits);
  assert.equal(db.isTransaction,false);
});

test('physical counts change only the targeted lot and expired stock can be removed but not sold', (t) => {
  const { erp,product,receive,invoice } = fixture(t);
  receive(3,10,'EXPIRED','2000-01-01');
  receive(2,20,'FRESH');
  const summary = erp.inventorySummary();
  assert.equal(summary.stock_units,5);
  assert.equal(summary.saleable_units,2);
  assert.equal(summary.expired_units,3);
  assert.equal(summary.cost_value_paise,7000);
  assert.equal(summary.saleable_cost_value_paise,4000);
  assert.throws(() => invoice(3),{ code: 'INSUFFICIENT_STOCK' });
  const expired = erp.inventory().find((row) => row.batch_number === 'EXPIRED');
  erp.adjustStock({ productId: product.id,batchId: expired.batch_id,type: 'EXPIRY',quantity: 3,reason: 'Expired stock discarded' });
  erp.setBatchStock({ productId: product.id,batchNumber: 'FRESH',expiryDate: '2099-12-31',quantity: 1,unitCost: 20,reason: 'Physical count shortage' });
  assert.equal(erp.inventorySummary().stock_units,1);
  assert.equal(erp.inventorySummary().expired_units,0);
  assert.equal(erp.purchaseBills().length,2);
});

test('untargeted receipts settle oldest due invoices and advances settle later invoices without fake collections', (t) => {
  const { erp,customer,receive,invoice } = fixture(t);
  receive();
  const old = invoice(2);
  const newer = invoice(2,{ invoiceDate: '2000-01-03',deliveryDate: '2000-01-03' });
  erp.recordReceipt({ partyId: customer.id,amount: 50,paymentDate: '2000-01-04',method: 'BANK' });
  assert.equal(erp.invoiceBalances(old.id).outstanding_paise,0);
  assert.equal(erp.invoiceBalances(newer.id).outstanding_paise,3000);
  assert.equal(erp.receivables().summary.overdue_paise,3000);
  erp.recordReceipt({ partyId: customer.id,amount: 60,paymentDate: '2000-01-05',method: 'UPI' });
  assert.equal(erp.receivables().summary.receivable_paise,0);
  assert.equal(erp.receivables().summary.credit_paise,3000);
  assert.equal(erp.receivables().invoices.length,0);
  const future = invoice(1);
  assert.equal(erp.invoiceBalances(future.id).paid_paise,2000);
  assert.equal(erp.receivables().summary.credit_paise,1000);
  assert.equal(erp.payments().reduce((value,row) => value + row.amount_paise,0),11000);
  assert.equal(erp.payments().reduce((value,row) => value + row.allocated_paise,0),10000);
});

test('sales returns retain sold lot cost and expiry, reduce debt and release excess receipts into customer credit', (t) => {
  const { db,erp,product,customer,receive,invoice } = fixture(t);
  receive(3,10,'CHEAP'); receive(3,20,'DEAR');
  const sale = invoice(6,{ payments: [{ amount: 120,method: 'CASH' }] });
  const item = erp.invoiceDetail(sale.id).items[0];
  // Simulate time having passed after sale: the source batch's expiry is now in the past.
  db.prepare('UPDATE inventory_batches SET expiry_date=? WHERE batch_number=?').run('2000-01-01','CHEAP');
  erp.createSalesReturn({ invoiceId: sale.id,returnDate: businessToday(),reason: 'Returned in original packaging',items: [{ invoiceItemId: item.id,quantity: 4 }] });
  assert.equal(erp.inventorySummary().stock_units,4);
  assert.equal(erp.inventorySummary().cost_value_paise,5000);
  assert.equal(erp.inventorySummary().expired_units,3);
  assert.equal(erp.invoiceBalances(sale.id).paid_paise,4000);
  assert.equal(erp.invoiceBalances(sale.id).returned_paise,8000);
  assert.equal(erp.invoiceBalances(sale.id).outstanding_paise,0);
  assert.equal(erp.receivables().summary.credit_paise,8000);
  assert.equal(erp.partyLedger(customer.id).balance_paise,-8000);
  assert.throws(() => erp.createSalesReturn({ invoiceId: sale.id,items: [{ invoiceItemId: item.id,quantity: 3 }] }),AppError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n,2);
  assert.equal(erp.getProduct(product.id).purchase_price_paise,2000);
});

test('supplier payments track bill balances and purchase returns release overpayment as supplier advance', (t) => {
  const { erp,supplier,receive } = fixture(t);
  const bill = receive(10,10);
  erp.recordSupplierPayment({ partyId: supplier.id,amount: 120,paymentDate: '2000-01-04',method: 'BANK' });
  assert.equal(erp.purchaseBalances(bill.id).payment_status,'PAID');
  assert.equal(erp.purchaseBalances(bill.id).paid_paise,10000);
  assert.equal(erp.listParties('SUPPLIER')[0].balance_paise,2000);
  const item = erp.purchaseDetail(bill.id).items[0];
  erp.createPurchaseReturn({ purchaseBillId: bill.id,reason: 'Rejected supplier lot',items: [{ purchaseItemId: item.id,quantity: 5 }] });
  assert.equal(erp.purchaseBalances(bill.id).paid_paise,5000);
  assert.equal(erp.purchaseBalances(bill.id).outstanding_paise,0);
  assert.equal(erp.listParties('SUPPLIER')[0].balance_paise,7000);
  assert.equal(erp.payments()[0].unallocated_paise,7000);
  const next = receive(5,10,'NEW');
  assert.equal(erp.purchaseBalances(next.id).paid_paise,5000);
  assert.equal(erp.payments()[0].unallocated_paise,2000);
});

test('opening balances stay unaged and opening credit settles invoices without being counted as cash', (t) => {
  const { db,erp,customer,supplier,receive,invoice } = fixture(t);
  db.prepare("INSERT INTO party_ledger_entries (party_id,entry_date,entry_type,credit_paise) VALUES (?,'2000-01-01','OPENING_ADJUSTMENT',3000)").run(customer.id);
  db.prepare("INSERT INTO party_ledger_entries (party_id,entry_date,entry_type,debit_paise) VALUES (?,'2000-01-01','OPENING_ADJUSTMENT',5000)").run(supplier.id);
  const bill = receive(10,10);
  assert.equal(erp.purchaseBalances(bill.id).outstanding_paise,5000);
  assert.equal(erp.purchaseBalances(bill.id).paid_paise,0);
  assert.equal(erp.purchaseBalances(bill.id).credit_applied_paise,5000);
  const sale = invoice(2);
  assert.equal(erp.invoiceBalances(sale.id).paid_paise,0);
  assert.equal(erp.invoiceBalances(sale.id).credit_applied_paise,3000);
  assert.equal(erp.invoiceBalances(sale.id).outstanding_paise,1000);
  assert.equal(erp.receivables().summary.overdue_paise,1000);
  erp.recordReceipt({ partyId: customer.id,invoiceId: sale.id,amount: 10,method: 'CASH' });
  assert.equal(erp.invoiceBalances(sale.id).outstanding_paise,0);
  assert.equal(erp.payments().length,1);
  const other = erp.createParty({ partyType: 'CUSTOMER',name: 'Opening debit customer' });
  db.prepare("INSERT INTO party_ledger_entries (party_id,entry_date,entry_type,debit_paise) VALUES (?,'2000-01-01','OPENING_ADJUSTMENT',8000)").run(other.id);
  const balances = erp.receivables();
  assert.equal(balances.summary.opening_unaged_paise,8000);
  assert.equal(balances.summary.overdue_paise,0);
});

test('return-aware tax totals reconcile to original documents and walk-in returns disclose the cash refund still due', (t) => {
  const { erp,product,receive } = fixture(t,{ gstBps: 1800 });
  const purchase = receive(10,10);
  const invoice = erp.createInvoice({ channel: 'RETAIL',items: [{ productId: product.id,quantity: 2 }],payments: [{ method: 'CASH',amount: 70.80 }] });
  const line = erp.invoiceDetail(invoice.id).items[0];
  erp.createSalesReturn({ invoiceId: invoice.id,items: [{ invoiceItemId: line.id,quantity: 1 }],reason: 'Return' });
  const purchaseLine = erp.purchaseDetail(purchase.id).items[0];
  erp.createPurchaseReturn({ purchaseBillId: purchase.id,items: [{ purchaseItemId: purchaseLine.id,quantity: 1 }],reason: 'Return' });
  const gst = erp.reports().gst;
  assert.equal(gst.gross_output_tax_paise,1080);
  assert.equal(gst.sales_return_tax_paise,540);
  assert.equal(gst.output_tax_paise,540);
  assert.equal(gst.gross_input_tax_paise,1800);
  assert.equal(gst.purchase_return_tax_paise,180);
  assert.equal(gst.input_tax_paise,1620);
  assert.equal(erp.invoiceDetail(invoice.id).invoice.refund_due_paise,3540);
  assert.equal(erp.payments().filter((row) => row.direction === 'PAYMENT').length,0);
});
