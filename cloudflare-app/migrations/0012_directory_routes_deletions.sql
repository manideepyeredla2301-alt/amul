ALTER TABLE customers ADD COLUMN deleted_at TEXT;
ALTER TABLE whatsapp_customers ADD COLUMN deleted_at TEXT;
ALTER TABLE invoices ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS route_aliases (
  source_name TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_deleted_route ON customers(deleted_at, active, route_name);
CREATE INDEX IF NOT EXISTS idx_whatsapp_customers_deleted_route ON whatsapp_customers(deleted_at, route_name);
CREATE INDEX IF NOT EXISTS idx_invoices_deleted_date ON invoices(deleted_at, invoice_date DESC);
