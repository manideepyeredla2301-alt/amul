-- Preserve the migration archive as an auditable, read-only source for
-- reconciliation screens. Business data is inserted separately and is never
-- committed with this schema migration.
CREATE TABLE IF NOT EXISTS local_migration_archive (
  source_table TEXT NOT NULL,
  row_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_table, row_key)
);

CREATE INDEX IF NOT EXISTS idx_migration_archive_source
ON local_migration_archive(source_table, imported_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_source_stock_seen
ON inventory(source_stock_seen_at)
WHERE source_stock_qty IS NOT NULL;
