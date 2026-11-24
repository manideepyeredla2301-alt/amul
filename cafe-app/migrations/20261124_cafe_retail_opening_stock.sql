-- Owner-requested opening count: 20 pieces per curated Amul retail SKU.
-- Keep the 45 review-disabled products unavailable; do not invent cost, expiry, or barcode.
-- A batch must exist before a tracked retail item can be sold through POS.
INSERT OR IGNORE INTO cafe_stock_batches(id,product_id,batch_number,quantity)
SELECT 'amul-opening-20261124-' || p.sku,p.id,'UNSPECIFIED',20
FROM cafe_products p
WHERE p.id LIKE 'amul-%' AND p.type='RETAIL' AND p.track_stock=1 AND p.stock_quantity=0
  AND NOT EXISTS (SELECT 1 FROM cafe_stock_batches b WHERE b.product_id=p.id)
  AND NOT EXISTS (SELECT 1 FROM cafe_inventory_movements m WHERE m.product_id=p.id);

-- The stock movement trigger updates cafe_products.stock_quantity and the live POS revision.
INSERT OR IGNORE INTO cafe_inventory_movements
  (id,product_id,batch_id,quantity_delta,reason,actor)
SELECT 'amul-opening-movement-20261124-' || p.sku,p.id,b.id,20,'OPENING','owner-request'
FROM cafe_products p
JOIN cafe_stock_batches b ON b.id='amul-opening-20261124-' || p.sku
WHERE p.id LIKE 'amul-%' AND p.type='RETAIL' AND p.track_stock=1 AND p.stock_quantity=0
  AND NOT EXISTS (SELECT 1 FROM cafe_inventory_movements m WHERE m.product_id=p.id);

INSERT OR IGNORE INTO cafe_audit_log(id,actor,action,entity_type,entity_id,detail_json)
SELECT 'amul-opening-audit-20261124-' || p.sku,'owner-request','STOCK_ADJUST','PRODUCT',p.id,
  '{"quantity_delta":20,"reason":"OPENING","batch_number":"UNSPECIFIED"}'
FROM cafe_products p
JOIN cafe_inventory_movements m ON m.id='amul-opening-movement-20261124-' || p.sku
WHERE p.id LIKE 'amul-%' AND p.type='RETAIL';
