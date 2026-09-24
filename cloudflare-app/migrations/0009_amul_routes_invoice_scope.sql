-- Complete Amul route masters and the retailer-to-route mapping.
-- details_json keeps the full RouteMaster source row (weekday flags, van route,
-- distance, status codes) so nothing from the route master is lost in D1.
ALTER TABLE routes ADD COLUMN visit_days TEXT NOT NULL DEFAULT '';
ALTER TABLE routes ADD COLUMN customer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS customer_routes (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('LOCAL','AMUL')),
  source_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  source_device TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_routes_route ON customer_routes(route_id, active);
CREATE INDEX IF NOT EXISTS idx_customer_routes_customer ON customer_routes(customer_id, active);
CREATE INDEX IF NOT EXISTS idx_invoices_source_date ON invoices(source_device, invoice_date);
