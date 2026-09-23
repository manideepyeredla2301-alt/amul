DROP TRIGGER IF EXISTS reserve_order_line;

CREATE TRIGGER reserve_order_line
BEFORE INSERT ON order_lines
BEGIN
  SELECT CASE WHEN COALESCE((
    SELECT CASE
      WHEN manual_out_of_stock = 1 THEN 0
      ELSE stock_qty - reserved_qty
    END
    FROM inventory
    WHERE product_id = NEW.product_id AND active = 1
  ), -1) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;

  UPDATE inventory
  SET reserved_qty = reserved_qty + NEW.quantity
  WHERE product_id = NEW.product_id
    AND manual_out_of_stock = 0;
END;

CREATE TRIGGER IF NOT EXISTS release_order_reservation
AFTER UPDATE OF status ON orders
WHEN OLD.status IN ('NEW','SYNCED')
  AND NEW.status IN ('FULFILLED','CANCELLED')
  AND OLD.reservation_released=0
BEGIN
  UPDATE inventory
  SET reserved_qty = MAX(0, reserved_qty - COALESCE((
    SELECT SUM(quantity) FROM order_lines
    WHERE order_id = NEW.id AND product_id = inventory.product_id
  ), 0))
  WHERE product_id IN (SELECT product_id FROM order_lines WHERE order_id = NEW.id);

  UPDATE orders SET reservation_released=1 WHERE id=NEW.id;
END;

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
