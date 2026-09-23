DROP TRIGGER IF EXISTS reserve_order_line;

CREATE TRIGGER reserve_order_line
BEFORE INSERT ON order_lines
BEGIN
  SELECT CASE WHEN COALESCE((
    SELECT CASE
      WHEN source_device = 'catalog-seed' THEN NEW.quantity
      ELSE stock_qty - reserved_qty
    END
    FROM inventory
    WHERE product_id = NEW.product_id AND active = 1
  ), -1) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;

  UPDATE inventory
  SET reserved_qty = reserved_qty + NEW.quantity
  WHERE product_id = NEW.product_id
    AND source_device <> 'catalog-seed';
END;

CREATE TRIGGER IF NOT EXISTS release_order_reservation
AFTER UPDATE OF status ON orders
WHEN OLD.status IN ('NEW','SYNCED') AND NEW.status IN ('FULFILLED','CANCELLED')
BEGIN
  UPDATE inventory
  SET reserved_qty = MAX(0, reserved_qty - COALESCE((
    SELECT SUM(quantity) FROM order_lines
    WHERE order_id = NEW.id AND product_id = inventory.product_id
  ), 0))
  WHERE product_id IN (SELECT product_id FROM order_lines WHERE order_id = NEW.id);
END;
