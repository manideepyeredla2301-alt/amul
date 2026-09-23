CREATE TABLE IF NOT EXISTS whatsapp_customers (
  phone TEXT PRIMARY KEY,
  display_name TEXT,
  shop_name TEXT,
  contact_name TEXT,
  gstin TEXT,
  address TEXT,
  location_url TEXT,
  location_lat REAL,
  location_lng REAL,
  last_order_id TEXT,
  last_order_at TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_customers_name ON whatsapp_customers(shop_name, display_name);
CREATE INDEX IF NOT EXISTS idx_whatsapp_customers_updated ON whatsapp_customers(updated_at DESC);

ALTER TABLE orders ADD COLUMN contact_name TEXT;
ALTER TABLE orders ADD COLUMN gstin TEXT;
ALTER TABLE orders ADD COLUMN location_url TEXT;
ALTER TABLE orders ADD COLUMN location_lat REAL;
ALTER TABLE orders ADD COLUMN location_lng REAL;

ALTER TABLE whatsapp_events ADD COLUMN customer_name TEXT;
ALTER TABLE whatsapp_events ADD COLUMN direction TEXT;
ALTER TABLE whatsapp_events ADD COLUMN order_id TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_events_phone_received
ON whatsapp_events(from_number, received_at DESC);
