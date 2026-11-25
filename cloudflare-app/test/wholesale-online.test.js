import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';

function d1({ triggers = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(file, directory), 'utf8'));
  if (triggers) db.exec(readFileSync(new URL('../schema/triggers.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind: (...values) => wrap(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
  });
  const env = {
    DB: { prepare: sql => wrap(sql), batch: async statements => { for (const statement of statements) await statement.run(); } },
    ASSETS: { fetch: async request => new Response(new URL(request.url).pathname === '/catalog-data.json'
      ? JSON.stringify({ departments: [] }) : 'wholesale asset', { status: 200 }) },
    APP_USER: 'rachana', APP_PASSWORD: 'test-owner-password',
    WHOLESALE_STAFF_USER: 'picker', WHOLESALE_STAFF_PASSWORD: 'test-staff-password',
  };
  return { db, env };
}

const base = 'https://frostflow.example';
const owner = `Basic ${btoa('rachana:test-owner-password')}`;
const staff = `Basic ${btoa('picker:test-staff-password')}`;
function request(path, { method = 'GET', auth = owner, data, origin = base, contentType = 'application/json' } = {}) {
  return new Request(base + path, { method, headers: {
    ...(auth ? { authorization: auth } : {}),
    ...(method !== 'GET' ? { origin, 'content-type': contentType } : {}),
  }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}

test('online wholesale staff is scoped to checklist; only owner creates a draft from picked items', async t => {
  const { db, env } = d1();
  t.after(() => db.close());
  db.prepare(`INSERT INTO inventory(product_id,sku,product_name,category,unit,stock_qty,selling_price_paise,source_device,snapshot_id)
    VALUES('P1','P1','Vanilla Cup','Ice Cream','PC',0,0,'test','s1')`).run();
  db.prepare(`INSERT INTO inventory(product_id,sku,product_name,category,unit,stock_qty,selling_price_paise,source_device,snapshot_id)
    VALUES('P2','P2','Chocolate Cup','Ice Cream','PC',10,2500,'test','s1')`).run();
  db.prepare(`INSERT INTO customers(id,source,source_id,name,mobile,source_device,snapshot_id)
    VALUES('AMUL:C1','AMUL','C1','Corner Shop','9000011111','test','s1')`).run();

  assert.equal((await worker.fetch(request('/wholesale/', { auth: staff }), env)).status, 200);
  assert.equal((await worker.fetch(request('/wholesale.js', { auth: staff }), env)).status, 200);
  assert.equal((await worker.fetch(request('/api/dashboard', { auth: staff }), env)).status, 401);
  assert.equal((await worker.fetch(request('/api/wholesale/orders', { auth: '' }), env)).status, 401);
  const session = await (await worker.fetch(request('/api/wholesale/session', { auth: staff }), env)).json();
  assert.deepEqual([session.user, session.role], ['picker', 'STAFF']);
  const categories = await (await worker.fetch(request('/api/wholesale/categories', { auth: staff }), env)).json();
  assert.ok(categories.some(category => category.name === 'Ice Cream'));
  const tiles = await (await worker.fetch(request('/api/wholesale/catalog?category=ice-cream', { auth: staff }), env)).json();
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].categoryId, 'ice-cream');

  const orderBody = { customerKey: 'AMUL:C1', items: [
    { productKey: 'P1', quantity: 2, unitPricePaise: 4000 },
    { productKey: 'P2', quantity: 3 },
  ] };
  assert.equal((await worker.fetch(request('/api/wholesale/orders', { method: 'POST', auth: staff, data: orderBody, origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/wholesale/orders', { method: 'POST', auth: staff, data: orderBody, origin: '' }), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/wholesale/orders', { method: 'POST', auth: staff, data: orderBody, contentType: 'text/plain' }), env)).status, 415);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wholesale_pick_orders').get().n, 0);
  const createdResponse = await worker.fetch(request('/api/wholesale/orders', { method: 'POST', auth: staff, data: orderBody }), env);
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();
  assert.equal(created.customerName, 'Corner Shop');
  assert.match(created.orderNumber, /^WO-\d{8}-[A-F0-9]{10}$/);
  assert.equal(created.lines.length, 2);
  assert.equal(created.lines[0].unitPricePaise, 4000);
  assert.throws(() => db.prepare(`INSERT INTO wholesale_invoice_drafts
    (id,order_id,draft_number,customer_name,subtotal_paise,total_paise) VALUES('stale-draft',?,'STALE','Corner Shop',0,0)`)
    .run(created.id), /ORDER_NOT_READY/);

  const first = created.lines[0], second = created.lines[1];
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${created.id}/lines/${first.id}`, {
    method: 'PATCH', auth: staff, data: { pickedQuantity: 1, shortageReason: 'Only one found' },
  }), env)).status, 200);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${created.id}/lines/${second.id}`, {
    method: 'PATCH', auth: staff, data: { pickedQuantity: 0, shortageReason: 'No stock' },
  }), env)).status, 200);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${created.id}/status`, {
    method: 'PATCH', auth: staff, data: { status: 'READY' },
  }), env)).status, 200);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${created.id}/draft`, {
    method: 'POST', auth: staff, data: {},
  }), env)).status, 403);
  const draftResponse = await worker.fetch(request(`/api/wholesale/orders/${created.id}/draft`, {
    method: 'POST', data: {},
  }), env);
  assert.equal(draftResponse.status, 201, await draftResponse.clone().text());
  const draft = await draftResponse.json();
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0].quantity, 1);
  assert.equal(draft.totalPaise, 4000);
  assert.equal(draft.status, 'DRAFT');
  assert.equal((await worker.fetch(request(`/api/wholesale/drafts/${draft.id}`, { auth: staff }), env)).status, 403);
  assert.throws(() => db.prepare('UPDATE wholesale_pick_lines SET picked_quantity=2 WHERE id=?').run(first.id), /DRAFT_LOCKED/);
  assert.throws(() => db.prepare('DELETE FROM wholesale_pick_lines WHERE id=?').run(first.id), /DRAFT_LOCKED/);
  assert.throws(() => db.prepare("UPDATE wholesale_pick_orders SET status='PICKING' WHERE id=?").run(created.id), /DRAFT_LOCKED/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
  assert.equal(db.prepare("SELECT stock_qty FROM inventory WHERE product_id='P1'").get().stock_qty, 0);
  assert.equal(db.prepare("SELECT stock_qty FROM inventory WHERE product_id='P2'").get().stock_qty, 10);
  db.prepare(`INSERT INTO invoices(id,source,source_id,invoice_number,invoice_date,customer_id,customer_name,total_paise,paid_paise,outstanding_paise,payment_status,source_device,snapshot_id)
    VALUES('AMUL:WRONG','AMUL','WRONG','WRONG-INV',date('now','+5 hours','+30 minutes'),'AMUL:OTHER','Another Shop',5000,0,5000,'UNPAID','amul-pc','s1')`).run();
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${created.id}/invoice-lookup?number=WRONG-INV`), env)).status, 409);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${created.id}/invoice-lookup?number=WRONG-INV`, { auth: staff }), env)).status, 403);
  delete env.WHOLESALE_STAFF_PASSWORD;
  assert.equal((await worker.fetch(request('/api/wholesale/session', { auth: staff }), env)).status, 401);
});

