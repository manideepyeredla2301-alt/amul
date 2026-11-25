'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { WholesalePicking } = require('../src/services/wholesale-picking');

function fresh(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return { db, app: new WholesalePicking(db) };
}

test('phone order checklist makes one draft from picked quantities without posting an invoice or changing stock', t => {
  const { db, app } = fresh(t);
  db.prepare("INSERT INTO parties(id,party_type,code,name,mobile,active) VALUES(1,'CUSTOMER','C1','Corner Shop','9000011111',1)").run();
  db.prepare("INSERT INTO products(id,sku,name,unit,wholesale_price_paise,gst_bps,active) VALUES(1,'VAN','Vanilla Box','BOX',10000,500,1)").run();
  db.prepare("INSERT INTO products(id,sku,name,unit,wholesale_price_paise,gst_bps,active) VALUES(2,'CHO','Chocolate Box','BOX',12000,500,1)").run();
  db.prepare("INSERT INTO inventory_batches(id,product_id,batch_number,quantity_received,quantity_available) VALUES(1,1,'B1',20,20)").run();
  const order = app.createOrder({ customerKey: 'LOCAL:1', items: [
    { productKey: 'LOCAL:1', quantity: 4 }, { productKey: 'LOCAL:2', quantity: 2 },
  ] });
  assert.equal(order.source, 'PHONE');
  assert.equal(order.lines.length, 2);
  assert.equal(order.lines[0].pickedQuantity, null);
  assert.throws(() => app.setStatus(order.id, 'READY'), /Check every item/);
  assert.throws(() => app.setPicked(order.id, order.lines[0].id, { pickedQuantity: 3 }), /reason/);
  app.setPicked(order.id, order.lines[0].id, { pickedQuantity: 3, shortageReason: 'One box missing' });
  app.setPicked(order.id, order.lines[1].id, { pickedQuantity: 0, shortageReason: 'No stock' });
  const ready = app.setStatus(order.id, 'READY');
  assert.equal(ready.status, 'READY');
  const draft = app.createDraft(order.id);
  assert.equal(draft.draftNumber, 'DRAFT-00001');
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].quantity, 3);
  assert.equal(draft.subtotalPaise, 30000);
  assert.equal(draft.taxPaise, 1500);
  assert.equal(draft.totalPaise, 31500);
  assert.equal(draft.companyName, 'MR ENTERPRISES');
  assert.match(draft.notice, /NOT POSTED/);
  assert.equal(app.createDraft(order.id).id, draft.id);
  db.prepare("UPDATE settings SET value='Configured Distribution Company' WHERE key='company_name'").run();
  assert.equal(app.draft(draft.id).companyName, 'Configured Distribution Company');
  assert.throws(() => app.setPicked(order.id, order.lines[0].id, { pickedQuantity: 4 }), /locked/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM invoices').get().count, 0);
  assert.equal(db.prepare('SELECT quantity_available FROM inventory_batches WHERE id=1').get().quantity_available, 20);
});

test('unpriced Amul product can be noted but cannot appear in a draft until its price is set', t => {
  const { db, app } = fresh(t);
  db.exec(`CREATE TABLE amul_products_local(product_id TEXT PRIMARY KEY,sku TEXT,code TEXT,product_name TEXT,barcode TEXT,
    stock_qty REAL,mrp_paise INTEGER,selling_price_paise INTEGER,active INTEGER,source_json TEXT);
    CREATE TABLE amul_retailers(retailer_id TEXT PRIMARY KEY,retailer_code TEXT,retailer_name TEXT,mobile TEXT,gstin TEXT,address TEXT,route_name TEXT,active INTEGER,local_deleted INTEGER DEFAULT 0);`);
  db.prepare("INSERT INTO amul_products_local VALUES('P1','P1','','Amul Product','',10,0,0,1,'{}')").run();
  db.prepare("INSERT INTO amul_retailers VALUES('R1','R1','Retailer One','9000022222','','Main Street','Route A',1,0)").run();
  db.prepare("INSERT INTO amul_retailers VALUES('R2','R2','Removed Retailer','9000044444','','Old Street','Route B',1,1)").run();
  assert.equal(app.customers('Removed').length, 0);
  assert.equal(app.catalog('Amul')[0].pricePaise, 0);
  const order = app.createOrder({ customerKey: 'AMUL:R1', items: [{ productKey: 'AMUL:P1', quantity: 2 }] });
  app.setPicked(order.id, order.lines[0].id, { pickedQuantity: 2 });
  app.setStatus(order.id, 'READY');
  assert.throws(() => app.createDraft(order.id), /Set a price/);
  app.setPicked(order.id, order.lines[0].id, { pickedQuantity: 2, unitPricePaise: 9500 });
  app.setStatus(order.id, 'READY');
  const draft = app.createDraft(order.id);
  assert.equal(draft.totalPaise, 19000);
  assert.equal(draft.customerName, 'Retailer One');
  assert.equal(draft.taxReviewNeeded, true);
});

