DROP TRIGGER IF EXISTS consume_online_invoice_stock;

CREATE TRIGGER consume_online_invoice_stock
BEFORE INSERT ON invoice_lines
WHEN (SELECT source_device FROM invoices WHERE id=NEW.invoice_id)='cloudflare-admin'
BEGIN
  SELECT CASE WHEN COALESCE((
    SELECT CASE
      WHEN active=1 AND manual_out_of_stock=0 THEN stock_qty-reserved_qty
      ELSE 0
    END
    FROM inventory
    WHERE product_id=NEW.product_id
  ), -1) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;

  UPDATE inventory
  SET stock_qty=stock_qty-NEW.quantity,
      stock_control_updated_at=CURRENT_TIMESTAMP,
      synced_at=CURRENT_TIMESTAMP
  WHERE product_id=NEW.product_id;
END;

DROP TRIGGER IF EXISTS restore_voided_online_invoice_stock;

CREATE TRIGGER restore_voided_online_invoice_stock
AFTER UPDATE OF status ON invoices
WHEN OLD.source_device='cloudflare-admin' AND OLD.status<>'VOID' AND NEW.status='VOID'
BEGIN
  UPDATE inventory
  SET stock_qty=stock_qty+COALESCE((
        SELECT SUM(quantity)
        FROM invoice_lines
        WHERE invoice_id=NEW.id AND product_id=inventory.product_id
      ),0),
      stock_control_updated_at=CURRENT_TIMESTAMP,
      synced_at=CURRENT_TIMESTAMP
  WHERE product_id IN (
    SELECT product_id FROM invoice_lines WHERE invoice_id=NEW.id
  );
END;
