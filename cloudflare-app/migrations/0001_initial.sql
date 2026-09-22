PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT PRIMARY KEY,
  sku TEXT,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  unit TEXT NOT NULL DEFAULT 'PCS',
  stock_qty REAL NOT NULL DEFAULT 0 CHECK(stock_qty >= 0),
  reserved_qty REAL NOT NULL DEFAULT 0 CHECK(reserved_qty >= 0),
  mrp_paise INTEGER NOT NULL DEFAULT 0 CHECK(mrp_paise >= 0),
  selling_price_paise INTEGER NOT NULL DEFAULT 0 CHECK(selling_price_paise >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_active_name ON inventory(active, product_name);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);

CREATE TABLE IF NOT EXISTS sync_runs (
  snapshot_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  product_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_completed ON sync_runs(completed_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('ONLINE','WHATSAPP')),
  customer_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','SYNCED','FULFILLED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES inventory(product_id),
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL,
  price_paise INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(order_id, line_no)
);

CREATE TABLE IF NOT EXISTS whatsapp_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  from_number TEXT,
  message_type TEXT,
  body TEXT,
  raw_json TEXT NOT NULL,
  event_time TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_received ON whatsapp_events(received_at DESC);
