const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'frostflow.sqlite');

function openDatabase(filename = DB_PATH) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      brand TEXT,
      category TEXT NOT NULL DEFAULT 'Ice Cream',
      unit TEXT NOT NULL DEFAULT 'PCS',
      hsn_code TEXT,
      gst_bps INTEGER NOT NULL DEFAULT 1800 CHECK(gst_bps >= 0),
      retail_price_paise INTEGER NOT NULL DEFAULT 0 CHECK(retail_price_paise >= 0),
      wholesale_price_paise INTEGER NOT NULL DEFAULT 0 CHECK(wholesale_price_paise >= 0),
      reorder_level INTEGER NOT NULL DEFAULT 0 CHECK(reorder_level >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY,
      party_type TEXT NOT NULL CHECK(party_type IN ('CUSTOMER','SUPPLIER','BOTH')),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      mobile TEXT,
      whatsapp_number TEXT,
      gstin TEXT,
      address TEXT,
      city TEXT,
      state_code TEXT NOT NULL DEFAULT '27',
      pincode TEXT,
      credit_days INTEGER NOT NULL DEFAULT 2 CHECK(credit_days >= 0),
      credit_limit_paise INTEGER NOT NULL DEFAULT 0 CHECK(credit_limit_paise >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_batches (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_number TEXT NOT NULL,
      manufacture_date TEXT,
      expiry_date TEXT,
      cost_paise INTEGER NOT NULL DEFAULT 0 CHECK(cost_paise >= 0),
      quantity_received INTEGER NOT NULL CHECK(quantity_received >= 0),
      quantity_available INTEGER NOT NULL CHECK(quantity_available >= 0),
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source_document TEXT,
      UNIQUE(product_id, batch_number, expiry_date)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_id INTEGER REFERENCES inventory_batches(id),
      movement_type TEXT NOT NULL CHECK(movement_type IN ('PURCHASE_RECEIPT','SALE_RETAIL','SALE_DISTRIBUTION','SALES_RETURN','PURCHASE_RETURN','DAMAGE','EXPIRY','ADJUSTMENT_IN','ADJUSTMENT_OUT')),
      quantity_delta INTEGER NOT NULL CHECK(quantity_delta != 0),
      unit_cost_paise INTEGER NOT NULL DEFAULT 0,
      reference_type TEXT NOT NULL,
      reference_id INTEGER,
      reason TEXT,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT NOT NULL DEFAULT 'Owner'
    );
    CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_movements(product_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_batch_product_expiry ON inventory_batches(product_id, expiry_date);

    CREATE TABLE IF NOT EXISTS purchase_bills (
      id INTEGER PRIMARY KEY,
      bill_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER REFERENCES parties(id),
      supplier_bill_number TEXT,
      bill_date TEXT NOT NULL,
      subtotal_paise INTEGER NOT NULL DEFAULT 0,
      cgst_paise INTEGER NOT NULL DEFAULT 0,
      sgst_paise INTEGER NOT NULL DEFAULT 0,
      igst_paise INTEGER NOT NULL DEFAULT 0,
      roundoff_paise INTEGER NOT NULL DEFAULT 0,
      total_paise INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN ('UNPAID','PART_PAID','PAID')),
      status TEXT NOT NULL DEFAULT 'POSTED' CHECK(status IN ('DRAFT','POSTED','VOID')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY,
      purchase_bill_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_number TEXT NOT NULL,
      expiry_date TEXT,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_cost_paise INTEGER NOT NULL CHECK(unit_cost_paise >= 0),
      gst_bps INTEGER NOT NULL DEFAULT 0,
      taxable_paise INTEGER NOT NULL,
      cgst_paise INTEGER NOT NULL DEFAULT 0,
      sgst_paise INTEGER NOT NULL DEFAULT 0,
      igst_paise INTEGER NOT NULL DEFAULT 0,
      line_total_paise INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES parties(id),
      order_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('DRAFT','CONFIRMED','PACKING','DELIVERED','CANCELLED','INVOICED')),
      delivery_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_paise INTEGER NOT NULL CHECK(unit_price_paise >= 0),
      gst_bps INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL CHECK(channel IN ('RETAIL','DISTRIBUTION')),
      customer_id INTEGER REFERENCES parties(id),
      sales_order_id INTEGER REFERENCES sales_orders(id),
      invoice_date TEXT NOT NULL,
      delivery_date TEXT,
      due_date TEXT,
      subtotal_paise INTEGER NOT NULL DEFAULT 0,
      cgst_paise INTEGER NOT NULL DEFAULT 0,
      sgst_paise INTEGER NOT NULL DEFAULT 0,
      igst_paise INTEGER NOT NULL DEFAULT 0,
      roundoff_paise INTEGER NOT NULL DEFAULT 0,
      total_paise INTEGER NOT NULL DEFAULT 0,
      paid_paise INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'POSTED' CHECK(status IN ('DRAFT','POSTED','VOID','RETURNED')),
      payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN ('UNPAID','PART_PAID','PAID')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_customer_due ON invoices(customer_id, due_date, payment_status);

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_paise INTEGER NOT NULL CHECK(unit_price_paise >= 0),
      gst_bps INTEGER NOT NULL DEFAULT 0,
      taxable_paise INTEGER NOT NULL,
      cgst_paise INTEGER NOT NULL DEFAULT 0,
      sgst_paise INTEGER NOT NULL DEFAULT 0,
      igst_paise INTEGER NOT NULL DEFAULT 0,
      line_total_paise INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      party_id INTEGER REFERENCES parties(id),
      invoice_id INTEGER REFERENCES invoices(id),
      payment_date TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('RECEIPT','PAYMENT')),
      method TEXT NOT NULL CHECK(method IN ('CASH','UPI','CARD','BANK','CREDIT','OTHER')),
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      reference_number TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS party_ledger_entries (
      id INTEGER PRIMARY KEY,
      party_id INTEGER NOT NULL REFERENCES parties(id),
      entry_date TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('SALE','PURCHASE','RECEIPT','PAYMENT','SALES_RETURN','PURCHASE_RETURN','OPENING_ADJUSTMENT')),
      debit_paise INTEGER NOT NULL DEFAULT 0,
      credit_paise INTEGER NOT NULL DEFAULT 0,
      reference_type TEXT,
      reference_id INTEGER,
      narration TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(debit_paise >= 0 AND credit_paise >= 0 AND (debit_paise > 0 OR credit_paise > 0))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_party_date ON party_ledger_entries(party_id, entry_date, id);

    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY,
      return_number TEXT NOT NULL UNIQUE,
      return_type TEXT NOT NULL CHECK(return_type IN ('SALES_RETURN','PURCHASE_RETURN')),
      party_id INTEGER REFERENCES parties(id),
      invoice_id INTEGER REFERENCES invoices(id),
      purchase_bill_id INTEGER REFERENCES purchase_bills(id),
      return_date TEXT NOT NULL,
      total_paise INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'POSTED' CHECK(status IN ('POSTED','VOID')),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY,
      return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
      source_item_id INTEGER,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_id INTEGER REFERENCES inventory_batches(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_paise INTEGER NOT NULL DEFAULT 0,
      gst_bps INTEGER NOT NULL DEFAULT 0,
      line_total_paise INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      expense_number TEXT NOT NULL UNIQUE,
      expense_date TEXT NOT NULL,
      category TEXT NOT NULL,
      payee TEXT,
      method TEXT NOT NULL DEFAULT 'CASH',
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      gst_bps INTEGER NOT NULL DEFAULT 0,
      gst_paise INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminder_history (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      channel TEXT NOT NULL CHECK(channel IN ('WHATSAPP','MANUAL','SYSTEM')),
      recipient TEXT,
      status TEXT NOT NULL CHECK(status IN ('QUEUED','SENT','FAILED','SKIPPED')),
      message TEXT NOT NULL,
      provider_message_id TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor TEXT NOT NULL DEFAULT 'Owner',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, occurred_at);
  `);
  // A small forward-only migration for databases created by an earlier FrostFlow build.
  const returnItemColumns = db.prepare('PRAGMA table_info(return_items)').all().map((column) => column.name);
  if (!returnItemColumns.includes('source_item_id')) db.exec('ALTER TABLE return_items ADD COLUMN source_item_id INTEGER');
  if (!returnItemColumns.includes('source_allocation_id')) db.exec('ALTER TABLE return_items ADD COLUMN source_allocation_id INTEGER REFERENCES invoice_stock_allocations(id)');
  const productColumns = db.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  if (!productColumns.includes('purchase_price_paise')) db.exec('ALTER TABLE products ADD COLUMN purchase_price_paise INTEGER NOT NULL DEFAULT 0 CHECK(purchase_price_paise >= 0)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id INTEGER PRIMARY KEY,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(payment_id, invoice_id)
    );
    CREATE INDEX IF NOT EXISTS idx_payment_allocations_invoice ON payment_allocations(invoice_id);
    CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
      id INTEGER PRIMARY KEY,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      purchase_bill_id INTEGER NOT NULL REFERENCES purchase_bills(id),
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(payment_id, purchase_bill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_allocations_bill ON supplier_payment_allocations(purchase_bill_id);
    CREATE TABLE IF NOT EXISTS opening_credit_allocations (
      id INTEGER PRIMARY KEY,
      ledger_entry_id INTEGER NOT NULL REFERENCES party_ledger_entries(id),
      invoice_id INTEGER REFERENCES invoices(id),
      purchase_bill_id INTEGER REFERENCES purchase_bills(id),
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      CHECK ((invoice_id IS NOT NULL) != (purchase_bill_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_opening_credit_invoice ON opening_credit_allocations(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_opening_credit_purchase ON opening_credit_allocations(purchase_bill_id);
    CREATE INDEX IF NOT EXISTS idx_opening_credit_ledger ON opening_credit_allocations(ledger_entry_id);
    CREATE TABLE IF NOT EXISTS invoice_stock_allocations (
      id INTEGER PRIMARY KEY,
      invoice_item_id INTEGER NOT NULL REFERENCES invoice_items(id),
      batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_cost_paise INTEGER NOT NULL CHECK(unit_cost_paise >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_stock_item ON invoice_stock_allocations(invoice_item_id);
    CREATE INDEX IF NOT EXISTS idx_returns_invoice ON returns(invoice_id,return_type,status);
    CREATE INDEX IF NOT EXISTS idx_returns_purchase ON returns(purchase_bill_id,return_type,status);
    CREATE INDEX IF NOT EXISTS idx_return_items_source ON return_items(source_item_id,return_id);
    CREATE INDEX IF NOT EXISTS idx_return_items_allocation ON return_items(source_allocation_id);
    CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_id,direction,payment_date,id);
  `);

  if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='mrp_paise')) db.exec('ALTER TABLE products ADD COLUMN mrp_paise INTEGER NOT NULL DEFAULT 0 CHECK(mrp_paise>=0)');
  if(!db.prepare('PRAGMA table_info(invoice_items)').all().some(c=>c.name==='tax_inclusive')) db.exec('ALTER TABLE invoice_items ADD COLUMN tax_inclusive INTEGER NOT NULL DEFAULT 0');
  const defaults = [
    ['company_name', 'My Ice Cream Business'],
    ['company_gstin', ''],
    ['company_state_code', '27'],
    ['invoice_prefix', 'INV'],
    ['receipt_prefix', 'RCPT'],
    ['purchase_prefix', 'PUR'],
    ['order_prefix', 'ORD'],
    ['return_prefix', 'RET'],
    ['expense_prefix', 'EXP'],
    ['default_credit_days', '2'],
  ];
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaults) insertSetting.run(key, value);
  return db;
}

const transactionDepth = new WeakMap();
function inTransaction(db, work) {
  const depth = transactionDepth.get(db) || 0;
  const nested = depth > 0 || db.isTransaction === true;
  const savepoint = `erp_nested_${depth}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  transactionDepth.set(db, depth + 1);
  try {
    const result = work();
    if (result && typeof result.then === 'function') throw new Error('Database transactions must be synchronous.');
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); }
    else db.exec('ROLLBACK');
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}

module.exports = { openDatabase, inTransaction, DB_PATH, DATA_DIR };
