const encoder = new TextEncoder();

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

async function equalSecret(left, right) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function appAuthorized(request, env) {
  if (!env.APP_USER || !env.APP_PASSWORD) return false;
  const expected = `Basic ${btoa(`${env.APP_USER}:${env.APP_PASSWORD}`)}`;
  return equalSecret(request.headers.get('authorization') || '', expected);
}

async function syncAuthorized(request, env) {
  if (!env.SYNC_SECRET) return false;
  return equalSecret(request.headers.get('authorization') || '', `Bearer ${env.SYNC_SECRET}`);
}

async function readObject(request, maxBytes = 250_000) {
  const type = request.headers.get('content-type') || '';
  if (!/^application\/json(?:;|$)/i.test(type)) throw new Response('JSON required', { status: 415 });
  const raw = await request.text();
  if (raw.length > maxBytes) throw new Response('Request too large', { status: 413 });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { throw new Response('Invalid JSON', { status: 400 }); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Response('JSON object required', { status: 400 });
  return body;
}

function cleanText(value, name, max = 200, required = true) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Response(`${name} is required`, { status: 400 });
  if (result.length > max) throw new Response(`${name} is too long`, { status: 400 });
  return result;
}

function cleanPhone(value) {
  const result = String(value ?? '').replace(/\D/g, '');
  if (result && !/^[1-9]\d{7,14}$/.test(result)) throw new Response('Invalid phone number', { status: 400 });
  return result;
}

function cleanInteger(value, name, minimum = 0) {
  const result = Math.trunc(Number(value ?? 0));
  if (!Number.isFinite(result) || result < minimum) throw new Response(`Invalid ${name}`, { status: 400 });
  return result;
}

function cleanNumber(value, name, minimum = 0) {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result) || result < minimum) throw new Response(`Invalid ${name}`, { status: 400 });
  return result;
}

function sourceName(value) {
  const source = String(value || '').toUpperCase();
  if (!['LOCAL', 'AMUL'].includes(source)) throw new Response('Invalid source', { status: 400 });
  return source;
}

async function inventory(request, env) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 60);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const statement = env.DB.prepare(`SELECT product_id,sku,product_name,category,unit,stock_qty,reserved_qty,
    MAX(0,stock_qty-reserved_qty) available_qty,mrp_paise,selling_price_paise,synced_at
    FROM inventory WHERE active=1 AND (?1='' OR product_name LIKE ?2 ESCAPE '\\' OR sku LIKE ?2 ESCAPE '\\')
    ORDER BY available_qty>0 DESC,product_name LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset);
  const [items, total, sync] = await Promise.all([
    statement.all(),
    env.DB.prepare("SELECT COUNT(*) count FROM inventory WHERE active=1 AND (?1='' OR product_name LIKE ?2 ESCAPE '\\' OR sku LIKE ?2 ESCAPE '\\')").bind(query, pattern).first(),
    env.DB.prepare("SELECT value,updated_at FROM sync_state WHERE key='current_snapshot'").first(),
  ]);
  return json({ items: items.results || [], total: total?.count || 0, sync: sync || null });
}

async function acceptSnapshot(request, env) {
  const body = await readObject(request, 500_000);
  const deviceId = cleanText(body.device_id, 'device_id', 80);
  const snapshotId = cleanText(body.snapshot_id, 'snapshot_id', 100);
  const capturedAt = cleanText(body.captured_at, 'captured_at', 40);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > 40) throw new Response('Use at most 40 products per sync chunk', { status: 400 });
  if (body.complete && items.length) throw new Response('Send the completion marker as an empty final chunk', { status: 400 });

  const statements = items.map((item) => {
    const productId = cleanText(item.product_id, 'product_id', 100);
    const productName = cleanText(item.product_name, 'product_name', 200);
    const stock = Number(item.stock_qty || 0);
    if (!Number.isFinite(stock) || stock < 0) throw new Response(`Invalid stock for ${productId}`, { status: 400 });
    const mrp = Math.max(0, Math.trunc(Number(item.mrp_paise || 0)));
    const selling = Math.max(0, Math.trunc(Number(item.selling_price_paise || 0)));
    return env.DB.prepare(`INSERT INTO inventory(product_id,sku,product_name,category,unit,stock_qty,mrp_paise,selling_price_paise,active,source_device,snapshot_id,source_updated_at,synced_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,CURRENT_TIMESTAMP)
      ON CONFLICT(product_id) DO UPDATE SET sku=excluded.sku,product_name=excluded.product_name,category=excluded.category,unit=excluded.unit,
      stock_qty=excluded.stock_qty,mrp_paise=excluded.mrp_paise,selling_price_paise=excluded.selling_price_paise,active=excluded.active,
      source_device=excluded.source_device,snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
      .bind(productId, cleanText(item.sku, 'sku', 100, false), productName, cleanText(item.category, 'category', 100, false) || 'Other', cleanText(item.unit, 'unit', 20, false) || 'PCS', stock, mrp, selling, item.active === false ? 0 : 1, deviceId, snapshotId, cleanText(item.source_updated_at, 'source_updated_at', 40, false));
  });
  if (statements.length) await env.DB.batch(statements);

  if (body.complete) {
    const count = await env.DB.prepare('SELECT COUNT(*) count FROM inventory WHERE source_device=?1 AND snapshot_id=?2').bind(deviceId, snapshotId).first();
    await env.DB.batch([
      env.DB.prepare('UPDATE inventory SET active=0 WHERE source_device=?1 AND snapshot_id<>?2').bind(deviceId, snapshotId),
      env.DB.prepare('INSERT OR REPLACE INTO sync_runs(snapshot_id,device_id,captured_at,product_count,completed_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)').bind(snapshotId, deviceId, capturedAt, count?.count || 0),
      env.DB.prepare("INSERT INTO sync_state(key,value,updated_at) VALUES('current_snapshot',?1,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({ snapshot_id: snapshotId, device_id: deviceId, captured_at: capturedAt, product_count: count?.count || 0 })),
    ]);
    return json({ accepted: true, complete: true, product_count: count?.count || 0 });
  }
  return json({ accepted: true, complete: false, product_count: items.length });
}