test('synced online orders import into the local checklist once', t => {
  const { db, app } = fresh(t);
  db.exec(`CREATE TABLE whatsapp_order_requests(message_id TEXT PRIMARY KEY,customer_phone TEXT,payload TEXT,status TEXT,received_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  const payload = {
    id: 'remote-1', order_number: 'WEB-001', customer_name: 'Online Shop', phone: '9000033333',
    lines: [{ product_id: 'AMUL:IC-1', product_name: 'Ice Cream Cup', quantity: 40,
      requested_quantity: 2, requested_unit: 'BOX', units_per_box: 20, price_paise: 2500, gst_bps: 500 }],
  };
  db.prepare("INSERT INTO whatsapp_order_requests(message_id,customer_phone,payload,status) VALUES('cloud:remote-1','9000033333',?,'REVIEW')")
    .run(JSON.stringify(payload));
  assert.equal(app.importInbox().imported, 1);
  assert.equal(app.importInbox().imported, 0);
  const order = app.detail(app.list()[0].id);
  assert.equal(order.source, 'ONLINE');
  assert.equal(order.orderNumber, 'WEB-001');
  assert.equal(order.lines[0].requestedQuantity, 2);
  assert.equal(order.lines[0].unitFactor, 20);
  assert.equal(order.lines[0].unitPricePaise, 50000);
});

test('catalogue categories filter before tile limit and preserve local product categories', t => {
  const { db, app } = fresh(t);
  db.exec(`CREATE TABLE amul_products_local(product_id TEXT PRIMARY KEY,sku TEXT,code TEXT,product_name TEXT,barcode TEXT,
    stock_qty REAL,mrp_paise INTEGER,selling_price_paise INTEGER,active INTEGER,source_json TEXT);`);
  const insert = db.prepare("INSERT INTO amul_products_local VALUES(?,?,?,?,'',20,0,5000,1,'{}')");
  for (let index = 1; index <= 70; index++) insert.run(`IC-${index}`, `IC-${index}`, '', `A Vanilla Cup ${index}`);
  insert.run('BT-1', 'BT-1', '', 'Z Amul Butter');
  db.prepare("INSERT INTO products(id,sku,name,category,wholesale_price_paise,active) VALUES(1,'COOKIE','Cookie Box','Bakery',3000,1)").run();
  const categories = app.categories();
  assert.equal(categories.find(item => item.id === 'ice-cream').count, 70);
  assert.equal(categories.find(item => item.id === 'dairy').count, 1);
  assert.equal(categories.find(item => item.id === 'bakery').count, 1);
  const firstPage = app.catalog('', 'ice-cream');
  const secondPage = app.catalog('', 'ice-cream', 60);
  assert.equal(firstPage.length, 60);
  assert.equal(secondPage.length, 10);
  assert.equal(new Set([...firstPage, ...secondPage].map(item => item.key)).size, 70);
  assert.throws(() => app.catalog('', 'ice-cream', -1), /Catalogue offset/);
  assert.deepEqual(app.catalog('', 'dairy').map(item => item.name), ['Z Amul Butter']);
  assert.equal(app.catalog('BT-1')[0].categoryId, 'dairy');
  assert.equal(app.catalog('', 'bakery')[0].category, 'Bakery');
});
