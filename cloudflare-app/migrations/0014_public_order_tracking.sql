-- Unguessable customer links for public order tracking and invoice viewing.
ALTER TABLE orders ADD COLUMN public_token TEXT;

UPDATE orders
SET public_token = lower(hex(randomblob(24)))
WHERE public_token IS NULL OR public_token = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_token
ON orders(public_token) WHERE public_token IS NOT NULL;