function businessStatement(env, dataset, item, deviceId, snapshotId) {
  const source = sourceName(item.source);
  const id = cleanText(item.id, 'id', 140);
  const sourceId = cleanText(item.source_id, 'source_id', 100);
  const updated = cleanText(item.source_updated_at, 'source_updated_at', 40, false);
  if (dataset === 'customers') return env.DB.prepare(`INSERT INTO customers
    (id,source,source_id,code,name,mobile,whatsapp_number,gstin,address,city,route_id,route_name,credit_days,credit_limit_paise,balance_paise,active,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,mobile=excluded.mobile,whatsapp_number=excluded.whatsapp_number,
    gstin=excluded.gstin,address=excluded.address,city=excluded.city,route_id=excluded.route_id,route_name=excluded.route_name,
    credit_days=excluded.credit_days,credit_limit_paise=excluded.credit_limit_paise,balance_paise=excluded.balance_paise,
    active=excluded.active,source_device=excluded.source_device,snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.code, 'code', 80, false), cleanText(item.name, 'name', 200), cleanPhone(item.mobile), cleanPhone(item.whatsapp_number), cleanText(item.gstin, 'gstin', 30, false), cleanText(item.address, 'address', 500, false), cleanText(item.city, 'city', 100, false), cleanText(item.route_id, 'route_id', 100, false), cleanText(item.route_name, 'route_name', 150, false), cleanInteger(item.credit_days, 'credit_days'), cleanInteger(item.credit_limit_paise, 'credit_limit_paise'), Math.trunc(Number(item.balance_paise || 0)), item.active === false ? 0 : 1, deviceId, snapshotId, updated);
  if (dataset === 'routes') return env.DB.prepare(`INSERT INTO routes
    (id,source,source_id,code,name,active,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,active=excluded.active,source_device=excluded.source_device,
    snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.code, 'code', 80, false), cleanText(item.name, 'name', 150), item.active === false ? 0 : 1, deviceId, snapshotId, updated);
  if (dataset === 'distribution_orders') return env.DB.prepare(`INSERT INTO distribution_orders
    (id,source,source_id,order_number,customer_id,customer_name,phone,route_name,order_date,delivery_date,status,total_paise,notes,lines_json,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET order_number=excluded.order_number,customer_id=excluded.customer_id,customer_name=excluded.customer_name,
    phone=excluded.phone,route_name=excluded.route_name,order_date=excluded.order_date,delivery_date=excluded.delivery_date,status=excluded.status,
    total_paise=excluded.total_paise,notes=excluded.notes,lines_json=excluded.lines_json,source_device=excluded.source_device,
    snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.order_number, 'order_number', 100), cleanText(item.customer_id, 'customer_id', 140, false), cleanText(item.customer_name, 'customer_name', 200), cleanPhone(item.phone), cleanText(item.route_name, 'route_name', 150, false), cleanText(item.order_date, 'order_date', 40, false), cleanText(item.delivery_date, 'delivery_date', 40, false), cleanText(item.status, 'status', 40), cleanInteger(item.total_paise, 'total_paise'), cleanText(item.notes, 'notes', 500, false), JSON.stringify(Array.isArray(item.lines) ? item.lines.slice(0, 100) : []), deviceId, snapshotId, updated);
  if (dataset === 'invoices') return env.DB.prepare(`INSERT INTO invoices
    (id,source,source_id,invoice_number,invoice_date,due_date,customer_id,customer_name,mobile,route_name,total_paise,paid_paise,outstanding_paise,payment_status,status,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET invoice_number=excluded.invoice_number,invoice_date=excluded.invoice_date,due_date=excluded.due_date,
    customer_id=excluded.customer_id,customer_name=excluded.customer_name,mobile=excluded.mobile,route_name=excluded.route_name,
    total_paise=excluded.total_paise,paid_paise=excluded.paid_paise,outstanding_paise=excluded.outstanding_paise,
    payment_status=excluded.payment_status,status=excluded.status,source_device=excluded.source_device,snapshot_id=excluded.snapshot_id,
    source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.invoice_number, 'invoice_number', 100), cleanText(item.invoice_date, 'invoice_date', 40, false), cleanText(item.due_date, 'due_date', 40, false), cleanText(item.customer_id, 'customer_id', 140, false), cleanText(item.customer_name, 'customer_name', 200), cleanPhone(item.mobile), cleanText(item.route_name, 'route_name', 150, false), cleanInteger(item.total_paise, 'total_paise'), cleanInteger(item.paid_paise, 'paid_paise'), cleanInteger(item.outstanding_paise, 'outstanding_paise'), cleanText(item.payment_status, 'payment_status', 40), cleanText(item.status, 'status', 40, false) || 'POSTED', deviceId, snapshotId, updated);
  if (dataset === 'payments') return env.DB.prepare(`INSERT INTO payments
    (id,source,source_id,receipt_number,payment_date,customer_id,customer_name,direction,method,amount_paise,reference_number,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number,payment_date=excluded.payment_date,customer_id=excluded.customer_id,
    customer_name=excluded.customer_name,direction=excluded.direction,method=excluded.method,amount_paise=excluded.amount_paise,
    reference_number=excluded.reference_number,source_device=excluded.source_device,snapshot_id=excluded.snapshot_id,
    source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.receipt_number, 'receipt_number', 100, false), cleanText(item.payment_date, 'payment_date', 40, false), cleanText(item.customer_id, 'customer_id', 140, false), cleanText(item.customer_name, 'customer_name', 200, false), cleanText(item.direction, 'direction', 20), cleanText(item.method, 'method', 30, false), cleanInteger(item.amount_paise, 'amount_paise'), cleanText(item.reference_number, 'reference_number', 100, false), deviceId, snapshotId, updated);
  throw new Response('Unsupported business dataset', { status: 400 });
}

async function acceptBusinessSnapshot(request, env) {
  const body = await readObject(request, 750_000);
  const dataset = cleanText(body.dataset, 'dataset', 40);
  if (!['customers', 'routes', 'distribution_orders', 'invoices', 'payments'].includes(dataset)) throw new Response('Unsupported business dataset', { status: 400 });
  const deviceId = cleanText(body.device_id, 'device_id', 80);
  const snapshotId = cleanText(body.snapshot_id, 'snapshot_id', 100);
  const capturedAt = cleanText(body.captured_at, 'captured_at', 40);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > 40) throw new Response('Use at most 40 records per sync chunk', { status: 400 });
  if (body.complete && items.length) throw new Response('Send completion as an empty final chunk', { status: 400 });
  if (items.length) await env.DB.batch(items.map((item) => businessStatement(env, dataset, item, deviceId, snapshotId)));
  if (body.complete) {
    const statements = [];
    if (dataset === 'customers' || dataset === 'routes') statements.push(env.DB.prepare(`UPDATE ${dataset} SET active=0 WHERE source_device=?1 AND snapshot_id<>?2`).bind(deviceId, snapshotId));
    const count = await env.DB.prepare(`SELECT COUNT(*) count FROM ${dataset} WHERE source_device=?1 AND snapshot_id=?2`).bind(deviceId, snapshotId).first();
    statements.push(env.DB.prepare('INSERT INTO sync_state(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP')
      .bind(`business:${dataset}`, JSON.stringify({ dataset, snapshot_id: snapshotId, device_id: deviceId, captured_at: capturedAt, record_count: count?.count || 0 })));
    await env.DB.batch(statements);
    return json({ accepted: true, dataset, complete: true, record_count: count?.count || 0 });
  }
  return json({ accepted: true, dataset, complete: false, record_count: items.length });
}

async function createOrder(request, env) {
  const body = await readObject(request);
  const requestId = cleanText(body.request_id, 'request_id', 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Response('Invalid request_id', { status: 400 });
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length || lines.length > 20) throw new Response('Choose 1 to 20 products', { status: 400 });
  const existing = await env.DB.prepare('SELECT id,status FROM orders WHERE request_id=?1').bind(requestId).first();
  if (existing) return json(existing, 200);
  const id = crypto.randomUUID();
  const customerId = cleanText(body.customer_id, 'customer_id', 140, false);
  const savedCustomer = customerId ? await env.DB.prepare('SELECT name,mobile,whatsapp_number,address,route_name FROM customers WHERE id=?1 AND active=1').bind(customerId).first() : null;
  if (customerId && !savedCustomer) throw new Response('Selected customer is unavailable', { status: 400 });
  const customer = cleanText(savedCustomer?.name || body.customer_name, 'customer_name', 120);
  const preparedLines = [];
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const productId = cleanText(line.product_id, 'product_id', 100);
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) throw new Response('Invalid quantity', { status: 400 });
    const product = await env.DB.prepare('SELECT product_name,unit,selling_price_paise FROM inventory WHERE product_id=?1 AND active=1').bind(productId).first();
    if (!product) throw new Response(`Unknown product ${productId}`, { status: 400 });
    total += Math.round(quantity * Number(product.selling_price_paise || 0));
    preparedLines.push(env.DB.prepare('INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,price_paise) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(id, index + 1, productId, product.product_name, quantity, cleanText(line.unit, 'unit', 20, false) || product.unit, product.selling_price_paise || 0));
  }
  const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  const orderNumber = `WEB-${businessDate}-${id.slice(0, 6).toUpperCase()}`;
  const statements = [env.DB.prepare(`INSERT INTO orders
    (id,request_id,source,customer_id,customer_name,phone,address,note,status,order_number,route_name,delivery_date,total_paise,workflow_status,updated_at)
    VALUES(?1,?2,'ONLINE',?3,?4,?5,?6,?7,'NEW',?8,?9,?10,?11,'RECEIVED',CURRENT_TIMESTAMP)`)
    .bind(id, requestId, customerId || null, customer, cleanPhone(body.phone || savedCustomer?.whatsapp_number || savedCustomer?.mobile), cleanText(body.address || savedCustomer?.address, 'address', 400, false), cleanText(body.note, 'note', 400, false), orderNumber, cleanText(body.route_name || savedCustomer?.route_name, 'route_name', 150, false), cleanText(body.delivery_date, 'delivery_date', 40, false), total), ...preparedLines];
  try { await env.DB.batch(statements); } catch (error) {
    if (String(error).includes('INSUFFICIENT_STOCK')) throw new Response('Insufficient available stock', { status: 409 });
    throw error;
  }
  return json({ id, request_id: requestId, order_number: orderNumber, status: 'NEW', workflow_status: 'RECEIVED', total_paise: total }, 201);
}

async function listOrders(env, syncOnly = false) {
  const where = syncOnly ? "WHERE status='NEW'" : '';
  const orders = (await env.DB.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 200`).all()).results || [];
  for (const order of orders) order.lines = (await env.DB.prepare('SELECT line_no,product_id,product_name,quantity,unit,price_paise FROM order_lines WHERE order_id=?1 ORDER BY line_no').bind(order.id).all()).results || [];
  return orders;
}

