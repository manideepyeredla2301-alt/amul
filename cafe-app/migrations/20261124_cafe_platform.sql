-- Café platform extension. All names are scoped to the café and leave the ERP schema intact.
CREATE TABLE IF NOT EXISTS cafe_outlets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO cafe_outlets(id,name) VALUES('main','Amul Ice Cream & Café');

CREATE TABLE IF NOT EXISTS cafe_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  serving TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  show_qr INTEGER NOT NULL DEFAULT 1 CHECK (show_qr IN (0,1)),
  show_pos INTEGER NOT NULL DEFAULT 1 CHECK (show_pos IN (0,1)),
  show_retail INTEGER NOT NULL DEFAULT 0 CHECK (show_retail IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cafe_categories_order ON cafe_categories(sort_order,id);

CREATE TABLE IF NOT EXISTS cafe_option_groups (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cafe_products (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES cafe_categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('PREPARED','RETAIL')),
  image_url TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  mrp_paise INTEGER CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  cost_paise INTEGER CHECK (cost_paise IS NULL OR cost_paise >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  sku TEXT UNIQUE,
  barcode TEXT UNIQUE,
  brand TEXT NOT NULL DEFAULT '',
  pack_size TEXT NOT NULL DEFAULT '',
  veg_type TEXT NOT NULL DEFAULT 'VEG' CHECK (veg_type IN ('VEG','NON_VEG','EGG')),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
  track_stock INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1)),
  stock_quantity REAL NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  low_stock_threshold REAL NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  prep_minutes INTEGER NOT NULL DEFAULT 10 CHECK (prep_minutes BETWEEN 0 AND 240),
  kitchen_route INTEGER NOT NULL DEFAULT 1 CHECK (kitchen_route IN (0,1)),
  option_groups_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(option_groups_json)),
  prep_steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prep_steps_json)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cafe_products_category ON cafe_products(category_id,sort_order,id);
CREATE INDEX IF NOT EXISTS idx_cafe_products_lookup ON cafe_products(type,active,available);

