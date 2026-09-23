CREATE TABLE IF NOT EXISTS whatsapp_auto_replies (
  from_number TEXT PRIMARY KEY,
  last_inbound_message_id TEXT NOT NULL,
  last_catalog_at TEXT,
  last_reply_message_id TEXT,
  status TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_auto_replies_updated
ON whatsapp_auto_replies(updated_at DESC);