async function updateOrder(request, env, id, action) {
  const workflow = { confirm: 'CONFIRMED', pack: 'PACKING', dispatch: 'OUT_FOR_DELIVERY', deliver: 'DELIVERED', fulfil: 'DELIVERED', cancel: 'CANCELLED', ack: null }[action];
  if (workflow === undefined) return json({ error: 'Unknown action' }, 404);
  const target = action === 'cancel' ? 'CANCELLED' : ['deliver', 'fulfil'].includes(action) ? 'FULFILLED' : action === 'ack' ? 'SYNCED' : null;
  const allowed = action === 'ack' ? "status='NEW'" : "status IN ('NEW','SYNCED')";
  const result = await env.DB.prepare(`UPDATE orders SET
    status=COALESCE(?1,status),workflow_status=COALESCE(?2,workflow_status),updated_at=CURRENT_TIMESTAMP,
    synced_at=CASE WHEN ?1='SYNCED' THEN CURRENT_TIMESTAMP ELSE synced_at END,
    completed_at=CASE WHEN ?1 IN ('FULFILLED','CANCELLED') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id=?3 AND ${allowed}`).bind(target, workflow, id).run();
  if (!result.meta?.changes) return json({ error: 'Order not found or already completed' }, 409);
  return json({ id, status: target, workflow_status: workflow });
}

