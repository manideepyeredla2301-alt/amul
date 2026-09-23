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
  let result = String(value ?? '').replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(result)) result = `91${result}`;
  if (result && !/^[1-9]\d{7,14}$/.test(result)) throw new Response('Invalid phone number', { status: 400 });
  return result;
}

function cleanGstin(value) {
  const result = String(value ?? '').trim().toUpperCase();
  if (result && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(result)) throw new Response('Invalid GSTIN', { status: 400 });
  return result;
}

function cleanCoordinate(value, name, minimum, maximum) {
  if (value === '' || value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Response(`Invalid ${name}`, { status: 400 });
  return result;
}

function cleanLocationUrl(value, latitude, longitude) {
  const raw = String(value ?? '').trim();
  if (!raw && latitude !== null && longitude !== null) return `https://www.google.com/maps?q=${latitude},${longitude}`;
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Response('Invalid Google Maps link', { status: 400 }); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !['maps.app.goo.gl', 'goo.gl', 'www.google.com', 'google.com'].includes(host)) throw new Response('Use a Google Maps link', { status: 400 });
  return parsed.toString().slice(0, 600);
}

function cleanDeliveryDate(value, required = false) {
  const result = String(value ?? '').trim();
  if (!result && required) throw new Response('Expected delivery date is required', { status: 400 });
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Response('Invalid expected delivery date', { status: 400 });
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

async function createOrder(request, env, options = {}) {
  const body = await readObject(request);
  const requestId = cleanText(body.request_id, 'request_id', 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Response('Invalid request_id', { status: 400 });
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length || lines.length > 20) throw new Response('Choose 1 to 20 products', { status: 400 });
  const existing = await env.DB.prepare('SELECT id,status,order_number,total_paise FROM orders WHERE request_id=?1').bind(requestId).first();
  if (existing) return json(existing, 200);
  const id = crypto.randomUUID();
  const customerId = cleanText(body.customer_id, 'customer_id', 140, false);
  const savedCustomer = customerId ? await env.DB.prepare('SELECT name,mobile,whatsapp_number,address,route_name FROM customers WHERE id=?1 AND active=1').bind(customerId).first() : null;
  if (customerId && !savedCustomer) throw new Response('Selected customer is unavailable', { status: 400 });
  const phone = cleanPhone(body.phone || savedCustomer?.whatsapp_number || savedCustomer?.mobile);
  if (options.publicCatalog && !phone) throw new Response('WhatsApp phone number is required', { status: 400 });
  const onlineProfile = phone ? await env.DB.prepare('SELECT * FROM whatsapp_customers WHERE phone=?1').bind(phone).first() : null;
  const customer = cleanText(body.shop_name || body.customer_name || onlineProfile?.shop_name || onlineProfile?.display_name || savedCustomer?.name, 'shop_name', 120);
  const contactName = cleanText(body.contact_name || onlineProfile?.contact_name, 'contact_name', 120, false);
  const address = cleanText(body.address || onlineProfile?.address || savedCustomer?.address, 'address', 400, options.publicCatalog);
  const gstin = cleanGstin(body.gstin || onlineProfile?.gstin);
  const latitude = cleanCoordinate(body.location_lat, 'latitude', -90, 90);
  const longitude = cleanCoordinate(body.location_lng, 'longitude', -180, 180);
  if ((latitude === null) !== (longitude === null)) throw new Response('Both location coordinates are required', { status: 400 });
  const locationUrl = cleanLocationUrl(body.location_url || onlineProfile?.location_url, latitude, longitude);
  const deliveryDate = cleanDeliveryDate(body.delivery_date, options.publicCatalog);
  if (options.publicCatalog) {
    const recent = await env.DB.prepare("SELECT COUNT(*) count FROM orders WHERE phone=?1 AND created_at>=datetime('now','-10 minutes')").bind(phone).first();
    if (Number(recent?.count || 0) >= 4) throw new Response('Too many recent orders. Please wait a few minutes.', { status: 429 });
  }
  const preparedLines = [];
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const requestedProductId = cleanText(line.product_id, 'product_id', 100);
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) throw new Response('Invalid quantity', { status: 400 });
    const prefixedProductId = requestedProductId.startsWith('AMUL:') ? requestedProductId : `AMUL:${requestedProductId}`;
    const product = await env.DB.prepare(`SELECT product_id,product_name,unit,selling_price_paise
      FROM inventory WHERE active=1 AND (product_id=?1 OR product_id=?2 OR sku=?1) LIMIT 1`)
      .bind(requestedProductId, prefixedProductId).first();
    if (!product) throw new Response(`Unknown product ${requestedProductId}`, { status: 400 });
    total += Math.round(quantity * Number(product.selling_price_paise || 0));
    preparedLines.push(env.DB.prepare('INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,price_paise) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(id, index + 1, product.product_id, product.product_name, quantity, cleanText(line.unit, 'unit', 20, false) || product.unit, product.selling_price_paise || 0));
  }
  const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  const source = options.source === 'WHATSAPP' ? 'WHATSAPP' : 'ONLINE';
  const orderNumber = `${source === 'WHATSAPP' ? 'WA' : 'WEB'}-${businessDate}-${id.slice(0, 6).toUpperCase()}`;
  const statements = [env.DB.prepare(`INSERT INTO orders
    (id,request_id,source,customer_id,customer_name,phone,address,note,status,order_number,route_name,delivery_date,total_paise,workflow_status,updated_at,contact_name,gstin,location_url,location_lat,location_lng)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'NEW',?9,?10,?11,?12,'RECEIVED',CURRENT_TIMESTAMP,?13,?14,?15,?16,?17)`)
    .bind(id, requestId, source, customerId || (phone ? `WHATSAPP:${phone}` : null), customer, phone, address, cleanText(body.note, 'note', 400, false), orderNumber, cleanText(body.route_name || savedCustomer?.route_name, 'route_name', 150, false), deliveryDate, total, contactName, gstin, locationUrl, latitude, longitude), ...preparedLines];
  if (phone) statements.push(env.DB.prepare(`INSERT INTO whatsapp_customers
    (phone,display_name,shop_name,contact_name,gstin,address,location_url,location_lat,location_lng,last_order_id,last_order_at,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      display_name=COALESCE(NULLIF(excluded.display_name,''),whatsapp_customers.display_name),
      shop_name=COALESCE(NULLIF(excluded.shop_name,''),whatsapp_customers.shop_name),
      contact_name=COALESCE(NULLIF(excluded.contact_name,''),whatsapp_customers.contact_name),
      gstin=COALESCE(NULLIF(excluded.gstin,''),whatsapp_customers.gstin),
      address=COALESCE(NULLIF(excluded.address,''),whatsapp_customers.address),
      location_url=COALESCE(NULLIF(excluded.location_url,''),whatsapp_customers.location_url),
      location_lat=COALESCE(excluded.location_lat,whatsapp_customers.location_lat),
      location_lng=COALESCE(excluded.location_lng,whatsapp_customers.location_lng),
      last_order_id=excluded.last_order_id,last_order_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(phone, contactName || customer, customer, contactName, gstin, address, locationUrl, latitude, longitude, id));
  try { await env.DB.batch(statements); } catch (error) {
    if (String(error).includes('INSUFFICIENT_STOCK')) throw new Response('Insufficient available stock', { status: 409 });
    throw error;
  }
  return json({ id, request_id: requestId, order_number: orderNumber, status: 'NEW', workflow_status: 'RECEIVED', total_paise: total, delivery_date: deliveryDate }, 201);
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
  const [inventorySummary, orderSummary, accountSummary, customerSummary, whatsappCustomerSummary, syncRows] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) products,COALESCE(SUM(stock_qty),0) stock_units,COALESCE(SUM(reserved_qty),0) reserved_units,COALESCE(SUM(CASE WHEN stock_qty-reserved_qty<=0 THEN 1 ELSE 0 END),0) out_of_stock FROM inventory WHERE active=1').first(),
    env.DB.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status IN ('NEW','SYNCED') THEN 1 ELSE 0 END),0) open_orders,COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN total_paise ELSE 0 END),0) today_value_paise FROM orders").first(),
    env.DB.prepare("SELECT COALESCE(SUM(outstanding_paise),0) receivable_paise,COALESCE(SUM(CASE WHEN due_date<>'' AND date(due_date)<date('now') AND outstanding_paise>0 THEN outstanding_paise ELSE 0 END),0) overdue_paise,COALESCE(SUM(CASE WHEN substr(invoice_date,1,7)=substr(date('now'),1,7) THEN total_paise ELSE 0 END),0) month_sales_paise FROM invoices WHERE status<>'VOID'").first(),
    env.DB.prepare('SELECT COUNT(*) customers FROM customers WHERE active=1').first(),
    env.DB.prepare('SELECT COUNT(*) customers FROM whatsapp_customers').first(),
    env.DB.prepare("SELECT key,value,updated_at FROM sync_state WHERE key='current_snapshot' OR key LIKE 'business:%' ORDER BY key").all(),
  ]);
  return json({ inventory: inventorySummary, orders: orderSummary, accounts: accountSummary, customers: { customers: Number(customerSummary?.customers || 0) + Number(whatsappCustomerSummary?.customers || 0) }, sync: syncRows.results || [] });
}

function pageParams(request) {
  const url = new URL(request.url);
  return { query: String(url.searchParams.get('q') || '').trim().slice(0, 80), limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100))), offset: Math.max(0, Number(url.searchParams.get('offset') || 0)) };
}

async function customers(request, env) {
  const { query, limit, offset } = pageParams(request);
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const [rows, onlineRows] = await Promise.all([
    env.DB.prepare(`SELECT * FROM customers WHERE active=1 AND (?1='' OR name LIKE ?2 ESCAPE '\\' OR code LIKE ?2 ESCAPE '\\' OR mobile LIKE ?2 ESCAPE '\\' OR route_name LIKE ?2 ESCAPE '\\') ORDER BY name LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all(),
    env.DB.prepare(`SELECT * FROM whatsapp_customers WHERE ?1='' OR shop_name LIKE ?2 ESCAPE '\\' OR display_name LIKE ?2 ESCAPE '\\' OR phone LIKE ?2 ESCAPE '\\' OR gstin LIKE ?2 ESCAPE '\\' ORDER BY COALESCE(shop_name,display_name,phone) LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all(),
  ]);
  const result = rows.results || [];
  const knownPhones = new Set(result.flatMap(row => [row.mobile, row.whatsapp_number]).filter(Boolean).map(value => cleanPhone(value)));
  for (const profile of onlineRows.results || []) if (!knownPhones.has(profile.phone)) result.push({
    id: `WHATSAPP:${profile.phone}`, source: 'WHATSAPP', source_id: profile.phone, code: 'ONLINE',
    name: profile.shop_name || profile.display_name || profile.phone, mobile: profile.phone, whatsapp_number: profile.phone,
    gstin: profile.gstin || '', address: profile.address || '', city: '', route_id: '', route_name: '', credit_days: 0,
    credit_limit_paise: 0, balance_paise: 0, active: 1, location_url: profile.location_url || '', last_order_at: profile.last_order_at,
  });
  return json({ customers: result.slice(0, limit) });
}

async function whatsappConversations(env) {
  const [eventRows, profileRows, customerRows, orderRows] = await Promise.all([
    env.DB.prepare(`SELECT event_id,event_type,from_number,customer_name,direction,message_type,body,event_time,received_at,order_id
      FROM whatsapp_events WHERE from_number<>'' ORDER BY received_at DESC LIMIT 500`).all(),
    env.DB.prepare('SELECT * FROM whatsapp_customers ORDER BY updated_at DESC LIMIT 300').all(),
    env.DB.prepare('SELECT name,mobile,whatsapp_number,gstin,address FROM customers WHERE active=1').all(),
    env.DB.prepare('SELECT id,order_number,phone,delivery_date,status,workflow_status,total_paise,created_at FROM orders ORDER BY created_at DESC LIMIT 300').all(),
  ]);
  const profiles = new Map((profileRows.results || []).map(profile => [profile.phone, profile]));
  const syncedNames = new Map();
  for (const customer of customerRows.results || []) for (const value of [customer.whatsapp_number, customer.mobile]) {
    if (!value) continue;
    try { syncedNames.set(cleanPhone(value), customer); } catch { /* Ignore malformed legacy phone values. */ }
  }
  const ordersByPhone = new Map();
  for (const order of orderRows.results || []) if (order.phone && !ordersByPhone.has(order.phone)) ordersByPhone.set(order.phone, order);
  const conversations = new Map();
  for (const event of eventRows.results || []) {
    let phone;
    try { phone = cleanPhone(event.from_number); } catch { continue; }
    if (!phone) continue;
    if (!conversations.has(phone)) {
      const profile = profiles.get(phone) || {};
      const synced = syncedNames.get(phone) || {};
      conversations.set(phone, {
        phone,
        name: profile.shop_name || synced.name || profile.display_name || event.customer_name || phone,
        contact_name: profile.contact_name || profile.display_name || '',
        gstin: profile.gstin || synced.gstin || '',
        address: profile.address || synced.address || '',
        location_url: profile.location_url || '',
        last_order: ordersByPhone.get(phone) || null,
        messages: [],
      });
    }
    conversations.get(phone).messages.push({ ...event, direction: event.direction || (['OUTBOUND', 'AUTO_REPLY', 'ORDER_REPLY'].includes(event.event_type) ? 'OUTBOUND' : event.event_type === 'STATUS' ? 'SYSTEM' : 'INBOUND') });
  }
  for (const [phone, profile] of profiles) if (!conversations.has(phone)) conversations.set(phone, {
    phone, name: profile.shop_name || profile.display_name || phone, contact_name: profile.contact_name || profile.display_name || '',
    gstin: profile.gstin || '', address: profile.address || '', location_url: profile.location_url || '', last_order: ordersByPhone.get(phone) || null, messages: [],
  });
  const result = [...conversations.values()];
  for (const conversation of result) conversation.messages.reverse();
  result.sort((a, b) => String(b.messages.at(-1)?.received_at || b.last_order?.created_at || '').localeCompare(String(a.messages.at(-1)?.received_at || a.last_order?.created_at || '')));
  return json({ conversations: result });
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

function catalogueReply(catalogueUrl) {
  return `Welcome to MR Enterprises – Amul Distribution.\n\nOpen our catalogue: ${catalogueUrl}\n\n• Browse Frozen, Dairy, Chocolates and Snacks\n• Tap + / − to add multiple products\n• Review and send one complete order here on WhatsApp\n\nReply CATALOGUE whenever you need this link again.`;
}

function catalogueRequested(body) {
  return /\b(catalog|catalogue|menu|products?|price\s*list)\b/i.test(String(body || ''));
}

const coexistenceWebhookFields = new Set(['account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes']);

function supportsWhatsAppWebhook(field) {
  return field === 'messages' || coexistenceWebhookFields.has(field);
}

async function webhookEventId(entryId, field, value) {
  const bytes = await digest(`${entryId}:${field}:${JSON.stringify(value)}`);
  return `coexist:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function sendMetaMessage(env, to, message) {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_ID) throw new Error('WhatsApp sending is not configured yet.');
  const version = /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || '') ? env.META_GRAPH_VERSION : 'v25.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(env.META_PHONE_ID)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = Number(result.error?.code || 0);
    const friendly = code === 131047
      ? 'The 24-hour customer-service window has expired. Send an approved template to reopen the conversation.'
      : code === 131030
        ? 'This recipient is not available for WhatsApp API delivery. Check the country code and ask the customer to open the business chat first.'
        : result.error?.message || `Meta rejected the message (${response.status})`;
    throw new Error(`${friendly}${code ? ` (Meta ${code})` : ''}`);
  }
  return { result, messageId: result.messages?.[0]?.id || crypto.randomUUID() };
}

async function whatsappTemplates(env) {
  if (!env.META_ACCESS_TOKEN || !env.META_WABA_ID) return json({ error: 'WhatsApp templates are not configured yet.' }, 503);
  const version = /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || '') ? env.META_GRAPH_VERSION : 'v25.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(env.META_WABA_ID)}/message_templates?fields=id,name,status,category,language&limit=100`, {
    headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: result.error?.message || 'Unable to load WhatsApp templates.' }, 502);
  const templates = (result.data || []).map(({ id, name, status, category, language }) => ({ id, name, status, category, language }));
  return json({ templates });
}

