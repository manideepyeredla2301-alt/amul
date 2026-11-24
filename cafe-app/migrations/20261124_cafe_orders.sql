CREATE TABLE IF NOT EXISTS cafe_orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  tracking_token TEXT NOT NULL UNIQUE,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('DINE_IN', 'TAKEAWAY')),
  table_number TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED')),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cafe_orders_status_created
  ON cafe_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS cafe_order_items (
  order_id TEXT NOT NULL REFERENCES cafe_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  options_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (order_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_cafe_order_items_order
  ON cafe_order_items(order_id);

CREATE TABLE IF NOT EXISTS cafe_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cafe_admin_sessions_expires
  ON cafe_admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS cafe_auth_attempts (
  ip_hash TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  window_started INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cafe_order_rate (
  ip_hash TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  order_count INTEGER NOT NULL
);