CREATE TABLE IF NOT EXISTS cafe_product_images (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  blob_data BLOB,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cafe_staff_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','CASHIER','KITCHEN')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cafe_staff_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES cafe_staff_users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cafe_staff_sessions_expires ON cafe_staff_sessions(expires_at);

CREATE TABLE IF NOT EXISTS cafe_ingredients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('g','ml','each')),
  stock_quantity REAL NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  low_stock_quantity REAL NOT NULL DEFAULT 0 CHECK (low_stock_quantity >= 0),
  cost_paise_per_unit REAL CHECK (cost_paise_per_unit IS NULL OR cost_paise_per_unit >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cafe_recipes (
  product_id TEXT NOT NULL REFERENCES cafe_products(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES cafe_ingredients(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  PRIMARY KEY(product_id,ingredient_id)
);

CREATE TABLE IF NOT EXISTS cafe_stock_batches (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES cafe_products(id),
  ingredient_id TEXT REFERENCES cafe_ingredients(id),
  batch_number TEXT NOT NULL DEFAULT '',
  manufacturing_date TEXT,
  expiry_date TEXT,
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  cost_paise_per_unit REAL CHECK (cost_paise_per_unit IS NULL OR cost_paise_per_unit >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((product_id IS NULL) <> (ingredient_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_cafe_batches_product_expiry ON cafe_stock_batches(product_id,expiry_date);

CREATE TABLE IF NOT EXISTS cafe_stock_allocations (
  order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  batch_id TEXT NOT NULL REFERENCES cafe_stock_batches(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  PRIMARY KEY(order_id,line_no,batch_id),
  FOREIGN KEY(order_id,line_no) REFERENCES cafe_order_items(order_id,line_no) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cafe_inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES cafe_products(id),
  ingredient_id TEXT REFERENCES cafe_ingredients(id),
  batch_id TEXT REFERENCES cafe_stock_batches(id),
  order_id TEXT,
  quantity_delta REAL NOT NULL,
  reason TEXT NOT NULL,
  unit_cost_paise REAL,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((product_id IS NULL) <> (ingredient_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_cafe_inventory_product ON cafe_inventory_movements(product_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cafe_inventory_ingredient ON cafe_inventory_movements(ingredient_id,created_at DESC);

CREATE TABLE IF NOT EXISTS cafe_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES cafe_orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('CASH','UPI','CARD')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','REFUNDED')),
  recorded_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cafe_payments_order ON cafe_payments(order_id,created_at);

CREATE TABLE IF NOT EXISTS cafe_refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES cafe_payments(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reason TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cafe_order_returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES cafe_orders(id),
  line_no INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  reason TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(order_id,line_no) REFERENCES cafe_order_items(order_id,line_no)
);

CREATE TABLE IF NOT EXISTS cafe_order_holds (
  id TEXT PRIMARY KEY,
  staff_username TEXT NOT NULL,
  cart_json TEXT NOT NULL CHECK (json_valid(cart_json)),
  customer_name TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT 'COUNTER',
  table_number TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cafe_promotions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('FREE_ITEM','PERCENT','FIXED')),
  threshold_paise INTEGER NOT NULL DEFAULT 0,
  discount_value INTEGER NOT NULL DEFAULT 0,
  free_product_id TEXT REFERENCES cafe_products(id),
  eligible_category_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(eligible_category_ids_json)),
  eligible_product_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(eligible_product_ids_json)),
  minimum_spend_paise INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  usage_limit INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cafe_promotion_redemptions (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES cafe_promotions(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES cafe_orders(id),
  discount_paise INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cafe_qr_codes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  context TEXT NOT NULL CHECK (context IN ('GENERAL','TABLE','TAKEAWAY','COUNTER')),
  table_number TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cafe_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cafe_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cafe_audit_created ON cafe_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS cafe_revision (
  id INTEGER PRIMARY KEY CHECK (id=1),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO cafe_revision(id,version) VALUES(1,1);

ALTER TABLE cafe_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'QR';
ALTER TABLE cafe_orders ADD COLUMN request_hash TEXT;
ALTER TABLE cafe_orders ADD COLUMN order_context TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE cafe_orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'UNPAID';
ALTER TABLE cafe_orders ADD COLUMN payment_preference TEXT;
ALTER TABLE cafe_orders ADD COLUMN subtotal_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cafe_orders ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cafe_orders ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cafe_orders ADD COLUMN accepted_at TEXT;
ALTER TABLE cafe_orders ADD COLUMN created_by TEXT;
ALTER TABLE cafe_orders ADD COLUMN promotion_id TEXT;
ALTER TABLE cafe_orders ADD COLUMN outlet_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE cafe_order_items ADD COLUMN product_type TEXT NOT NULL DEFAULT 'PREPARED';
ALTER TABLE cafe_order_items ADD COLUMN kitchen_route INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cafe_order_items ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE cafe_order_items ADD COLUMN is_complimentary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cafe_order_items ADD COLUMN tax_paise INTEGER NOT NULL DEFAULT 0;

UPDATE cafe_orders SET subtotal_paise=total_paise WHERE subtotal_paise=0;

-- Trigger based stock consumption makes stock checks atomic with order item inserts.
CREATE TRIGGER IF NOT EXISTS cafe_retail_stock_sale AFTER INSERT ON cafe_order_items
WHEN NEW.product_type='RETAIL'
BEGIN
  UPDATE cafe_products SET stock_quantity=stock_quantity-NEW.quantity
    WHERE id=NEW.item_id AND track_stock=1 AND stock_quantity>=NEW.quantity;
  SELECT RAISE(ABORT,'Insufficient stock')
    WHERE (SELECT track_stock FROM cafe_products WHERE id=NEW.item_id)=1 AND changes()=0;
  INSERT INTO cafe_inventory_movements(id,product_id,order_id,quantity_delta,reason)
    SELECT lower(hex(randomblob(16))),NEW.item_id,NEW.order_id,-NEW.quantity,'SALE'
    WHERE (SELECT track_stock FROM cafe_products WHERE id=NEW.item_id)=1;
END;

CREATE TRIGGER IF NOT EXISTS cafe_recipe_stock_sale AFTER INSERT ON cafe_order_items
WHEN NEW.product_type='PREPARED' AND (SELECT track_stock FROM cafe_products WHERE id=NEW.item_id)=1
  AND EXISTS (SELECT 1 FROM cafe_recipes WHERE product_id=NEW.item_id)
BEGIN
  SELECT RAISE(ABORT,'Insufficient ingredient stock')
    WHERE EXISTS (
      SELECT 1 FROM cafe_recipes r JOIN cafe_ingredients i ON i.id=r.ingredient_id
      WHERE r.product_id=NEW.item_id AND i.stock_quantity<r.quantity*NEW.quantity
    );
  UPDATE cafe_ingredients SET stock_quantity=stock_quantity-NEW.quantity*(
    SELECT quantity FROM cafe_recipes WHERE product_id=NEW.item_id AND ingredient_id=cafe_ingredients.id)
    WHERE id IN (SELECT ingredient_id FROM cafe_recipes WHERE product_id=NEW.item_id);
  INSERT INTO cafe_inventory_movements(id,ingredient_id,order_id,quantity_delta,reason)
    SELECT lower(hex(randomblob(16))),ingredient_id,NEW.order_id,-quantity*NEW.quantity,'RECIPE'
    FROM cafe_recipes WHERE product_id=NEW.item_id;
END;
CREATE TRIGGER IF NOT EXISTS cafe_prepared_product_stock_sale AFTER INSERT ON cafe_order_items
WHEN NEW.product_type='PREPARED' AND (SELECT track_stock FROM cafe_products WHERE id=NEW.item_id)=1
  AND NOT EXISTS (SELECT 1 FROM cafe_recipes WHERE product_id=NEW.item_id)
BEGIN
  UPDATE cafe_products SET stock_quantity=stock_quantity-NEW.quantity
    WHERE id=NEW.item_id AND stock_quantity>=NEW.quantity;
  SELECT RAISE(ABORT,'Insufficient stock') WHERE changes()=0;
  INSERT INTO cafe_inventory_movements(id,product_id,order_id,quantity_delta,reason)
    VALUES(lower(hex(randomblob(16))),NEW.item_id,NEW.order_id,-NEW.quantity,'SALE');
END;

CREATE TRIGGER IF NOT EXISTS cafe_order_created_revision AFTER INSERT ON cafe_orders
BEGIN UPDATE cafe_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cafe_order_changed_revision AFTER UPDATE ON cafe_orders
BEGIN UPDATE cafe_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cafe_product_changed_revision AFTER UPDATE ON cafe_products
BEGIN UPDATE cafe_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cafe_payment_revision AFTER INSERT ON cafe_payments
BEGIN UPDATE cafe_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cafe_manual_product_stock AFTER INSERT ON cafe_inventory_movements
WHEN NEW.product_id IS NOT NULL AND NEW.reason<>'SALE'
BEGIN
  UPDATE cafe_products SET stock_quantity=stock_quantity+NEW.quantity_delta,updated_at=CURRENT_TIMESTAMP
    WHERE id=NEW.product_id AND stock_quantity+NEW.quantity_delta>=0;
  SELECT RAISE(ABORT,'Insufficient stock') WHERE changes()=0;
END;
CREATE TRIGGER IF NOT EXISTS cafe_manual_batch_wastage AFTER INSERT ON cafe_inventory_movements
WHEN NEW.batch_id IS NOT NULL AND NEW.quantity_delta<0 AND NEW.reason<>'SALE'
BEGIN
  UPDATE cafe_stock_batches SET quantity=quantity+NEW.quantity_delta
    WHERE id=NEW.batch_id AND quantity+NEW.quantity_delta>=0;
  SELECT RAISE(ABORT,'Insufficient batch stock') WHERE changes()=0;
END;
CREATE TRIGGER IF NOT EXISTS cafe_batch_allocation AFTER INSERT ON cafe_stock_allocations
BEGIN
  UPDATE cafe_stock_batches SET quantity=quantity-NEW.quantity
    WHERE id=NEW.batch_id AND product_id=(SELECT item_id FROM cafe_order_items
      WHERE order_id=NEW.order_id AND line_no=NEW.line_no)
      AND quantity>=NEW.quantity
      AND (expiry_date IS NULL OR expiry_date>=date('now','+5 hours','+30 minutes'));
  SELECT RAISE(ABORT,'Batch is expired or out of stock') WHERE changes()=0;
END;
CREATE TRIGGER IF NOT EXISTS cafe_manual_ingredient_stock AFTER INSERT ON cafe_inventory_movements
WHEN NEW.ingredient_id IS NOT NULL AND NEW.reason<>'RECIPE'
BEGIN
  UPDATE cafe_ingredients SET stock_quantity=stock_quantity+NEW.quantity_delta,updated_at=CURRENT_TIMESTAMP
    WHERE id=NEW.ingredient_id AND stock_quantity+NEW.quantity_delta>=0;
  SELECT RAISE(ABORT,'Insufficient ingredient stock') WHERE changes()=0;
END;
CREATE TRIGGER IF NOT EXISTS cafe_payment_limit BEFORE INSERT ON cafe_payments
BEGIN
  SELECT RAISE(ABORT,'Payment exceeds order total') WHERE
    NEW.amount_paise+(SELECT COALESCE(SUM(amount_paise),0) FROM cafe_payments WHERE order_id=NEW.order_id)
    -(SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id WHERE p.order_id=NEW.order_id)
    >(SELECT total_paise FROM cafe_orders WHERE id=NEW.order_id);
END;
CREATE TRIGGER IF NOT EXISTS cafe_payment_status AFTER INSERT ON cafe_payments
BEGIN
  UPDATE cafe_orders SET payment_status=CASE
    WHEN (SELECT COALESCE(SUM(amount_paise),0) FROM cafe_payments WHERE order_id=NEW.order_id)-
      (SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id WHERE p.order_id=NEW.order_id)
      >=(SELECT total_paise FROM cafe_orders WHERE id=NEW.order_id) THEN 'PAID'
    ELSE 'PARTIAL' END,updated_at=CURRENT_TIMESTAMP WHERE id=NEW.order_id;
END;
CREATE TRIGGER IF NOT EXISTS cafe_refund_limit BEFORE INSERT ON cafe_refunds
BEGIN
  SELECT RAISE(ABORT,'Refund exceeds payment') WHERE NEW.amount_paise+
    (SELECT COALESCE(SUM(amount_paise),0) FROM cafe_refunds WHERE payment_id=NEW.payment_id)>
    (SELECT amount_paise FROM cafe_payments WHERE id=NEW.payment_id);
END;
CREATE TRIGGER IF NOT EXISTS cafe_return_limit BEFORE INSERT ON cafe_order_returns
BEGIN
  SELECT RAISE(ABORT,'Return exceeds sold quantity') WHERE NEW.quantity+
    (SELECT COALESCE(SUM(quantity),0) FROM cafe_order_returns WHERE order_id=NEW.order_id AND line_no=NEW.line_no)>
    (SELECT quantity FROM cafe_order_items WHERE order_id=NEW.order_id AND line_no=NEW.line_no);
END;
CREATE TRIGGER IF NOT EXISTS cafe_promotion_limit BEFORE INSERT ON cafe_promotion_redemptions
BEGIN
  SELECT RAISE(ABORT,'Promotion no longer available') WHERE NOT EXISTS(
    SELECT 1 FROM cafe_promotions WHERE id=NEW.promotion_id AND active=1 AND (usage_limit IS NULL OR usage_count<usage_limit)
  );
  UPDATE cafe_promotions SET usage_count=usage_count+1 WHERE id=NEW.promotion_id;
END;

INSERT OR IGNORE INTO cafe_settings(key,value) VALUES('shop_name','Amul Ice Cream & Café');
INSERT OR IGNORE INTO cafe_settings(key,value) VALUES('receipt_footer','Thank you for visiting!');
INSERT OR IGNORE INTO cafe_settings(key,value) VALUES('currency','INR');
