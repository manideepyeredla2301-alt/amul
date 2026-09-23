-- Online admin billing. Synced Amul/local invoices remain untouched; invoices
-- created by the Cloudflare admin are identified by source_device.
ALTER TABLE invoices ADD COLUMN request_id TEXT;
ALTER TABLE invoices ADD COLUMN subtotal_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN payment_method TEXT;
ALTER TABLE invoices ADD COLUMN notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_request_id
ON invoices(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_lines (
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES inventory(product_id),
  sku TEXT,
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL CHECK(unit_price_paise >= 0),
  gst_bps INTEGER NOT NULL DEFAULT 0 CHECK(gst_bps >= 0 AND gst_bps <= 5000),
  subtotal_paise INTEGER NOT NULL CHECK(subtotal_paise >= 0),
  tax_paise INTEGER NOT NULL CHECK(tax_paise >= 0),
  total_paise INTEGER NOT NULL CHECK(total_paise >= 0),
  PRIMARY KEY(invoice_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_product
ON invoice_lines(product_id, invoice_id);
