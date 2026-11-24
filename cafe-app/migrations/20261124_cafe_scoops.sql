-- New regular-cup scoop menu. INSERT OR IGNORE preserves any owner-edited rows.
-- Pineapple is ₹40 as confirmed by the owner; each cone costs ₹10 extra.
INSERT OR IGNORE INTO cafe_categories(id,name,description,serving,image_url,sort_order,show_qr,show_pos)
  VALUES('scoops','Ice Cream Scoops','Choose a cup at the shown price or a cone for ₹10 more.','One regular scoop','/images/scoops.jpg',6,1,1);

INSERT OR IGNORE INTO cafe_option_groups(id,config_json) VALUES
  ('scoop-serving','{"name":"Serve it in","type":"single","required":true,"choices":[{"id":"cup","name":"Cup","priceDelta":0},{"id":"cone","name":"Cone","priceDelta":10}]}');

INSERT OR IGNORE INTO cafe_products(id,category_id,name,description,type,image_url,price_paise,veg_type,option_groups_json,prep_steps_json,prep_minutes,sort_order) VALUES
  ('scoop-vanilla','scoops','Vanilla Scoop','','PREPARED','',4000,'VEG','["scoop-serving"]','["Scoop one regular serving of Vanilla ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,1),
  ('scoop-strawberry','scoops','Strawberry Scoop','','PREPARED','',4000,'VEG','["scoop-serving"]','["Scoop one regular serving of Strawberry ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,2),
  ('scoop-blackcurrant','scoops','Blackcurrant Scoop','','PREPARED','',5000,'VEG','["scoop-serving"]','["Scoop one regular serving of Blackcurrant ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,3),
  ('scoop-cookies-cream','scoops','Cookies & Cream Scoop','','PREPARED','',5000,'VEG','["scoop-serving"]','["Scoop one regular serving of Cookies & Cream ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,4),
  ('scoop-choco-chips','scoops','Choco Chips Scoop','','PREPARED','',5000,'VEG','["scoop-serving"]','["Scoop one regular serving of Choco Chips ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,5),
  ('scoop-chocolate','scoops','Chocolate Scoop','','PREPARED','',5000,'VEG','["scoop-serving"]','["Scoop one regular serving of Chocolate ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,6),
  ('scoop-american-nuts','scoops','American Nuts Scoop','','PREPARED','',5000,'VEG','["scoop-serving"]','["Scoop one regular serving of American Nuts ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,7),
  ('scoop-butterscotch','scoops','Butterscotch Scoop','','PREPARED','',5000,'VEG','["scoop-serving"]','["Scoop one regular serving of Butterscotch ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,8),
  ('scoop-tender-coconut','scoops','Tender Coconut Scoop','','PREPARED','',6000,'VEG','["scoop-serving"]','["Scoop one regular serving of Tender Coconut ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,9),
  ('scoop-orange','scoops','Orange Scoop','','PREPARED','',4000,'VEG','["scoop-serving"]','["Scoop one regular serving of Orange ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,10),
  ('scoop-pineapple','scoops','Pineapple Scoop','','PREPARED','',4000,'VEG','["scoop-serving"]','["Scoop one regular serving of Pineapple ice cream using a clean scoop.","Serve it in the selected cup or cone immediately."]',2,11);

-- Extend only the untouched seeded ice-cream promotion. Owner-edited eligibility stays as set.
UPDATE cafe_promotions SET eligible_category_ids_json='["signature-sundaes","build-your-own-sundae","scoops","retail-cups","retail-cones","retail-bars","retail-sticks","retail-family-packs","retail-tubs","retail-multipacks","retail-novelties"]'
  WHERE id='ice-cream-free-fries'
    AND eligible_category_ids_json='["signature-sundaes","build-your-own-sundae","retail-cups","retail-cones","retail-bars","retail-sticks","retail-family-packs","retail-tubs","retail-multipacks","retail-novelties"]';