async function dashboard(env) {
  const [inventorySummary, orderSummary, accountSummary, customerSummary, syncRows] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) products,COALESCE(SUM(stock_qty),0) stock_units,COALESCE(SUM(reserved_qty),0) reserved_units,COALESCE(SUM(CASE WHEN stock_qty-reserved_qty<=0 THEN 1 ELSE 0 END),0) out_of_stock FROM inventory WHERE active=1').first(),
    env.DB.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status IN ('NEW','SYNCED') THEN 1 ELSE 0 END),0) open_orders,COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN total_paise ELSE 0 END),0) today_value_paise FROM orders").first(),
    env.DB.prepare("SELECT COALESCE(SUM(outstanding_paise),0) receivable_paise,COALESCE(SUM(CASE WHEN due_date<>'' AND date(due_date)<date('now') AND outstanding_paise>0 THEN outstanding_paise ELSE 0 END),0) overdue_paise,COALESCE(SUM(CASE WHEN substr(invoice_date,1,7)=substr(date('now'),1,7) THEN total_paise ELSE 0 END),0) month_sales_paise FROM invoices WHERE status<>'VOID'").first(),
    env.DB.prepare('SELECT COUNT(*) customers FROM customers WHERE active=1').first(),
    env.DB.prepare("SELECT key,value,updated_at FROM sync_state WHERE key='current_snapshot' OR key LIKE 'business:%' ORDER BY key").all(),
  ]);
  return json({ inventory: inventorySummary, orders: orderSummary, accounts: accountSummary, customers: customerSummary, sync: syncRows.results || [] });
}

