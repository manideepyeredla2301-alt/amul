-- Optional customer phone for staff checkout and held carts.
-- Existing orders remain without a number; public tracking responses omit this field.
ALTER TABLE cafe_orders ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '' CHECK (length(customer_phone) <= 16);
ALTER TABLE cafe_order_holds ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '' CHECK (length(customer_phone) <= 16);