function messageBody(message) {
  const flow = message.interactive?.nfm_reply?.response_json;
  return message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.location?.name || flow || null;
}

function collectHistoryMessages(value) {
  const found = [];
  const queue = [value?.messages, value?.history, value?.message_echoes, value?.state_sync].flat().filter(Boolean);
  const seen = new Set();
  while (queue.length && found.length < 200) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) { queue.push(...current); continue; }
    if (current.id && current.timestamp && (current.from || current.to || current.recipient_id) && (current.type || current.text || current.interactive || current.location)) found.push(current);
    for (const key of ['messages', 'message', 'history', 'data', 'items', 'message_echoes']) if (current[key]) queue.push(current[key]);
  }
  return found;
}

function profileUpsert(env, phone, displayName, lastMessage = true) {
  return env.DB.prepare(`INSERT INTO whatsapp_customers(phone,display_name,last_message_at,updated_at)
    VALUES(?1,?2,${lastMessage ? 'CURRENT_TIMESTAMP' : 'NULL'},CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET display_name=COALESCE(NULLIF(excluded.display_name,''),whatsapp_customers.display_name),
    last_message_at=${lastMessage ? 'CURRENT_TIMESTAMP' : 'whatsapp_customers.last_message_at'},updated_at=CURRENT_TIMESTAMP`).bind(phone, displayName || '');
}

