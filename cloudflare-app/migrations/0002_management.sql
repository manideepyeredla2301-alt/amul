ALTER TABLE orders ADD COLUMN customer_id TEXT;
ALTER TABLE orders ADD COLUMN order_number TEXT;
ALTER TABLE orders ADD COLUMN route_name TEXT;
ALTER TABLE orders ADD COLUMN delivery_date TEXT;
ALTER TABLE orders ADD COLUMN total_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'RECEIVED';
ALTER TABLE orders ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('LOCAL','AMUL')),
  source_id TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  mobile TEXT,
  whatsapp_number TEXT,
  gstin TEXT,
  address TEXT,
  city TEXT,
  route_id TEXT,
  route_name TEXT,
  credit_days INTEGER NOT NULL DEFAULT 0,
  credit_limit_paise INTEGER NOT NULL DEFAULT 0,
  balance_paise INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_customers_active_name ON customers(active, name);
CREATE INDEX IF NOT EXISTS idx_customers_route ON customers(route_name, active);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('LOCAL','AMUL')),
  source_id TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_routes_active_name ON routes(active, name);

CREATE TABLE IF NOT EXISTS distribution_orders (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('LOCAL','AMUL')),
  source_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  phone TEXT,
  route_name TEXT,
  order_date TEXT,
  delivery_date TEXT,
  status TEXT NOT NULL,
  total_paise INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  lines_json TEXT NOT NULL DEFAULT '[]',
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_distribution_orders_date ON distribution_orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_distribution_orders_status ON distribution_orders(status, delivery_date);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('LOCAL','AMUL')),
  source_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT,
  due_date TEXT,
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  mobile TEXT,
  route_name TEXT,
  total_paise INTEGER NOT NULL DEFAULT 0,
  paid_paise INTEGER NOT NULL DEFAULT 0,
  outstanding_paise INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(payment_status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, invoice_date DESC);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('LOCAL','AMUL')),
  source_id TEXT NOT NULL,
  receipt_number TEXT,
  payment_date TEXT,
  customer_id TEXT,
  customer_name TEXT,
  direction TEXT NOT NULL,
  method TEXT,
  amount_paise INTEGER NOT NULL DEFAULT 0,
  reference_number TEXT,
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC);

