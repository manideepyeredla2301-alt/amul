-- Cloudflare D1 is the operational source of truth. Amul SQL remains a
-- read-only upstream source whose snapshots refresh stock and accounts.
ALTER TABLE inventory ADD COLUMN manual_out_of_stock INTEGER NOT NULL DEFAULT 0 CHECK(manual_out_of_stock IN (0,1));
ALTER TABLE inventory ADD COLUMN stock_note TEXT;
ALTER TABLE inventory ADD COLUMN stock_control_updated_at TEXT;

ALTER TABLE order_lines ADD COLUMN picked_qty REAL NOT NULL DEFAULT 0 CHECK(picked_qty >= 0);
ALTER TABLE order_lines ADD COLUMN crated_qty REAL NOT NULL DEFAULT 0 CHECK(crated_qty >= 0);

ALTER TABLE orders ADD COLUMN crate_code TEXT;
ALTER TABLE orders ADD COLUMN picking_started_at TEXT;
ALTER TABLE orders ADD COLUMN packed_at TEXT;
ALTER TABLE orders ADD COLUMN invoice_job_id TEXT;
ALTER TABLE orders ADD COLUMN invoice_number TEXT;

CREATE TABLE IF NOT EXISTS purchase_topups (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES inventory(product_id),
  requested_qty REAL NOT NULL CHECK(requested_qty > 0),
  reference TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUPERSEDED','RECEIVED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_purchase_topups_active
ON purchase_topups(status, created_at DESC);

CREATE TABLE IF NOT EXISTS invoice_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','POSTED','FAILED')),
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  completed_at TEXT,
  external_invoice_id TEXT,
  invoice_number TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoice_jobs_status
ON invoice_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS operations_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_operations_audit_entity
ON operations_audit(entity_type, entity_id, created_at DESC);
