-- Customer ordering estimates and order-to-invoice checkout.
ALTER TABLE orders ADD COLUMN subtotal_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN gst_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN reservation_released INTEGER NOT NULL DEFAULT 0 CHECK(reservation_released IN (0,1));

ALTER TABLE order_lines ADD COLUMN gst_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN subtotal_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN total_paise INTEGER NOT NULL DEFAULT 0;

ALTER TABLE invoices ADD COLUMN order_id TEXT REFERENCES orders(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_order_id
ON invoices(order_id) WHERE order_id IS NOT NULL;

-- Customers first created from the public catalogue need the same route and
-- credit metadata as desktop customers.
ALTER TABLE whatsapp_customers ADD COLUMN route_name TEXT NOT NULL DEFAULT '';
ALTER TABLE whatsapp_customers ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE whatsapp_customers ADD COLUMN credit_days INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS release_order_reservation;
CREATE TRIGGER release_order_reservation
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
