-- Cloud quantity is authoritative. Upstream totals are observations, not stock postings.
ALTER TABLE inventory ADD COLUMN source_stock_qty REAL;
ALTER TABLE inventory ADD COLUMN source_stock_seen_at TEXT;