function pageParams(request) {
  const url = new URL(request.url);
  return { query: String(url.searchParams.get('q') || '').trim().slice(0, 80), limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100))), offset: Math.max(0, Number(url.searchParams.get('offset') || 0)) };
}

async function customers(request, env) {
  const { query, limit, offset } = pageParams(request);
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await env.DB.prepare(`SELECT * FROM customers WHERE active=1 AND (?1='' OR name LIKE ?2 ESCAPE '\\' OR code LIKE ?2 ESCAPE '\\' OR mobile LIKE ?2 ESCAPE '\\' OR route_name LIKE ?2 ESCAPE '\\') ORDER BY name LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all();
  return json({ customers: rows.results || [] });
}

async function distributionOrders(request, env) {
  const { query, limit, offset } = pageParams(request);
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await env.DB.prepare(`SELECT * FROM distribution_orders WHERE ?1='' OR order_number LIKE ?2 ESCAPE '\\' OR customer_name LIKE ?2 ESCAPE '\\' OR route_name LIKE ?2 ESCAPE '\\' ORDER BY order_date DESC,id DESC LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all();
  for (const row of rows.results || []) { try { row.lines = JSON.parse(row.lines_json || '[]'); } catch { row.lines = []; } delete row.lines_json; }
  return json({ orders: rows.results || [] });
}

async function invoices(request, env) {
  const { query, limit, offset } = pageParams(request);
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await env.DB.prepare(`SELECT * FROM invoices WHERE ?1='' OR invoice_number LIKE ?2 ESCAPE '\\' OR customer_name LIKE ?2 ESCAPE '\\' OR mobile LIKE ?2 ESCAPE '\\' ORDER BY invoice_date DESC,id DESC LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all();
  return json({ invoices: rows.results || [] });
}

async function payments(request, env) {
  const { query, limit, offset } = pageParams(request);
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await env.DB.prepare(`SELECT * FROM payments WHERE ?1='' OR receipt_number LIKE ?2 ESCAPE '\\' OR customer_name LIKE ?2 ESCAPE '\\' OR reference_number LIKE ?2 ESCAPE '\\' ORDER BY payment_date DESC,id DESC LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all();
  return json({ payments: rows.results || [] });
}

async function validMetaSignature(request, secret, raw) {
  if (!secret) return false;
  const supplied = request.headers.get('x-hub-signature-256') || '';
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(raw)));
  const expected = `sha256=${[...signed].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return equalSecret(supplied, expected);
}

async function whatsappWebhook(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    if (url.searchParams.get('hub.mode') === 'subscribe' && await equalSecret(url.searchParams.get('hub.verify_token') || '', env.META_WEBHOOK_VERIFY_TOKEN || '')) return text(url.searchParams.get('hub.challenge') || '');
    return text('Verification failed', 403);
  }
  if (request.method !== 'POST') return text('Method not allowed', 405);
  const raw = await request.text();
  if (raw.length > 1_000_000) return text('Too large', 413);
  if (!await validMetaSignature(request, env.META_APP_SECRET, raw)) return text('Invalid signature', 403);
  let payload;
  try { payload = JSON.parse(raw); } catch { return text('Invalid JSON', 400); }
  if (payload.object !== 'whatsapp_business_account') return text('Invalid object', 400);
  const statements = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    if (change.field !== 'messages') continue;
    const value = change.value || {};
    if (env.META_PHONE_ID && value.metadata?.phone_number_id !== env.META_PHONE_ID) continue;
    for (const message of value.messages || []) {
      if (!message.id) continue;
      const flow = message.interactive?.nfm_reply?.response_json;
      const body = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || flow || null;
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,message_type,body,raw_json,event_time)
        VALUES(?1,'MESSAGE',?2,?3,?4,?5,?6)`).bind(message.id, String(message.from || ''), String(message.type || 'unknown'), body, JSON.stringify(message), String(message.timestamp || '')));
    }
    for (const status of value.statuses || []) if (status.id && status.timestamp) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,message_type,body,raw_json,event_time)
        VALUES(?1,'STATUS',?2,?3,?4,?5,?6)`).bind(`${status.id}:${status.status}:${status.timestamp}`, String(status.recipient_id || ''), String(status.status || ''), status.errors ? JSON.stringify(status.errors) : null, JSON.stringify(status), String(status.timestamp)));
    }
  }
  if (statements.length) await env.DB.batch(statements.slice(0, 50));
  return text('EVENT_RECEIVED');
}

async function sendWhatsApp(request, env) {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_ID) return json({ error: 'WhatsApp sending is not configured yet.' }, 503);
  const body = await readObject(request, 100_000);
  const to = cleanPhone(body.to);
  if (!to) throw new Response('Recipient number is required', { status: 400 });
  const templateName = cleanText(body.template_name, 'template_name', 120, false);
  let message;
  if (templateName) {
    message = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name: templateName, language: { code: cleanText(body.language, 'language', 20, false) || 'en' } } };
  } else {
    const content = cleanText(body.text, 'message', 4096);
    message = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: content } };
  }
  const version = /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || '') ? env.META_GRAPH_VERSION : 'v23.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(env.META_PHONE_ID)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: result.error?.message || `Meta rejected the message (${response.status})`, meta_code: result.error?.code || null }, 502);
  const messageId = result.messages?.[0]?.id || crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,message_type,body,raw_json,event_time)
    VALUES(?1,'OUTBOUND',?2,?3,?4,?5,?6)`).bind(`out:${messageId}`, to, message.type, templateName || message.text.body, JSON.stringify(result), String(Math.floor(Date.now() / 1000))).run();
  return json({ accepted: true, message_id: messageId, to, type: message.type }, 201);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/health') return json({ ok: true, service: 'frostflow-online', version: '0.2.0' });
  if (path === '/webhooks/whatsapp' || path === '/webhooks/whatsapp/') return whatsappWebhook(request, env);

  if (path.startsWith('/api/sync/')) {
    if (!await syncAuthorized(request, env)) return json({ error: 'Unauthorized sync agent' }, 401);
    if (path === '/api/sync/snapshot' && request.method === 'POST') return acceptSnapshot(request, env);
    if (path === '/api/sync/business' && request.method === 'POST') return acceptBusinessSnapshot(request, env);
    if (path === '/api/sync/orders' && request.method === 'GET') return json({ orders: await listOrders(env, true) });
    const ack = path.match(/^\/api\/sync\/orders\/([^/]+)\/ack$/);
    if (ack && request.method === 'POST') return updateOrder(request, env, decodeURIComponent(ack[1]), 'ack');
    return json({ error: 'Sync endpoint not found' }, 404);
  }

  if (!await appAuthorized(request, env)) return json({ error: 'Authentication required' }, 401, { 'WWW-Authenticate': 'Basic realm="FrostFlow Online", charset="UTF-8"' });
  if (path === '/api/dashboard' && request.method === 'GET') return dashboard(env);
  if (path === '/api/inventory' && request.method === 'GET') return inventory(request, env);
  if (path === '/api/customers' && request.method === 'GET') return customers(request, env);
  if (path === '/api/distribution/orders' && request.method === 'GET') return distributionOrders(request, env);
  if (path === '/api/invoices' && request.method === 'GET') return invoices(request, env);
  if (path === '/api/payments' && request.method === 'GET') return payments(request, env);
  if (path === '/api/orders' && request.method === 'GET') return json({ orders: await listOrders(env) });
  if (path === '/api/orders' && request.method === 'POST') return createOrder(request, env);
  const orderAction = path.match(/^\/api\/orders\/([^/]+)\/(confirm|pack|dispatch|deliver|cancel|fulfil)$/);
  if (orderAction && request.method === 'POST') return updateOrder(request, env, decodeURIComponent(orderAction[1]), orderAction[2]);
  if (path === '/api/whatsapp/events' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT event_id,event_type,from_number,message_type,body,event_time,received_at FROM whatsapp_events ORDER BY received_at DESC LIMIT 200').all();
    return json({ events: rows.results || [] });
  }
  if (path === '/api/whatsapp/send' && request.method === 'POST') return sendWhatsApp(request, env);
  if (path.startsWith('/api/')) return json({ error: 'API endpoint not found' }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof Response) return new Response(await error.text(), { status: error.status, headers: { ...securityHeaders, 'Content-Type': error.headers.get('content-type') || 'text/plain; charset=utf-8' } });
      console.error('Request failed', error);
      return json({ error: 'Request failed safely; no partial operation was accepted.' }, 500);
    }
  },
};

export { equalSecret, cleanPhone };
