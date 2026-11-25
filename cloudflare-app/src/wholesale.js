// Online wholesale checklist. These records are independent of the public
// order reservation and official invoice tables.
const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const PAGE_SIZE = 60;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
function reject(message, status = 400) {
  throw json({ error: message }, status);
}
async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) reject('Send JSON data.', 415);
  const raw = await request.text();
  if (raw.length > 250_000) reject('Request is too large.', 413);
  let value;
  try { value = JSON.parse(raw || '{}'); } catch { reject('Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('Expected a JSON object.');
  return value;
}
function clean(value, label, limit = 250, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) reject(`${label} is required.`);
  if (result.length > limit) reject(`${label} is too long.`);
  return result;
}
function whole(value, label, minimum = 0, maximum = 1_000_000_000) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') reject(`${label} is required.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) reject(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  return result;
}
function quantity(value, label, allowZero = false) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') reject(`${label} is required.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < (allowZero ? 0 : 0.001) || result > 100_000 || Math.abs(result * 1000 - Math.round(result * 1000)) > 0.000001)
    reject(`${label} must be a valid quantity.`);
  return result;
}
function slug(value) {
  return String(value || 'Other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}
function rows(result) { return result?.results || []; }
function businessDate() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}
function audit(env, orderId, action, details = {}) {
  return env.DB.prepare('INSERT INTO wholesale_pick_audit(order_id,action,details_json) VALUES(?1,?2,?3)')
    .bind(orderId, action, JSON.stringify(details));
}
async function packSizes(request, env) {
  const response = await env.ASSETS.fetch(new Request(new URL('/catalog-data.json', request.url)));
  if (!response.ok) return new Map();
  const catalogue = await response.json();
  const map = new Map();
  for (const department of catalogue.departments || []) for (const category of department.categories || [])
    for (const group of category.groups || []) for (const product of group.products || []) {
      const size = Number(product.unitsPerBox || 0);
      if (Number.isSafeInteger(size) && size > 1) map.set(String(product.id || '').toUpperCase(), size);
    }
  return map;
}
function productView(row, packs) {
  const unit = String(row.unit || 'PC').toUpperCase();
  const baseLabel = unit === 'PCS' ? 'PC' : unit;
  const units = [{ code: 'BASE', label: baseLabel, factor: 1 }];
  const pack = packs.get(String(row.sku || '').toUpperCase());
  if (pack && ['PC', 'PCS'].includes(unit)) units.push({ code: 'BOX', label: 'BOX', factor: pack });
  const category = row.category || 'Other';
  return { key: row.product_id, name: row.product_name, sku: row.sku || '', category, categoryId: slug(category),
    pricePaise: Number(row.selling_price_paise || 0), stockQty: Number(row.stock_qty || 0), gstBps: 0, units };
}
async function categories(env) {
  const result = await env.DB.prepare('SELECT category,COUNT(*) count FROM inventory WHERE active=1 GROUP BY category ORDER BY category').all();
  return rows(result).map(row => ({ id: slug(row.category), name: row.category || 'Other', count: Number(row.count) }));
}
async function catalogue(request, env) {
  const url = new URL(request.url);
  const query = clean(url.searchParams.get('q'), 'Product search', 100).toLowerCase();
  const selected = clean(url.searchParams.get('category'), 'Category', 100);
  const offset = whole(url.searchParams.get('offset') || 0, 'Catalogue offset', 0, 100_000);
  const options = await categories(env);
  const category = selected ? options.find(option => option.id === selected)?.name : '';
  if (selected && !category) return [];
  const result = await env.DB.prepare(`SELECT product_id,product_name,sku,category,unit,stock_qty,selling_price_paise
    FROM inventory WHERE active=1 AND (?1='' OR category=?1)
      AND (?2='' OR instr(lower(product_name || ' ' || COALESCE(sku,'') || ' ' || product_id),?2)>0)
    ORDER BY CASE WHEN ?2<>'' AND (lower(COALESCE(sku,''))=?2 OR lower(product_id)=?2) THEN 0 ELSE 1 END,
      CASE WHEN stock_qty-reserved_qty>0 THEN 0 ELSE 1 END,
      CASE WHEN selling_price_paise>0 THEN 0 ELSE 1 END,
      product_name,product_id LIMIT ?3 OFFSET ?4`).bind(category || '', query, PAGE_SIZE, offset).all();
  const packs = await packSizes(request, env);
  return rows(result).map(row => productView(row, packs));
}
async function customerMatches(request, env) {
  const q = clean(new URL(request.url).searchParams.get('q'), 'Customer search', 100).toLowerCase();
  const result = await env.DB.prepare(`SELECT id,name,code,mobile,whatsapp_number,address,gstin,route_name
    FROM customers WHERE active=1 AND deleted_at IS NULL
      AND (?1='' OR instr(lower(name || ' ' || COALESCE(code,'') || ' ' || COALESCE(mobile,'') || ' ' || COALESCE(whatsapp_number,'')),?1)>0)
    ORDER BY name LIMIT 40`).bind(q).all();
  return rows(result).map(row => ({ key: row.id, name: row.name, code: row.code || '',
    phone: row.whatsapp_number || row.mobile || '', address: row.address || '', gstin: row.gstin || '', routeName: row.route_name || '' }));
}
async function customer(env, key) {
  const result = await env.DB.prepare('SELECT id,name,mobile,whatsapp_number,address,gstin,route_name FROM customers WHERE id=?1 AND active=1 AND deleted_at IS NULL').bind(key).first();
  if (!result) reject('The selected customer is unavailable.', 404);
  return { key: result.id, name: result.name, phone: result.whatsapp_number || result.mobile || '',
    address: result.address || '', gstin: result.gstin || '', routeName: result.route_name || '' };
}
async function product(request, env, key, packs) {
  const row = await env.DB.prepare('SELECT product_id,product_name,sku,category,unit,stock_qty,selling_price_paise FROM inventory WHERE product_id=?1 AND active=1').bind(key).first();
  if (!row) reject('The selected product is unavailable.', 404);
  return productView(row, packs || await packSizes(request, env));
}
async function orderList(env) {
  const result = await env.DB.prepare(`SELECT o.id,o.order_number orderNumber,o.source,o.source_ref sourceRef,
    o.customer_name customerName,o.phone,o.status,o.created_at createdAt,
    (SELECT COUNT(*) FROM wholesale_pick_lines l WHERE l.order_id=o.id) lineCount,
    (SELECT COUNT(*) FROM wholesale_pick_lines l WHERE l.order_id=o.id AND l.picked_quantity IS NOT NULL) checkedCount,
    (SELECT id FROM wholesale_invoice_drafts d WHERE d.order_id=o.id) draftId
    FROM wholesale_pick_orders o ORDER BY o.created_at DESC,o.id DESC LIMIT 500`).all();
  return rows(result);
}
async function orderDetail(env, id) {
  const order = await env.DB.prepare(`SELECT o.id,o.order_number orderNumber,o.source,o.source_ref sourceRef,o.customer_key customerKey,
    o.customer_name customerName,o.phone,o.address,o.gstin,o.route_name routeName,o.notes,o.status,
    o.external_invoice_number externalInvoiceNumber,o.completed_at completedAt,
    o.cancel_reason cancelReason,o.cancelled_at cancelledAt,
    o.created_at createdAt,o.updated_at updatedAt,
    (SELECT id FROM wholesale_invoice_drafts d WHERE d.order_id=o.id) draftId
    FROM wholesale_pick_orders o WHERE o.id=?1`).bind(id).first();
  if (!order) reject('Order not found.', 404);
  const result = await env.DB.prepare(`SELECT id,product_key productKey,product_name name,sku,
    requested_quantity requestedQuantity,picked_quantity pickedQuantity,
    unit_code unitCode,unit_label unitLabel,unit_factor unitFactor,
    unit_price_paise unitPricePaise,gst_bps gstBps,shortage_reason shortageReason
    FROM wholesale_pick_lines WHERE order_id=?1 ORDER BY sort_order`).bind(id).all();
  order.lines = rows(result);
  return order;
}
async function createOrder(request, env) {
  const body = await readBody(request);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 150) reject('Add 1 to 150 order items.');
  const selected = body.customerKey ? await customer(env, body.customerKey) : null;
  const customerName = clean(selected?.name || body.customerName, 'Customer name', 150, true);
  const phone = clean(selected?.phone || body.phone, 'Phone', 30);
  const address = clean(selected?.address || body.address, 'Address', 500);
  const gstin = clean(selected?.gstin || body.gstin, 'GSTIN', 30);
  const routeName = clean(selected?.routeName || body.routeName, 'Route', 150);
  const notes = clean(body.notes, 'Notes', 1000);
  const packs = await packSizes(request, env);
  const prepared = [];
  for (const raw of body.items) {
    const item = await product(request, env, clean(raw.productKey, 'Product', 150, true), packs);
    const unit = item.units.find(choice => choice.code === (raw.unitCode || 'BASE'));
    if (!unit) reject(`Choose a current unit for ${item.name}.`);
    const count = quantity(raw.quantity, 'Requested quantity');
    if (Math.abs(count * unit.factor - Math.round(count * unit.factor)) > 0.000001)
      reject(`${item.name} must use a whole number of stock units.`);
    const price = raw.unitPricePaise === undefined
      ? whole(item.pricePaise * unit.factor, 'Unit price') : whole(raw.unitPricePaise, 'Unit price');
    prepared.push({ item, unit, count, price });
  }
  const id = crypto.randomUUID();
  const number = `WO-${businessDate()}-${id.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const statements = [env.DB.prepare(`INSERT INTO wholesale_pick_orders
    (id,order_number,source,customer_key,customer_name,phone,address,gstin,route_name,notes)
    VALUES(?1,?2,'PHONE',?3,?4,?5,?6,?7,?8,?9)`)
    .bind(id, number, selected?.key || null, customerName, phone, address, gstin, routeName, notes)];
  prepared.forEach(({ item, unit, count, price }, index) => statements.push(env.DB.prepare(`INSERT INTO wholesale_pick_lines
    (id,order_id,product_key,product_name,sku,requested_quantity,unit_code,unit_label,unit_factor,unit_price_paise,gst_bps,sort_order)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11)`)
    .bind(crypto.randomUUID(), id, item.key, item.name, item.sku, count, unit.code, unit.label, unit.factor, price, index + 1)));
  statements.push(audit(env, id, 'CREATE', { source: 'PHONE', lineCount: prepared.length }));
  await env.DB.batch(statements);
  return orderDetail(env, id);
}

async function importOnline(env) {
  const source = await env.DB.prepare(`SELECT o.id,o.order_number,o.customer_id,o.customer_name,o.phone,o.address,o.gstin,o.route_name,o.note
    FROM orders o WHERE o.source IN ('ONLINE','WHATSAPP') AND o.status IN ('NEW','SYNCED')
      AND o.workflow_status IN ('RECEIVED','CONFIRMED')
      AND o.invoice_job_id IS NULL AND o.invoice_number IS NULL
      AND NOT EXISTS (SELECT 1 FROM wholesale_pick_orders p WHERE p.source_ref=o.id)
    ORDER BY o.created_at LIMIT 21`).all();
  const waiting = rows(source);
  let imported = 0, skipped = 0;
  for (const original of waiting.slice(0, 20)) {
    const sourceLines = await env.DB.prepare(`SELECT l.line_no,l.product_id,l.product_name,l.quantity,l.unit,
      l.requested_quantity,l.requested_unit,l.units_per_box,l.price_paise,i.sku
      FROM order_lines l LEFT JOIN inventory i ON i.product_id=l.product_id
      WHERE l.order_id=?1 ORDER BY l.line_no`).bind(original.id).all();
    const lines = rows(sourceLines);
    if (!lines.length) { skipped++; continue; }
    const id = crypto.randomUUID();
    const orderNumber = clean(original.order_number, 'Online order number', 100) || `WEB-${id.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const statements = [env.DB.prepare(`INSERT INTO wholesale_pick_orders
      (id,order_number,source,source_ref,customer_key,customer_name,phone,address,gstin,route_name,notes)
      VALUES(?1,?2,'ONLINE',?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(id, orderNumber, original.id, original.customer_id || null, original.customer_name || 'Online customer',
        original.phone || '', original.address || '', original.gstin || '', original.route_name || '', original.note || '')];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const factor = String(line.requested_unit || '').toUpperCase() === 'BOX' && Number.isSafeInteger(Number(line.units_per_box)) && Number(line.units_per_box) > 1
        ? Number(line.units_per_box) : 1;
      const count = Number(line.requested_quantity) > 0 ? Number(line.requested_quantity) : Number(line.quantity) / factor;
      const price = Number(line.price_paise || 0) * factor;
      if (!Number.isFinite(count) || count <= 0 || !Number.isSafeInteger(price) || price < 0 || price > 1_000_000_000) reject('An online order has an invalid line; it was not imported.', 409);
      const label = factor > 1 ? 'BOX' : (line.requested_unit || line.unit || 'PC');
      statements.push(env.DB.prepare(`INSERT INTO wholesale_pick_lines
        (id,order_id,product_key,product_name,sku,requested_quantity,unit_code,unit_label,unit_factor,unit_price_paise,gst_bps,sort_order)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11)`)
        .bind(crypto.randomUUID(), id, line.product_id, line.product_name, line.sku || '', count,
          factor > 1 ? 'BOX' : 'BASE', label, factor, price, index + 1));
    }
    statements.push(audit(env, id, 'IMPORT', { sourceRef: original.id, lineCount: lines.length }));
    try { await env.DB.batch(statements); imported++; }
    catch (error) { if (/UNIQUE constraint failed/i.test(String(error))) skipped++; else throw error; }
  }
  return { imported, skipped, moreAvailable: waiting.length > 20, orders: await orderList(env) };
}

async function savePick(request, env, orderId, lineId) {
  const body = await readBody(request);
  const order = await orderDetail(env, orderId);
  if (['DRAFTED','COMPLETED','CANCELLED'].includes(order.status)) reject('This checklist is locked.', 409);
  if (order.status === 'HOLD') reject('Resume this order before picking.', 409);
  const line = order.lines.find(item => item.id === lineId);
  if (!line) reject('Order line not found.', 404);
  const picked = body.pickedQuantity === null ? null : quantity(body.pickedQuantity, 'Picked quantity', true);
  if (picked !== null && picked > Number(line.requestedQuantity) + 0.000001) reject('Picked quantity exceeds the order.', 409);
  const reason = clean(body.shortageReason, 'Shortage reason', 250);
  if (picked !== null && picked < Number(line.requestedQuantity) && !reason) reject('Enter a reason for a partial or missing item.');
  const price = body.unitPricePaise === undefined ? Number(line.unitPricePaise) : whole(body.unitPricePaise, 'Unit price');
  await env.DB.batch([
    env.DB.prepare('UPDATE wholesale_pick_lines SET picked_quantity=?1,shortage_reason=?2,unit_price_paise=?3 WHERE id=?4 AND order_id=?5')
      .bind(picked, picked === null ? '' : reason, price, lineId, orderId),
    env.DB.prepare("UPDATE wholesale_pick_orders SET status='PICKING',updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(orderId),
    audit(env, orderId, 'PICK', { lineId, pickedQuantity: picked, shortageReason: reason, priceChanged: price !== Number(line.unitPricePaise) }),
  ]);
  return orderDetail(env, orderId);
}
async function saveStatus(request, env, id) {
  const { status } = await readBody(request);
  const next = String(status || '').toUpperCase();
  if (!['HOLD','PICKING','READY'].includes(next)) reject('Choose Hold, Picking or Ready.');
  const order = await orderDetail(env, id);
  if (['DRAFTED','COMPLETED','CANCELLED'].includes(order.status)) reject('This checklist is locked.', 409);
  if (next === 'READY') {
    if (order.lines.some(line => line.pickedQuantity === null)) reject('Check every item before marking the order ready.', 409);
    if (!order.lines.some(line => Number(line.pickedQuantity) > 0)) reject('Pick at least one item before making an invoice draft.', 409);
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE wholesale_pick_orders SET status=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2').bind(next, id),
    audit(env, id, 'STATUS', { from: order.status, to: next }),
  ]);
  return orderDetail(env, id);
}
async function draftDetail(env, id) {
  const draft = await env.DB.prepare(`SELECT d.id,d.draft_number draftNumber,d.order_id orderId,
    o.order_number orderNumber,o.source,d.customer_name customerName,d.phone,d.address,d.gstin,
    o.route_name routeName,o.notes,o.status orderStatus,
    o.external_invoice_number externalInvoiceNumber,o.completed_at completedAt,
    o.cancel_reason cancelReason,o.cancelled_at cancelledAt,d.created_at createdAt,
    d.subtotal_paise subtotalPaise,d.tax_paise taxPaise,d.total_paise totalPaise
    FROM wholesale_invoice_drafts d JOIN wholesale_pick_orders o ON o.id=d.order_id WHERE d.id=?1`).bind(id).first();
  if (!draft) reject('Invoice draft not found.', 404);
  const result = await env.DB.prepare(`SELECT product_name name,sku,quantity,unit_label unitLabel,
    unit_price_paise unitPricePaise,gst_bps gstBps,subtotal_paise subtotalPaise,
    tax_paise taxPaise,total_paise totalPaise
    FROM wholesale_invoice_draft_lines WHERE draft_id=?1 ORDER BY sort_order`).bind(id).all();
  return { ...draft, lines: rows(result), companyName: 'MR ENTERPRISES', companyGstin: '', companyAddress: '', companyPhone: '',
    taxReviewNeeded: true, status: 'DRAFT', notice: 'Confirm prices and GST in the billing system before issuing a final invoice.' };
}
async function createDraft(env, id) {
  const order = await orderDetail(env, id);
  if (order.draftId) return draftDetail(env, order.draftId);
  if (order.status !== 'READY') reject('Finish the checklist and mark the order ready first.', 409);
  const picked = order.lines.filter(line => Number(line.pickedQuantity) > 0);
  if (!picked.length) reject('Pick at least one item.', 409);
  if (picked.some(line => !Number(line.unitPricePaise))) reject('Set a price for every picked item before making the draft.', 409);
  const lines = picked.map(line => {
    const subtotalPaise = Math.round(Number(line.pickedQuantity) * Number(line.unitPricePaise));
    if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise < 0) reject('Draft amount is too large.');
    return { ...line, subtotalPaise, taxPaise: 0, totalPaise: subtotalPaise };
  });
  const subtotalPaise = lines.reduce((sum, line) => sum + line.subtotalPaise, 0);
  if (!Number.isSafeInteger(subtotalPaise)) reject('Draft amount is too large.');
  const draftId = crypto.randomUUID();
  const draftNumber = `DRAFT-${draftId.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const statements = [env.DB.prepare(`INSERT INTO wholesale_invoice_drafts
    (id,order_id,draft_number,customer_name,phone,address,gstin,subtotal_paise,tax_paise,total_paise)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?8)`)
    .bind(draftId, id, draftNumber, order.customerName, order.phone, order.address, order.gstin, subtotalPaise)];
  lines.forEach((line, index) => statements.push(env.DB.prepare(`INSERT INTO wholesale_invoice_draft_lines
    (id,draft_id,product_name,sku,quantity,unit_label,unit_price_paise,gst_bps,subtotal_paise,tax_paise,total_paise,sort_order)
    VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,0,?8,?9)`)
    .bind(crypto.randomUUID(), draftId, line.name, line.sku, line.pickedQuantity, line.unitLabel,
      line.unitPricePaise, line.subtotalPaise, index + 1)));
  statements.push(env.DB.prepare("UPDATE wholesale_pick_orders SET status='DRAFTED',updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(id));
  statements.push(audit(env, id, 'DRAFT', { draftId, pickedLines: lines.length, totalPaise: subtotalPaise }));
  try { await env.DB.batch(statements); }
  catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) {
      const existing = await env.DB.prepare('SELECT id FROM wholesale_invoice_drafts WHERE order_id=?1').bind(id).first();
      if (existing) return draftDetail(env, existing.id);
    }
    throw error;
  }
  return draftDetail(env, draftId);
}

async function sourceReadyForClose(env, order) {
  if (!order.sourceRef) return;
  const source = await env.DB.prepare(`SELECT id FROM orders WHERE id=?1 AND status IN ('NEW','SYNCED')
    AND workflow_status IN ('RECEIVED','CONFIRMED') AND invoice_job_id IS NULL AND invoice_number IS NULL`)
    .bind(order.sourceRef).first();
  if (!source) reject('The original online order has changed. Review it before closing this checklist.', 409);
}

function invoiceNumberText(value) {
  const number = clean(value, 'Final invoice number', 100, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9 /._-]*$/.test(number)) reject('Enter a valid final invoice number.');
  return number;
}
async function syncedInvoice(env, order, number) {
  const result = await env.DB.prepare(`SELECT id,invoice_number invoiceNumber,customer_id customerId,
    customer_name customerName,total_paise totalPaise,invoice_date invoiceDate
    FROM invoices WHERE UPPER(TRIM(invoice_number))=UPPER(?1)
      AND status='POSTED' AND deleted_at IS NULL AND source IN ('AMUL','LOCAL')
      AND source_device<>'cloudflare-admin' AND invoice_date>=date(?2,'+5 hours','+30 minutes')
    LIMIT 2`).bind(number, order.createdAt).all();
  const matched = rows(result);
  if (matched.length !== 1) reject('Find one posted invoice with this number after the Windows sync. Check the number and sync status.', 409);
  const invoice = matched[0];
  const bothAmul = String(order.customerKey || '').startsWith('AMUL:') && String(invoice.customerId || '').startsWith('AMUL:');
  const customerMatch = bothAmul ? order.customerKey === invoice.customerId : null;
  if (customerMatch === false) reject('That invoice belongs to another Amul customer.', 409);
  const reused = await env.DB.prepare('SELECT id FROM wholesale_pick_orders WHERE external_invoice_number=?1 COLLATE NOCASE AND id<>?2 LIMIT 1')
    .bind(number, order.id).first();
  if (reused) reject('That final invoice number is already recorded for another wholesale order.', 409);
  return { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, customerName: invoice.customerName,
    customerId: invoice.customerId || '', totalPaise: Number(invoice.totalPaise || 0),
    invoiceDate: invoice.invoiceDate, customerMatch };
}

async function invoiceLookup(request, env, id) {
  const order = await orderDetail(env, id);
  if (order.status !== 'DRAFTED') reject('Prepare a draft before looking up its final invoice.', 409);
  const number = invoiceNumberText(new URL(request.url).searchParams.get('number'));
  return syncedInvoice(env, order, number);
}

async function completeOrder(request, env, id) {
  const body = await readBody(request);
  const invoiceNumber = invoiceNumberText(body.invoiceNumber);
  const invoiceId = clean(body.invoiceId, 'Verified invoice ID', 150, true);
  const order = await orderDetail(env, id);
  if (order.status === 'COMPLETED' && order.externalInvoiceNumber === invoiceNumber) return order;
  if (order.status !== 'DRAFTED' || !order.draftId) reject('Prepare the draft and issue the final invoice in the billing system first.', 409);
  await sourceReadyForClose(env, order);
  const posted = await syncedInvoice(env, order, invoiceNumber);
  if (posted.invoiceId !== invoiceId) reject('Verify the synced invoice details again before closing this order.', 409);
  const statements = [env.DB.prepare(`UPDATE wholesale_pick_orders SET status='COMPLETED',
    external_invoice_number=?1,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?2`)
    .bind(invoiceNumber, id)];
  if (order.sourceRef) statements.push(env.DB.prepare(`UPDATE orders SET status='FULFILLED',
    workflow_status='INVOICED',invoice_number=?1,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE id=?2 AND status IN ('NEW','SYNCED') AND workflow_status IN ('RECEIVED','CONFIRMED')
      AND invoice_job_id IS NULL AND invoice_number IS NULL`).bind(invoiceNumber, order.sourceRef));
  statements.push(audit(env, id, 'COMPLETE', { invoiceNumber, sourceRef: order.sourceRef || null }));
  try { await env.DB.batch(statements); }
  catch (error) {
    if (/SOURCE_ORDER_CHANGED|USE_WHOLESALE_CHECKLIST|DRAFT_LOCKED|ORDER_CLOSED|SYNCED_INVOICE_MISMATCH|UNIQUE constraint failed/i.test(String(error)))
      reject('The original online order changed while closing. Review it and try again.', 409);
    throw error;
  }
  return orderDetail(env, id);
}

async function cancelOrder(request, env, id) {
  const body = await readBody(request);
  const reason = clean(body.reason, 'Cancellation reason', 250, true);
  const order = await orderDetail(env, id);
  if (order.status === 'CANCELLED') return order;
  if (order.status === 'COMPLETED') reject('A completed order cannot be cancelled.', 409);
  await sourceReadyForClose(env, order);
  const statements = [env.DB.prepare(`UPDATE wholesale_pick_orders SET status='CANCELLED',
    cancel_reason=?1,cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?2`).bind(reason, id)];
  if (order.sourceRef) statements.push(env.DB.prepare(`UPDATE orders SET status='CANCELLED',
    workflow_status='CANCELLED',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE id=?1 AND status IN ('NEW','SYNCED') AND workflow_status IN ('RECEIVED','CONFIRMED')
      AND invoice_job_id IS NULL AND invoice_number IS NULL`).bind(order.sourceRef));
  statements.push(audit(env, id, 'CANCEL', { reason, sourceRef: order.sourceRef || null }));
  try { await env.DB.batch(statements); }
  catch (error) {
    if (/SOURCE_ORDER_CHANGED|USE_WHOLESALE_CHECKLIST|DRAFT_LOCKED|ORDER_CLOSED/i.test(String(error)))
      reject('The original online order changed while cancelling. Review it and try again.', 409);
    throw error;
  }
  return orderDetail(env, id);
}

export async function wholesaleApi(request, env, role, username) {
  const path = new URL(request.url).pathname.replace(/^\/api\/wholesale/, '');
  if (path === '/session' && request.method === 'GET') return json({ user: username, role, csrf: '' });
  if (path === '/categories' && request.method === 'GET') return json(await categories(env));
  if (path === '/catalog' && request.method === 'GET') return json(await catalogue(request, env));
  if (path === '/customers' && request.method === 'GET') return json(await customerMatches(request, env));
  if (path === '/orders' && request.method === 'GET') return json(await orderList(env));
  if (path === '/orders' && request.method === 'POST') return json(await createOrder(request, env), 201);
  if (path === '/import-online' && request.method === 'POST') return json(await importOnline(env));
  const detail = path.match(/^\/orders\/([^/]+)$/);
  if (detail && request.method === 'GET') return json(await orderDetail(env, detail[1]));
  const pick = path.match(/^\/orders\/([^/]+)\/lines\/([^/]+)$/);
  if (pick && request.method === 'PATCH') return json(await savePick(request, env, pick[1], pick[2]));
  const status = path.match(/^\/orders\/([^/]+)\/status$/);
  if (status && request.method === 'PATCH') return json(await saveStatus(request, env, status[1]));
  const draft = path.match(/^\/orders\/([^/]+)\/draft$/);
  if (draft && request.method === 'POST') {
    if (role !== 'OWNER') return json({ error: 'Owner approval is required for invoice drafts.' }, 403);
    return json(await createDraft(env, draft[1]), 201);
  }
  const complete = path.match(/^\/orders\/([^/]+)\/complete$/);
  if (complete && request.method === 'POST') {
    if (role !== 'OWNER') return json({ error: 'Owner approval is required to close an order.' }, 403);
    return json(await completeOrder(request, env, complete[1]));
  }
  const lookup = path.match(/^\/orders\/([^/]+)\/invoice-lookup$/);
  if (lookup && request.method === 'GET') {
    if (role !== 'OWNER') return json({ error: 'Owner approval is required to verify a final invoice.' }, 403);
    return json(await invoiceLookup(request, env, lookup[1]));
  }
  const cancel = path.match(/^\/orders\/([^/]+)\/cancel$/);
  if (cancel && request.method === 'POST') {
    if (role !== 'OWNER') return json({ error: 'Owner approval is required to cancel an order.' }, 403);
    return json(await cancelOrder(request, env, cancel[1]));
  }
  const savedDraft = path.match(/^\/drafts\/([^/]+)$/);
  if (savedDraft && request.method === 'GET') {
    if (role !== 'OWNER') return json({ error: 'Owner approval is required for invoice drafts.' }, 403);
    return json(await draftDetail(env, savedDraft[1]));
  }
  return json({ error: 'Wholesale endpoint not found.' }, 404);
}

export { slug, productView };