async function matchingRecentOrder(env, phone, body) {
  const orderNumber = String(body || '').match(/\b(?:WEB|WA)-\d{8}-[A-Z0-9]{6}\b/i)?.[0]?.toUpperCase();
  if (orderNumber) return env.DB.prepare('SELECT id,order_number,customer_name,delivery_date FROM orders WHERE phone=?1 AND order_number=?2').bind(phone, orderNumber).first();
  if (!/\border\b/i.test(String(body || ''))) return null;
  return env.DB.prepare("SELECT id,order_number,customer_name,delivery_date FROM orders WHERE phone=?1 AND created_at>=datetime('now','-30 minutes') ORDER BY created_at DESC LIMIT 1").bind(phone).first();
}

async function acknowledgeOrder(env, message, body) {
  const to = cleanPhone(message.from);
  const order = await matchingRecentOrder(env, to, body);
  if (!order) return false;
  const reply = `Thank you${order.customer_name ? `, ${order.customer_name}` : ''}. Order ${order.order_number} is saved${order.delivery_date ? ` for ${order.delivery_date}` : ''}. We will confirm stock and delivery here.`;
  try {
    const outbound = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: reply } };
    const { result, messageId } = await sendMetaMessage(env, to, outbound);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time,order_id)
        VALUES(?1,'ORDER_REPLY',?2,?3,'OUTBOUND','text',?4,?5,?6,?7)`).bind(`order-reply:${message.id}`, to, order.customer_name || '', reply, JSON.stringify(result), String(Math.floor(Date.now() / 1000)), order.id),
      env.DB.prepare(`INSERT INTO whatsapp_auto_replies(from_number,last_inbound_message_id,last_catalog_at,last_reply_message_id,status,last_error,updated_at)
        VALUES(?1,?2,NULL,?3,'ORDER_CONFIRMED',NULL,CURRENT_TIMESTAMP)
        ON CONFLICT(from_number) DO UPDATE SET last_inbound_message_id=excluded.last_inbound_message_id,last_reply_message_id=excluded.last_reply_message_id,
        status='ORDER_CONFIRMED',last_error=NULL,updated_at=CURRENT_TIMESTAMP`).bind(to, message.id, messageId),
    ]);
  } catch (error) {
    await env.DB.prepare(`INSERT INTO whatsapp_auto_replies(from_number,last_inbound_message_id,status,last_error,updated_at)
      VALUES(?1,?2,'FAILED',?3,CURRENT_TIMESTAMP)
      ON CONFLICT(from_number) DO UPDATE SET last_inbound_message_id=excluded.last_inbound_message_id,status='FAILED',last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP`)
      .bind(to, message.id, String(error.message || error).slice(0, 500)).run();
  }
  return true;
}

async function autoReplyWithCatalogue(env, requestUrl, message, body) {
  const to = cleanPhone(message.from);
  if (!to) return;
  if (await acknowledgeOrder(env, message, body)) return;
  const [prior, profile] = await Promise.all([
    env.DB.prepare('SELECT last_catalog_at FROM whatsapp_auto_replies WHERE from_number=?1').bind(to).first(),
    env.DB.prepare('SELECT last_order_at FROM whatsapp_customers WHERE phone=?1').bind(to).first(),
  ]);
  const priorTime = prior?.last_catalog_at ? Date.parse(`${String(prior.last_catalog_at).replace(' ', 'T')}Z`) : 0;
  const lastOrderTime = profile?.last_order_at ? Date.parse(`${String(profile.last_order_at).replace(' ', 'T')}Z`) : 0;
  if (!catalogueRequested(body) && Number.isFinite(lastOrderTime) && lastOrderTime > Date.now() - 7 * 86_400_000) return;
  if (!catalogueRequested(body) && Number.isFinite(priorTime) && priorTime > Date.now() - 86_400_000) return;
  const catalogueUrl = String(env.PUBLIC_CATALOG_URL || `${new URL(requestUrl).origin}/catalog`).replace(/\/$/, '');
  try {
    const outbound = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: catalogueReply(catalogueUrl) } };
    const { result, messageId } = await sendMetaMessage(env, to, outbound);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO whatsapp_auto_replies(from_number,last_inbound_message_id,last_catalog_at,last_reply_message_id,status,last_error,updated_at)
        VALUES(?1,?2,CURRENT_TIMESTAMP,?3,'SENT',NULL,CURRENT_TIMESTAMP)
        ON CONFLICT(from_number) DO UPDATE SET last_inbound_message_id=excluded.last_inbound_message_id,last_catalog_at=CURRENT_TIMESTAMP,
        last_reply_message_id=excluded.last_reply_message_id,status='SENT',last_error=NULL,updated_at=CURRENT_TIMESTAMP`).bind(to, message.id, messageId),
      env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,direction,message_type,body,raw_json,event_time)
        VALUES(?1,'AUTO_REPLY',?2,'OUTBOUND','text',?3,?4,?5)`).bind(`auto:${message.id}`, to, catalogueUrl, JSON.stringify(result), String(Math.floor(Date.now() / 1000))),
    ]);
  } catch (error) {
    await env.DB.prepare(`INSERT INTO whatsapp_auto_replies(from_number,last_inbound_message_id,last_catalog_at,last_reply_message_id,status,last_error,updated_at)
      VALUES(?1,?2,NULL,NULL,'FAILED',?3,CURRENT_TIMESTAMP)
      ON CONFLICT(from_number) DO UPDATE SET last_inbound_message_id=excluded.last_inbound_message_id,status='FAILED',last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP`)
      .bind(to, message.id, String(error.message || error).slice(0, 500)).run();
  }
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
  const newMessages = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    if (!supportsWhatsAppWebhook(change.field)) continue;
    const value = change.value || {};
    if (change.field !== 'messages') {
      const historyMessages = ['history', 'smb_message_echoes'].includes(change.field) ? collectHistoryMessages(value) : [];
      for (const historyMessage of historyMessages) {
        let phone;
        try { phone = cleanPhone(historyMessage.from || historyMessage.to || historyMessage.recipient_id); } catch { continue; }
        if (!phone || !historyMessage.id) continue;
        const historyBody = messageBody(historyMessage);
        const direction = change.field === 'smb_message_echoes' ? 'OUTBOUND' : 'HISTORY';
        statements.push(env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,direction,message_type,body,raw_json,event_time)
          VALUES(?1,'COEXISTENCE_MESSAGE',?2,?3,?4,?5,?6,?7)`).bind(`history:${historyMessage.id}`, phone, direction, String(historyMessage.type || 'unknown'), historyBody, JSON.stringify(historyMessage), String(historyMessage.timestamp || entry.time || '')));
        statements.push(profileUpsert(env, phone, historyMessage.profile?.name || '', true));
      }
      const genericId = await webhookEventId(entry.id || '', change.field, value);
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,direction,message_type,body,raw_json,event_time)
        VALUES(?1,'COEXISTENCE',?2,'SYSTEM',?3,?4,?5,?6)`).bind(genericId, String(value.phone_number || value.from || ''), String(change.field), String(value.event || value.sync_type || ''), JSON.stringify(value), String(entry.time || '')));
      continue;
    }
    if (env.META_PHONE_ID && value.metadata?.phone_number_id !== env.META_PHONE_ID) continue;
    for (const message of value.messages || []) {
      if (!message.id) continue;
      const body = messageBody(message);
      const phone = cleanPhone(message.from || '');
      const customerName = value.contacts?.find(contact => cleanPhone(contact.wa_id || '') === phone)?.profile?.name || '';
      const duplicate = await env.DB.prepare('SELECT 1 found FROM whatsapp_events WHERE event_id=?1').bind(message.id).first();
      if (!duplicate) {
        statements.push(env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time)
          VALUES(?1,'MESSAGE',?2,?3,'INBOUND',?4,?5,?6,?7)`).bind(message.id, phone, customerName, String(message.type || 'unknown'), body, JSON.stringify(message), String(message.timestamp || '')));
        statements.push(profileUpsert(env, phone, customerName, true));
        newMessages.push({ message: { ...message, from: phone }, body });
      }
    }
    for (const status of value.statuses || []) if (status.id && status.timestamp) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,direction,message_type,body,raw_json,event_time)
        VALUES(?1,'STATUS',?2,'SYSTEM',?3,?4,?5,?6)`).bind(`${status.id}:${status.status}:${status.timestamp}`, cleanPhone(status.recipient_id || ''), String(status.status || ''), status.errors ? JSON.stringify(status.errors) : null, JSON.stringify(status), String(status.timestamp)));
    }
  }
  if (statements.length) await env.DB.batch(statements.slice(0, 50));
  for (const incoming of newMessages.slice(0, 10)) await autoReplyWithCatalogue(env, request.url, incoming.message, incoming.body);
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
    message = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name: templateName, language: { code: cleanText(body.language, 'language', 20, false) || 'en_US' } } };
  } else {
    const content = cleanText(body.text, 'message', 4096);
    message = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: content } };
  }
  let result, messageId;
  try { ({ result, messageId } = await sendMetaMessage(env, to, message)); }
  catch (error) { return json({ error: String(error.message || error) }, 502); }
  const profile = await env.DB.prepare('SELECT COALESCE(shop_name,display_name) name FROM whatsapp_customers WHERE phone=?1').bind(to).first();
  await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time)
    VALUES(?1,'OUTBOUND',?2,?3,'OUTBOUND',?4,?5,?6,?7)`).bind(`out:${messageId}`, to, profile?.name || '', message.type, templateName || message.text.body, JSON.stringify(result), String(Math.floor(Date.now() / 1000))).run();
  return json({ accepted: true, message_id: messageId, to, type: message.type }, 201);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/health') return json({ ok: true, service: 'frostflow-online', version: '0.4.0' });
  if (path === '/webhooks/whatsapp' || path === '/webhooks/whatsapp/') return whatsappWebhook(request, env);
  if (path === '/api/catalog/orders' && request.method === 'POST') return createOrder(request, env, { publicCatalog: true });
  if (request.method === 'GET' && (path === '/catalog' || path === '/catalog/' || path === '/catalog.js' || path === '/catalog.css' || path === '/catalog-data.json' || path.startsWith('/images/'))) {
    if (path === '/catalog') return Response.redirect(new URL('/catalog/', request.url), 308);
    return env.ASSETS.fetch(request);
  }

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
    const rows = await env.DB.prepare('SELECT event_id,event_type,from_number,customer_name,direction,message_type,body,event_time,received_at,order_id FROM whatsapp_events ORDER BY received_at DESC LIMIT 200').all();
    return json({ events: rows.results || [] });
  }
  if (path === '/api/whatsapp/conversations' && request.method === 'GET') return whatsappConversations(env);
  if (path === '/api/whatsapp/templates' && request.method === 'GET') return whatsappTemplates(env);
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

export { equalSecret, cleanPhone, cleanGstin, cleanLocationUrl, catalogueReply, catalogueRequested, supportsWhatsAppWebhook };
