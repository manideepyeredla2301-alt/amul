-- Wholesale phone and imported online orders are picked independently of the
-- customer order reservation and official invoice ledgers. Drafts do not post.
CREATE TABLE IF NOT EXISTS wholesale_pick_orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('PHONE','ONLINE')),
  source_ref TEXT UNIQUE,
  customer_key TEXT,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  route_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','PICKING','HOLD','READY','DRAFTED','COMPLETED','CANCELLED')),
  external_invoice_number TEXT,
  completed_at TEXT,
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wholesale_pick_orders_queue
ON wholesale_pick_orders(status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wholesale_external_invoice_number
ON wholesale_pick_orders(external_invoice_number COLLATE NOCASE)
WHERE external_invoice_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS wholesale_pick_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES wholesale_pick_orders(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL,
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  requested_quantity REAL NOT NULL CHECK(requested_quantity>0),
  picked_quantity REAL CHECK(picked_quantity IS NULL OR picked_quantity>=0),
  unit_code TEXT NOT NULL DEFAULT 'BASE',
  unit_label TEXT NOT NULL DEFAULT 'PC',
  unit_factor INTEGER NOT NULL DEFAULT 1 CHECK(unit_factor>0),
  unit_price_paise INTEGER NOT NULL DEFAULT 0 CHECK(unit_price_paise>=0),
  gst_bps INTEGER NOT NULL DEFAULT 0 CHECK(gst_bps BETWEEN 0 AND 10000),
  shortage_reason TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  UNIQUE(order_id,sort_order)
);
CREATE INDEX IF NOT EXISTS idx_wholesale_pick_lines_order
ON wholesale_pick_lines(order_id,sort_order);

CREATE TABLE IF NOT EXISTS wholesale_invoice_drafts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES wholesale_pick_orders(id),
  draft_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  subtotal_paise INTEGER NOT NULL CHECK(subtotal_paise>=0),
  tax_paise INTEGER NOT NULL DEFAULT 0 CHECK(tax_paise>=0),
  total_paise INTEGER NOT NULL CHECK(total_paise>=0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wholesale_invoice_draft_lines (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES wholesale_invoice_drafts(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL CHECK(quantity>0),
  unit_label TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL CHECK(unit_price_paise>0),
  gst_bps INTEGER NOT NULL DEFAULT 0,
  subtotal_paise INTEGER NOT NULL,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(draft_id,sort_order)
);
CREATE TABLE IF NOT EXISTS wholesale_pick_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES wholesale_pick_orders(id),
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wholesale_pick_audit_order
ON wholesale_pick_audit(order_id,created_at DESC);

CREATE TRIGGER IF NOT EXISTS wholesale_draft_locks_lines
BEFORE UPDATE ON wholesale_pick_lines
WHEN EXISTS (SELECT 1 FROM wholesale_pick_orders o WHERE o.id=OLD.order_id AND o.status IN ('DRAFTED','COMPLETED','CANCELLED'))
BEGIN
  SELECT RAISE(ABORT,'DRAFT_LOCKED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_draft_locks_line_inserts
BEFORE INSERT ON wholesale_pick_lines
WHEN EXISTS (SELECT 1 FROM wholesale_pick_orders o WHERE o.id=NEW.order_id AND o.status IN ('DRAFTED','COMPLETED','CANCELLED'))
BEGIN
  SELECT RAISE(ABORT,'DRAFT_LOCKED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_draft_locks_line_deletes
BEFORE DELETE ON wholesale_pick_lines
WHEN EXISTS (SELECT 1 FROM wholesale_pick_orders o WHERE o.id=OLD.order_id AND o.status IN ('DRAFTED','COMPLETED','CANCELLED'))
BEGIN
  SELECT RAISE(ABORT,'DRAFT_LOCKED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_draft_requires_ready
BEFORE INSERT ON wholesale_invoice_drafts
WHEN NOT EXISTS (SELECT 1 FROM wholesale_pick_orders o WHERE o.id=NEW.order_id AND o.status='READY')
BEGIN
  SELECT RAISE(ABORT,'ORDER_NOT_READY');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_draft_locks_status
BEFORE UPDATE OF status ON wholesale_pick_orders
WHEN (OLD.status='DRAFTED' AND NEW.status NOT IN ('DRAFTED','COMPLETED','CANCELLED'))
  OR (OLD.status IN ('COMPLETED','CANCELLED') AND NEW.status<>OLD.status)
BEGIN
  SELECT RAISE(ABORT,'DRAFT_LOCKED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_terminal_order_locks_fields
BEFORE UPDATE ON wholesale_pick_orders
WHEN OLD.status IN ('COMPLETED','CANCELLED')
BEGIN
  SELECT RAISE(ABORT,'ORDER_CLOSED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_completion_requires_source
BEFORE UPDATE OF status ON wholesale_pick_orders
WHEN NEW.status IN ('COMPLETED','CANCELLED') AND OLD.status<>NEW.status
  AND OLD.source_ref IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.id=OLD.source_ref
      AND o.status IN ('NEW','SYNCED') AND o.workflow_status IN ('RECEIVED','CONFIRMED')
      AND o.invoice_job_id IS NULL AND o.invoice_number IS NULL
  )
BEGIN
  SELECT RAISE(ABORT,'SOURCE_ORDER_CHANGED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_completion_requires_invoice
BEFORE UPDATE OF status ON wholesale_pick_orders
WHEN NEW.status='COMPLETED' AND OLD.status<>NEW.status
  AND (OLD.status<>'DRAFTED' OR TRIM(COALESCE(NEW.external_invoice_number,''))='')
BEGIN
  SELECT RAISE(ABORT,'FINAL_INVOICE_REQUIRED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_completion_matches_synced_invoice
BEFORE UPDATE OF status ON wholesale_pick_orders
WHEN NEW.status='COMPLETED' AND OLD.status<>NEW.status
  AND (
    (SELECT COUNT(*) FROM invoices i WHERE UPPER(TRIM(i.invoice_number))=UPPER(TRIM(NEW.external_invoice_number))
      AND i.status='POSTED' AND i.deleted_at IS NULL AND i.source IN ('AMUL','LOCAL')
      AND i.source_device<>'cloudflare-admin' AND i.invoice_date>=date(OLD.created_at,'+5 hours','+30 minutes'))<>1
    OR (OLD.customer_key LIKE 'AMUL:%' AND EXISTS (
      SELECT 1 FROM invoices i WHERE UPPER(TRIM(i.invoice_number))=UPPER(TRIM(NEW.external_invoice_number))
        AND i.status='POSTED' AND i.deleted_at IS NULL AND i.source IN ('AMUL','LOCAL')
        AND i.source_device<>'cloudflare-admin' AND i.customer_id LIKE 'AMUL:%' AND i.customer_id<>OLD.customer_key
    ))
  )
BEGIN
  SELECT RAISE(ABORT,'SYNCED_INVOICE_MISMATCH');
END;

-- The old Orders page must not invoice or pick an online order after it was
-- copied into this checklist. A sync acknowledgement (NEW -> SYNCED) remains
-- permitted because it only records transport, not fulfilment.
CREATE TRIGGER IF NOT EXISTS wholesale_import_requires_unstarted_order
BEFORE INSERT ON wholesale_pick_orders
WHEN NEW.source_ref IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM orders o WHERE o.id=NEW.source_ref
    AND o.status IN ('NEW','SYNCED') AND o.workflow_status IN ('RECEIVED','CONFIRMED')
    AND o.invoice_job_id IS NULL AND o.invoice_number IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'SOURCE_ORDER_STARTED');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_import_locks_source_workflow
BEFORE UPDATE OF workflow_status,status,invoice_job_id,invoice_number ON orders
WHEN EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=OLD.id)
  AND NOT (
    NEW.workflow_status=OLD.workflow_status AND NEW.status IN ('NEW','SYNCED')
      AND NEW.invoice_job_id IS OLD.invoice_job_id AND NEW.invoice_number IS OLD.invoice_number
    OR NEW.status='FULFILLED' AND NEW.workflow_status='INVOICED'
      AND NEW.invoice_job_id IS OLD.invoice_job_id
      AND EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=OLD.id
        AND p.status='COMPLETED' AND p.external_invoice_number=NEW.invoice_number)
    OR NEW.status='CANCELLED' AND NEW.workflow_status='CANCELLED'
      AND NEW.invoice_job_id IS OLD.invoice_job_id AND NEW.invoice_number IS OLD.invoice_number
      AND EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=OLD.id AND p.status='CANCELLED')
  )
BEGIN
  SELECT RAISE(ABORT,'USE_WHOLESALE_CHECKLIST');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_import_locks_source_picks
BEFORE UPDATE OF picked_qty ON order_lines
WHEN EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=OLD.order_id)
BEGIN
  SELECT RAISE(ABORT,'USE_WHOLESALE_CHECKLIST');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_import_locks_invoice_jobs
BEFORE INSERT ON invoice_jobs
WHEN EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT,'USE_WHOLESALE_CHECKLIST');
END;
CREATE TRIGGER IF NOT EXISTS wholesale_import_locks_posted_invoices
BEFORE INSERT ON invoices
WHEN NEW.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT,'USE_WHOLESALE_CHECKLIST');
END;
