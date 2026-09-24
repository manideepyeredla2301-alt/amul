ALTER TABLE order_lines ADD COLUMN requested_quantity REAL;
ALTER TABLE order_lines ADD COLUMN requested_unit TEXT;
ALTER TABLE order_lines ADD COLUMN units_per_box INTEGER NOT NULL DEFAULT 1;

UPDATE order_lines
SET requested_quantity=quantity,
    requested_unit=CASE UPPER(TRIM(COALESCE(unit,'')))
      WHEN 'BX' THEN 'BOX'
      WHEN 'PCS' THEN 'PC'
      ELSE UPPER(TRIM(COALESCE(unit,'PC')))
    END,
    units_per_box=1
WHERE requested_quantity IS NULL;