test('existing online orders import once, then release reservations only after final invoice sync or cancellation', async t => {
  const { db, env } = d1({ triggers: true });
  t.after(() => db.close());
  db.prepare(`INSERT INTO inventory(product_id,sku,product_name,category,unit,stock_qty,selling_price_paise,source_device,snapshot_id)
    VALUES('P1','P1','Vanilla Cup','Ice Cream','PC',50,2500,'test','s1')`).run();
  db.prepare(`INSERT INTO orders(id,request_id,source,customer_name,status,order_number,workflow_status)
    VALUES('O1','online-1','ONLINE','Online Shop','NEW','WEB-001','RECEIVED')`).run();
  db.prepare(`INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise)
    VALUES('O1',1,'P1','Vanilla Cup',40,'PC',2,'BOX',20,2500)`).run();
  db.prepare(`INSERT INTO orders(id,request_id,source,customer_name,status,order_number,workflow_status)
    VALUES('O2','online-2','ONLINE','Started Shop','NEW','WEB-002','PICKING')`).run();
  db.prepare(`INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,picked_qty,requested_quantity,requested_unit,units_per_box,price_paise)
    VALUES('O2',1,'P1','Vanilla Cup',2,'PC',1,2,'PC',1,2500)`).run();
  assert.equal(db.prepare("SELECT reserved_qty FROM inventory WHERE product_id='P1'").get().reserved_qty, 42);
  const importRequest = () => request('/api/wholesale/import-online', { method: 'POST', data: {}, auth: staff });
  const first = await (await worker.fetch(importRequest(), env)).json();
  assert.equal(first.imported, 1);
  assert.equal(first.orders.length, 1);
  const second = await (await worker.fetch(importRequest(), env)).json();
  assert.equal(second.imported, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wholesale_pick_orders WHERE source_ref='O2'").get().n, 0);
  const copied = db.prepare("SELECT * FROM wholesale_pick_lines WHERE order_id=(SELECT id FROM wholesale_pick_orders WHERE source_ref='O1')").get();
  assert.equal(copied.requested_quantity, 2);
  assert.equal(copied.unit_label, 'BOX');
  assert.equal(copied.unit_price_paise, 50000);
  const oldPick = await worker.fetch(request('/api/orders/O1/pick', {
    method: 'PATCH', data: { line_no: 1, picked_qty: 1 },
  }), env);
  assert.equal(oldPick.status, 409);
  assert.match((await oldPick.json()).error, /Wholesale/);
  assert.equal((await worker.fetch(request('/api/orders/O1/invoice', { method: 'POST', data: {} }), env)).status, 409);
  assert.equal((await worker.fetch(request('/api/orders/O1/confirm', { method: 'POST', data: {} }), env)).status, 409);
  assert.equal((await worker.fetch(request('/api/invoices', {
    method: 'POST', data: { request_id: 'invoice-attempt-123', order_id: 'O1', lines: [{ product_id: 'P1' }] },
  }), env)).status, 409);
  assert.throws(() => db.prepare("UPDATE orders SET workflow_status='PICKING' WHERE id='O1'").run(), /USE_WHOLESALE_CHECKLIST/);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id='O1'").get().status, 'NEW');
  db.prepare("UPDATE orders SET status='SYNCED' WHERE id='O1'").run();
  assert.equal(db.prepare("SELECT status FROM orders WHERE id='O1'").get().status, 'SYNCED');
  const wholesaleId = first.orders[0].id;
  const lineId = db.prepare('SELECT id FROM wholesale_pick_lines WHERE order_id=?').get(wholesaleId).id;
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/lines/${lineId}`, {
    method: 'PATCH', data: { pickedQuantity: 2, shortageReason: '' },
  }), env)).status, 200);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/status`, {
    method: 'PATCH', data: { status: 'READY' },
  }), env)).status, 200);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/draft`, {
    method: 'POST', data: {},
  }), env)).status, 201);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/complete`, {
    method: 'POST', auth: staff, data: { invoiceNumber: 'AMUL-INV-001' },
  }), env)).status, 403);
  const tooEarly = await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/complete`, {
    method: 'POST', data: { invoiceNumber: 'AMUL-INV-001', invoiceId: 'AMUL:I1' },
  }), env);
  assert.equal(tooEarly.status, 409);
  assert.match((await tooEarly.json()).error, /Windows sync/);
  db.prepare(`INSERT INTO invoices(id,source,source_id,invoice_number,invoice_date,customer_name,total_paise,paid_paise,outstanding_paise,payment_status,source_device,snapshot_id)
    VALUES('AMUL:I1','AMUL','I1','AMUL-INV-001',date('now','+5 hours','+30 minutes'),'Online Shop',100000,0,100000,'UNPAID','amul-pc','s1')`).run();
  const verified = await (await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/invoice-lookup?number=AMUL-INV-001`), env)).json();
  assert.equal(verified.invoiceId, 'AMUL:I1');
  assert.equal(verified.customerName, 'Online Shop');
  const completed = await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/complete`, {
    method: 'POST', data: { invoiceNumber: 'AMUL-INV-001', invoiceId: verified.invoiceId },
  }), env);
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal((await completed.json()).status, 'COMPLETED');
  assert.throws(() => db.prepare(`INSERT INTO wholesale_pick_orders
    (id,order_number,source,customer_name,external_invoice_number)
    VALUES('duplicate-ref','WO-DUPLICATE','PHONE','Other Shop','AMUL-INV-001')`).run(), /UNIQUE constraint failed/);
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${wholesaleId}/complete`, {
    method: 'POST', data: { invoiceNumber: 'ANOTHER-INV', invoiceId: verified.invoiceId },
  }), env)).status, 409);
  assert.throws(() => db.prepare("UPDATE wholesale_pick_orders SET external_invoice_number='ANOTHER-INV' WHERE id=?").run(wholesaleId), /ORDER_CLOSED/);
  assert.equal(db.prepare("SELECT status,workflow_status,invoice_number,reservation_released FROM orders WHERE id='O1'").get().status, 'FULFILLED');
  assert.equal(db.prepare("SELECT reserved_qty FROM inventory WHERE product_id='P1'").get().reserved_qty, 2);
  assert.equal(db.prepare("SELECT stock_qty FROM inventory WHERE product_id='P1'").get().stock_qty, 50);

  db.prepare(`INSERT INTO orders(id,request_id,source,customer_name,status,order_number,workflow_status)
    VALUES('O3','online-3','ONLINE','Cancel Shop','NEW','WEB-003','RECEIVED')`).run();
  db.prepare(`INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise)
    VALUES('O3',1,'P1','Vanilla Cup',3,'PC',3,'PC',1,2500)`).run();
  assert.equal(db.prepare("SELECT reserved_qty FROM inventory WHERE product_id='P1'").get().reserved_qty, 5);
  const later = await (await worker.fetch(importRequest(), env)).json();
  assert.equal(later.imported, 1);
  const cancelId = later.orders.find(order => order.orderNumber === 'WEB-003').id;
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${cancelId}/cancel`, {
    method: 'POST', auth: staff, data: { reason: 'Customer cancelled' },
  }), env)).status, 403);
  const cancelled = await worker.fetch(request(`/api/wholesale/orders/${cancelId}/cancel`, {
    method: 'POST', data: { reason: 'Customer cancelled' },
  }), env);
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal((await cancelled.json()).status, 'CANCELLED');
  assert.equal((await worker.fetch(request(`/api/wholesale/orders/${cancelId}/draft`, {
    method: 'POST', data: {},
  }), env)).status, 409);
  assert.equal(db.prepare("SELECT status,reservation_released FROM orders WHERE id='O3'").get().status, 'CANCELLED');
  assert.equal(db.prepare("SELECT reserved_qty FROM inventory WHERE product_id='P1'").get().reserved_qty, 2);
  assert.equal(db.prepare("SELECT stock_qty FROM inventory WHERE product_id='P1'").get().stock_qty, 50);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 1);
});
