-- Give the newly added scoop flavours distinct, owner-replaceable photos.
-- Preserve any photo an owner has already uploaded.
UPDATE cafe_products SET image_url='/images/products/scoop-vanilla.jpg' WHERE id='scoop-vanilla' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-strawberry.jpg' WHERE id='scoop-strawberry' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-blackcurrant.jpg' WHERE id='scoop-blackcurrant' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-cookies-cream.jpg' WHERE id='scoop-cookies-cream' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-choco-chips.jpg' WHERE id='scoop-choco-chips' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-chocolate.jpg' WHERE id='scoop-chocolate' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-american-nuts.jpg' WHERE id='scoop-american-nuts' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-butterscotch.jpg' WHERE id='scoop-butterscotch' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-tender-coconut.jpg' WHERE id='scoop-tender-coconut' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-orange.jpg' WHERE id='scoop-orange' AND (image_url='' OR image_url='/images/scoops.jpg');
UPDATE cafe_products SET image_url='/images/products/scoop-pineapple.jpg' WHERE id='scoop-pineapple' AND (image_url='' OR image_url='/images/scoops.jpg');
