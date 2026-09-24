const encoder = new TextEncoder();

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self)',
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

function cleanStoredPhone(value) {
  try { return cleanPhone(value); }
  catch { return ''; }
}

function defaultWholesaleUnit(value) {
  return /(?:\bbulks?\b|\bcombos?\b|\b2\s*l(?:tr|itre|iter)?\b)/i.test(String(value || '')) ? 'PC' : 'BOX';
}

function cleanWholesaleUnit(value, fallback = 'BOX') {
  const unit = String(value || fallback).trim().toUpperCase();
  const normalized = unit === 'PCS' ? 'PC' : unit === 'BX' ? 'BOX' : unit;
  if (!['PC', 'BOX'].includes(normalized)) throw new Response('Order unit must be PC or BOX', { status: 400 });
  return normalized;
}

function baseOrderQuantity(requestedQuantity, unit, unitsPerBox) {
  const quantity = Number(requestedQuantity);
  const pack = Number(unitsPerBox);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) throw new Response('Quantity must be between 1 and 10,000', { status: 400 });
  if (!Number.isInteger(quantity)) throw new Response('Wholesale quantity must be a whole number', { status: 400 });
  if (unit === 'BOX' && (!Number.isInteger(pack) || pack < 1 || pack > 10000)) throw new Response('Invalid box pack size', { status: 400 });
  const result = quantity * (unit === 'BOX' ? pack : 1);
  if (result > 1000000) throw new Response('Total pieces must not exceed 1,000,000', { status: 400 });
  return result;
}

async function publicCatalogueProducts(request, env) {
  const response = await env.ASSETS.fetch(new Request(new URL('/catalog-data.json', request.url)));
  if (!response.ok) throw new Response('Catalogue pack sizes are temporarily unavailable', { status: 503 });
  const catalogue = await response.json();
  const products = new Map();
  for (const department of catalogue.departments || []) for (const category of department.categories || []) for (const group of category.groups || []) for (const product of group.products || []) {
    products.set(String(product.id || '').toUpperCase(), { unitsPerBox: Number(product.unitsPerBox || product.unitsPerCase || 0), defaultUnit: defaultWholesaleUnit(`${group.name} ${product.name} ${product.description}`) });
  }
  return products;
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

function cleanDate(value, name, required = false) {
  const result = String(value ?? '').trim();
  if (!result && required) throw new Response(`${name} is required`, { status: 400 });
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Response(`Invalid ${name}`, { status: 400 });
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
  const statement = env.DB.prepare(`SELECT product_id,sku,product_name,category,unit,stock_qty,reserved_qty,manual_out_of_stock,stock_note,
    CASE WHEN manual_out_of_stock=1 THEN 0 ELSE MAX(0,stock_qty-reserved_qty) END available_qty,mrp_paise,selling_price_paise,synced_at
    FROM inventory WHERE active=1 AND (?1='' OR product_name LIKE ?2 ESCAPE '\\' OR sku LIKE ?2 ESCAPE '\\')
    ORDER BY available_qty>0 DESC,product_name LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset);
  const [items, total, sync] = await Promise.all([
    statement.all(),
    env.DB.prepare("SELECT COUNT(*) count FROM inventory WHERE active=1 AND (?1='' OR product_name LIKE ?2 ESCAPE '\\' OR sku LIKE ?2 ESCAPE '\\')").bind(query, pattern).first(),
    env.DB.prepare("SELECT value,updated_at FROM sync_state WHERE key='current_snapshot'").first(),
  ]);
  return json({ items: items.results || [], total: total?.count || 0, sync: sync || null });
}

async function publicAvailability(env) {
  const sync = await env.DB.prepare("SELECT value,updated_at FROM sync_state WHERE key='current_snapshot'").first();
  if (!sync) return json({ ready: false, items: [], message: 'Live stock is waiting for the first Amul PC sync.' });
  const rows = await env.DB.prepare(`WITH available AS (
      SELECT product_id,UPPER(TRIM(sku)) sku,unit,stock_qty-reserved_qty available_qty,mrp_paise,selling_price_paise,
        ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(sku))
          ORDER BY selling_price_paise DESC,stock_qty-reserved_qty DESC,source_device<>'catalog-seed' DESC,product_id) price_rank
      FROM inventory WHERE active=1 AND manual_out_of_stock=0 AND TRIM(COALESCE(sku,''))<>'' AND stock_qty-reserved_qty>0 AND selling_price_paise>0
    ) SELECT product_id,sku,available_qty,mrp_paise,selling_price_paise,500 gst_bps,unit
    FROM available WHERE price_rank=1 ORDER BY sku`).all();
  return json({ ready: true, items: rows.results || [], gst_bps: 500, pricing: 'highest_retailer_price_before_gst', sync });
}

async function setInventoryAvailability(request, env, productId) {
  const body = await readObject(request, 20_000);
  if (typeof body.out_of_stock !== 'boolean') throw new Response('out_of_stock must be true or false', { status: 400 });
  const note = cleanText(body.note, 'note', 300, false);
  const result = await env.DB.prepare(`UPDATE inventory SET manual_out_of_stock=?1,stock_note=?2,stock_control_updated_at=CURRENT_TIMESTAMP
    WHERE product_id=?3 AND active=1`).bind(body.out_of_stock ? 1 : 0, note, productId).run();
  if (!result.meta?.changes) return json({ error: 'Product not found' }, 404);
  await env.DB.prepare(`INSERT INTO operations_audit(action,entity_type,entity_id,detail_json)
    VALUES('STOCK_VISIBILITY','INVENTORY',?1,?2)`).bind(productId, JSON.stringify({ out_of_stock: body.out_of_stock, note })).run();
  return json({ product_id: productId, manual_out_of_stock: body.out_of_stock ? 1 : 0, available_qty: 0 });
}

async function setInventoryQuantity(request, env, productId) {
  const body = await readObject(request, 20_000);
  const quantity = cleanNumber(body.stock_qty, 'stock_qty', 0);
  const unit = cleanText(body.unit, 'unit', 20, false);
  const note = cleanText(body.note, 'note', 300, false);
  const current = await env.DB.prepare('SELECT product_id,stock_qty,reserved_qty,unit FROM inventory WHERE product_id=?1 AND active=1').bind(productId).first();
  if (!current) return json({ error: 'Product not found' }, 404);
  if (quantity < Number(current.reserved_qty || 0)) return json({ error: `Stock cannot be below the ${current.reserved_qty} units already reserved for orders.` }, 409);
  await env.DB.batch([
    env.DB.prepare(`UPDATE inventory SET stock_qty=?1,unit=COALESCE(NULLIF(?2,''),unit),stock_note=?3,
      stock_control_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE product_id=?4`).bind(quantity, unit, note, productId),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('SET_STOCK','INVENTORY',?1,?2)")
      .bind(productId, JSON.stringify({ previous_quantity: Number(current.stock_qty), quantity, previous_unit: current.unit, unit: unit || current.unit, note })),
  ]);
  return json({ product_id: productId, stock_qty: quantity, reserved_qty: Number(current.reserved_qty || 0), available_qty: quantity - Number(current.reserved_qty || 0), unit: unit || current.unit });
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
    if(!productId.startsWith('AMUL:'))throw new Response('Sync accepts Amul products only; local and cloud records are protected.',{status:409});
    const productName = cleanText(item.product_name, 'product_name', 200);
    const stock = Number(item.stock_qty || 0);
    if (!Number.isFinite(stock) || stock < 0) throw new Response(`Invalid stock for ${productId}`, { status: 400 });
    const mrp = Math.max(0, Math.trunc(Number(item.mrp_paise || 0)));
    const selling = Math.max(0, Math.trunc(Number(item.selling_price_paise || 0)));
    return env.DB.prepare(`INSERT INTO inventory(product_id,sku,product_name,category,unit,stock_qty,mrp_paise,selling_price_paise,active,source_device,snapshot_id,source_updated_at,synced_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,CURRENT_TIMESTAMP)
      ON CONFLICT(product_id) DO UPDATE SET sku=excluded.sku,product_name=excluded.product_name,category=excluded.category,unit=excluded.unit,
      source_stock_qty=excluded.stock_qty,source_stock_seen_at=CURRENT_TIMESTAMP,
      snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP
      WHERE inventory.source_device<>'cloudflare-admin'`)
      .bind(productId, cleanText(item.sku, 'sku', 100, false), productName, cleanText(item.category, 'category', 100, false) || 'Other', cleanText(item.unit, 'unit', 20, false) || 'PCS', stock, mrp, selling, item.active === false ? 0 : 1, deviceId, snapshotId, cleanText(item.source_updated_at, 'source_updated_at', 40, false));
  });
  if (statements.length) await env.DB.batch(statements);

  if (body.complete) {
    const count = await env.DB.prepare('SELECT COUNT(*) count FROM inventory WHERE source_device=?1 AND snapshot_id=?2').bind(deviceId, snapshotId).first();
    await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) FROM inventory WHERE source_device=?1 AND snapshot_id<>?2').bind(deviceId, snapshotId),
      env.DB.prepare(`UPDATE inventory SET active=0 WHERE source_device='catalog-seed' AND sku IN
        (SELECT sku FROM inventory WHERE source_device=?1 AND snapshot_id=?2 AND active=1 AND sku<>'')`).bind(deviceId, snapshotId),
      env.DB.prepare('INSERT OR REPLACE INTO sync_runs(snapshot_id,device_id,captured_at,product_count,completed_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)').bind(snapshotId, deviceId, capturedAt, count?.count || 0),
      env.DB.prepare("INSERT INTO sync_state(key,value,updated_at) VALUES('current_snapshot',?1,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({ snapshot_id: snapshotId, device_id: deviceId, captured_at: capturedAt, product_count: count?.count || 0 })),
    ]);
    return json({ accepted: true, complete: true, product_count: count?.count || 0 });
  }
  return json({ accepted: true, complete: false, product_count: items.length });
}

// Amul-only route master fields (weekday flags, member count, full source row). Never edited in the cloud.
function routeSourceDetails(item) {
  return [
    cleanText(item.visit_days, 'visit_days', 60, false),
    cleanInteger(item.customer_count, 'customer_count'),
    cleanText(JSON.stringify(item.details && typeof item.details === 'object' ? item.details : {}), 'details', 8000, false),
  ];
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
    (id,source,source_id,code,name,active,visit_days,customer_count,details_json,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,active=excluded.active,source_device=excluded.source_device,
    snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.code, 'code', 80, false), cleanText(item.name, 'name', 150), item.active === false ? 0 : 1, ...routeSourceDetails(item), deviceId, snapshotId, updated);
  if (dataset === 'customer_routes') return env.DB.prepare(`INSERT INTO customer_routes
    (id,source,source_id,customer_id,route_id,active,source_device,snapshot_id,source_updated_at,synced_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,route_id=excluded.route_id,active=excluded.active,
    source_device=excluded.source_device,snapshot_id=excluded.snapshot_id,source_updated_at=excluded.source_updated_at,synced_at=CURRENT_TIMESTAMP`)
    .bind(id, source, sourceId, cleanText(item.customer_id, 'customer_id', 140), cleanText(item.route_id, 'route_id', 140), item.active === false ? 0 : 1, deviceId, snapshotId, updated);
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
  if (!['customers', 'routes', 'customer_routes', 'distribution_orders', 'invoices', 'payments'].includes(dataset)) throw new Response('Unsupported business dataset', { status: 400 });
  const deviceId = cleanText(body.device_id, 'device_id', 80);
  const snapshotId = cleanText(body.snapshot_id, 'snapshot_id', 100);
  const capturedAt = cleanText(body.captured_at, 'captured_at', 40);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > 40) throw new Response('Use at most 40 records per sync chunk', { status: 400 });
  if(items.some(item=>item.source!=='AMUL'||!String(item.id).startsWith('AMUL:')))throw new Response('Only Amul source records may be synced.',{status:409});
  if (body.complete && items.length) throw new Response('Send completion as an empty final chunk', { status: 400 });
  // Preserve all existing operational balances/edits. Existing upstream records need reconciliation, not replacement.
  // customer_routes is a pure Amul mapping with no cloud edits, so it is always upserted.
  const additions=[];
  const routeDetails=[];
  for(const item of items){
    const existing=dataset==='customer_routes'?null:await env.DB.prepare(`SELECT id FROM ${dataset} WHERE id=?1`).bind(item.id).first();
    if(!existing)additions.push(item);
    else if(dataset==='routes')routeDetails.push(env.DB.prepare('UPDATE routes SET visit_days=?1,customer_count=?2,details_json=?3 WHERE id=?4').bind(...routeSourceDetails(item),item.id));
  }
  const writes=[...additions.map((item) => businessStatement(env, dataset, item, deviceId, snapshotId)),...routeDetails];
  if (writes.length) await env.DB.batch(writes);
  if (body.complete) {
    const statements = [];
    // Retention window: hide (never hard-delete) Amul invoices dated before min_date.
    if (dataset === 'invoices' && body.prune === true) {
      const minDate = cleanDate(body.min_date, 'min_date', true);
      statements.push(env.DB.prepare(`UPDATE invoices SET deleted_at=CURRENT_TIMESTAMP WHERE source='AMUL' AND deleted_at IS NULL AND invoice_date<>'' AND invoice_date<?1`).bind(minDate));
    }
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
  if (!lines.length || lines.length > 200) throw new Response('Choose 1 to 200 products', { status: 400 });
  const existing = await env.DB.prepare('SELECT id,status,order_number,total_paise FROM orders WHERE request_id=?1').bind(requestId).first();
  if (existing) return json(existing, 200);
  const id = crypto.randomUUID();
  let customerId = cleanText(body.customer_id, 'customer_id', 140, false);
  let savedCustomer = customerId ? await env.DB.prepare('SELECT id,name,mobile,whatsapp_number,address,route_name FROM customers WHERE id=?1 AND active=1 AND deleted_at IS NULL').bind(customerId).first() : null;
  if (customerId && !savedCustomer) throw new Response('Selected customer is unavailable', { status: 400 });
  const phone = cleanPhone(body.phone || savedCustomer?.whatsapp_number || savedCustomer?.mobile);
  if (!customerId && phone) {
    const local = phone.slice(-10);
    savedCustomer = await env.DB.prepare(`SELECT id,name,mobile,whatsapp_number,address,route_name FROM customers
      WHERE active=1 AND deleted_at IS NULL AND (mobile IN (?1,?2) OR whatsapp_number IN (?1,?2)) ORDER BY source='AMUL' DESC LIMIT 1`).bind(phone, local).first();
    if (savedCustomer) customerId = savedCustomer.id;
  }
  if (options.publicCatalog && !phone) throw new Response('WhatsApp phone number is required', { status: 400 });
  const onlineProfile = phone ? await env.DB.prepare('SELECT * FROM whatsapp_customers WHERE phone=?1').bind(phone).first() : null;
  const customer = cleanText(body.shop_name || body.customer_name || onlineProfile?.shop_name || onlineProfile?.display_name || savedCustomer?.name, 'shop_name', 120);
  const contactName = cleanText(body.contact_name || onlineProfile?.contact_name, 'contact_name', 120, false);
  const address = cleanText(body.address || onlineProfile?.address || savedCustomer?.address, 'address', 400, !!options.publicCatalog);
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
  const customProducts = [];
  const hideCustomProducts = [];
  const catalogueProducts = options.publicCatalog ? await publicCatalogueProducts(request, env) : new Map();
  let subtotal = 0;
  let tax = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const requestedQuantity = Number(line.quantity);
    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0 || requestedQuantity > 10000) throw new Response('Quantity must be between 1 and 10,000', { status: 400 });
    if (line.custom === true) {
      if (options.publicCatalog) throw new Response('Custom products are available only in the protected order app', { status: 400 });
      const productName = cleanText(line.product_name, 'product_name', 200);
      const unit = cleanText(line.unit, 'unit', 20, false) || 'PCS';
      const price = cleanInteger(line.unit_price_paise, 'unit_price_paise');
      const productId = `CUSTOM:${id}:${index + 1}`;
      const lineSubtotal = Math.round(requestedQuantity * price);
      subtotal += lineSubtotal;
      customProducts.push(env.DB.prepare(`INSERT INTO inventory
        (product_id,sku,product_name,category,unit,stock_qty,reserved_qty,mrp_paise,selling_price_paise,active,source_device,snapshot_id,source_updated_at,synced_at)
        VALUES(?1,'',?2,'Custom',?3,?4,0,?5,?5,1,'manual-order',?6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
        .bind(productId, productName, unit, requestedQuantity, price, id));
      preparedLines.push(env.DB.prepare(`INSERT INTO order_lines
        (order_id,line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise,gst_bps,subtotal_paise,tax_paise,total_paise)
        VALUES(?1,?2,?3,?4,?5,?6,?5,?6,1,?7,0,?8,0,?8)`)
        .bind(id, index + 1, productId, productName, requestedQuantity, unit, price, lineSubtotal));
      hideCustomProducts.push(env.DB.prepare('UPDATE inventory SET active=0 WHERE product_id=?1').bind(productId));
      continue;
    }
    const requestedProductId = cleanText(line.product_id, 'product_id', 100);
    const prefixedProductId = requestedProductId.startsWith('AMUL:') ? requestedProductId : `AMUL:${requestedProductId}`;
    const catalogueId = requestedProductId.replace(/^AMUL:/i, '').toUpperCase();
    const catalogueProduct = catalogueProducts.get(catalogueId);
    if (options.publicCatalog && !catalogueProduct) throw new Response(`Catalogue pack size missing for ${requestedProductId}`, { status: 400 });
    const requestedUnit = options.publicCatalog ? cleanWholesaleUnit(line.unit, catalogueProduct.defaultUnit) : cleanText(line.unit, 'unit', 20, false);
    const unitsPerBox = options.publicCatalog ? catalogueProduct.unitsPerBox : 1;
    const quantity = options.publicCatalog ? baseOrderQuantity(requestedQuantity, requestedUnit, unitsPerBox) : requestedQuantity;
    const product = await env.DB.prepare(`SELECT product_id,product_name,unit,selling_price_paise
      FROM inventory WHERE active=1 AND (product_id=?1 OR product_id=?2 OR sku=?1) AND (?4=0 OR selling_price_paise>0)
      ORDER BY (manual_out_of_stock=0 AND stock_qty-reserved_qty>=?3) DESC,
        CASE WHEN ?4=1 THEN selling_price_paise ELSE 0 END DESC,
        source_device<>'catalog-seed' DESC,stock_qty-reserved_qty DESC LIMIT 1`)
      .bind(requestedProductId, prefixedProductId, quantity, options.publicCatalog ? 1 : 0).first();
    if (!product) throw new Response(`Unknown product ${requestedProductId}`, { status: 400 });
    const gstBps = options.publicCatalog ? 500 : 0;
    const amounts = orderEstimateLineAmounts(quantity, product.selling_price_paise || 0, gstBps);
    subtotal += amounts.subtotal_paise;
    tax += amounts.tax_paise;
    preparedLines.push(env.DB.prepare(`INSERT INTO order_lines
      (order_id,line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise,gst_bps,subtotal_paise,tax_paise,total_paise)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`)
      .bind(id, index + 1, product.product_id, product.product_name, quantity, product.unit, requestedQuantity, requestedUnit || product.unit, unitsPerBox, product.selling_price_paise || 0, gstBps, amounts.subtotal_paise, amounts.tax_paise, amounts.total_paise));
  }
  const total = subtotal + tax;
  const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  const source = options.source === 'WHATSAPP' ? 'WHATSAPP' : 'ONLINE';
  const orderNumber = `${source === 'WHATSAPP' ? 'WA' : 'WEB'}-${businessDate}-${id.slice(0, 6).toUpperCase()}`;
  const routeName = cleanText(body.route_name || onlineProfile?.route_name || savedCustomer?.route_name, 'route_name', 150, false);
  const statements = [env.DB.prepare(`INSERT INTO orders
    (id,request_id,source,customer_id,customer_name,phone,address,note,status,order_number,route_name,delivery_date,total_paise,workflow_status,updated_at,contact_name,gstin,location_url,location_lat,location_lng,subtotal_paise,tax_paise,gst_bps)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'NEW',?9,?10,?11,?12,'RECEIVED',CURRENT_TIMESTAMP,?13,?14,?15,?16,?17,?18,?19,?20)`)
    .bind(id, requestId, source, customerId || (phone ? `WHATSAPP:${phone}` : null), customer, phone, address, cleanText(body.note, 'note', 400, false), orderNumber, routeName, deliveryDate, total, contactName, gstin, locationUrl, latitude, longitude, subtotal, tax, options.publicCatalog ? 500 : 0), ...customProducts, ...preparedLines];
  if (phone) statements.push(env.DB.prepare(`INSERT INTO whatsapp_customers
    (phone,display_name,shop_name,contact_name,gstin,address,location_url,location_lat,location_lng,last_order_id,last_order_at,route_name,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,CURRENT_TIMESTAMP,?11,CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      display_name=COALESCE(NULLIF(excluded.display_name,''),whatsapp_customers.display_name),
      shop_name=COALESCE(NULLIF(excluded.shop_name,''),whatsapp_customers.shop_name),
      contact_name=COALESCE(NULLIF(excluded.contact_name,''),whatsapp_customers.contact_name),
      gstin=COALESCE(NULLIF(excluded.gstin,''),whatsapp_customers.gstin),
      address=COALESCE(NULLIF(excluded.address,''),whatsapp_customers.address),
      location_url=COALESCE(NULLIF(excluded.location_url,''),whatsapp_customers.location_url),
      location_lat=COALESCE(excluded.location_lat,whatsapp_customers.location_lat),
      location_lng=COALESCE(excluded.location_lng,whatsapp_customers.location_lng),
      route_name=COALESCE(NULLIF(excluded.route_name,''),whatsapp_customers.route_name),
      last_order_id=excluded.last_order_id,last_order_at=CURRENT_TIMESTAMP,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP`)
    .bind(phone, contactName || customer, customer, contactName, gstin, address, locationUrl, latitude, longitude, id, routeName));
  statements.push(...hideCustomProducts);
  try { await env.DB.batch(statements); } catch (error) {
    if (String(error).includes('INSUFFICIENT_STOCK')) throw new Response('Insufficient available stock', { status: 409 });
    throw error;
  }
  return json({ id, request_id: requestId, order_number: orderNumber, status: 'NEW', workflow_status: 'RECEIVED', subtotal_paise: subtotal, tax_paise: tax, total_paise: total, gst_bps: options.publicCatalog ? 500 : 0, delivery_date: deliveryDate }, 201);
}

async function listOrders(env, syncOnly = false) {
  const where = syncOnly ? "WHERE status='NEW'" : '';
  const orders = (await env.DB.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 200`).all()).results || [];
  for (const order of orders) order.lines = (await env.DB.prepare('SELECT line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise,gst_bps,subtotal_paise,tax_paise,total_paise,picked_qty,crated_qty FROM order_lines WHERE order_id=?1 ORDER BY line_no').bind(order.id).all()).results || [];
  return orders;
}

async function updatePickedLine(request, env, id) {
  const body = await readObject(request, 20_000);
  const lineNo = cleanInteger(body.line_no, 'line_no', 1);
  const pickedQty = cleanNumber(body.picked_qty, 'picked_qty', 0);
  const order = await env.DB.prepare("SELECT id,status FROM orders WHERE id=?1 AND status IN ('NEW','SYNCED')").bind(id).first();
  if (!order) return json({ error: 'Open order not found' }, 404);
  const line = await env.DB.prepare('SELECT quantity FROM order_lines WHERE order_id=?1 AND line_no=?2').bind(id, lineNo).first();
  if (!line) return json({ error: 'Order line not found' }, 404);
  if (pickedQty > Number(line.quantity)) return json({ error: 'Picked quantity cannot exceed ordered quantity' }, 400);
  await env.DB.batch([
    env.DB.prepare('UPDATE order_lines SET picked_qty=?1,crated_qty=MIN(crated_qty,?1) WHERE order_id=?2 AND line_no=?3').bind(pickedQty, id, lineNo),
    env.DB.prepare("UPDATE orders SET workflow_status='PICKING',picking_started_at=COALESCE(picking_started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('PICK','ORDER',?1,?2)").bind(id, JSON.stringify({ line_no: lineNo, picked_qty: pickedQty })),
  ]);
  return json({ id, line_no: lineNo, picked_qty: pickedQty, workflow_status: 'PICKING' });
}

async function crateOrder(request, env, id) {
  const body = await readObject(request, 20_000);
  const crateCode = cleanText(body.crate_code, 'crate_code', 40);
  const order = await env.DB.prepare("SELECT id FROM orders WHERE id=?1 AND status IN ('NEW','SYNCED')").bind(id).first();
  if (!order) return json({ error: 'Open order not found' }, 404);
  const incomplete = await env.DB.prepare('SELECT COUNT(*) count FROM order_lines WHERE order_id=?1 AND picked_qty<>quantity').bind(id).first();
  if (Number(incomplete?.count || 0)) return json({ error: 'Pick every ordered quantity before adding the order to a crate' }, 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE order_lines SET crated_qty=picked_qty WHERE order_id=?1').bind(id),
    env.DB.prepare("UPDATE orders SET crate_code=?1,workflow_status='PACKED',packed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?2").bind(crateCode, id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('CRATE','ORDER',?1,?2)").bind(id, JSON.stringify({ crate_code: crateCode })),
  ]);
  return json({ id, crate_code: crateCode, workflow_status: 'PACKED' });
}

async function queueInvoice(env, id) {
  const existing = await env.DB.prepare('SELECT * FROM invoice_jobs WHERE order_id=?1').bind(id).first();
  if (existing) {
    if (existing.status === 'FAILED') {
      await env.DB.batch([
        env.DB.prepare("UPDATE invoice_jobs SET status='PENDING',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(existing.id),
        env.DB.prepare("UPDATE orders SET workflow_status='INVOICE_QUEUED',updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(id),
      ]);
      return json({ ...existing, status: 'PENDING', last_error: null }, 200);
    }
    return json(existing, 200);
  }
  const order = await env.DB.prepare(`SELECT o.*,c.source customer_source,c.source_id customer_source_id,c.gstin customer_gstin
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?1 AND o.status IN ('NEW','SYNCED')`).bind(id).first();
  if (!order) return json({ error: 'Open order not found' }, 404);
  if (!order.crate_code || order.workflow_status !== 'PACKED') return json({ error: 'Add the completely picked order to a crate before making the invoice' }, 409);
  const lines = (await env.DB.prepare('SELECT line_no,product_id,product_name,quantity,unit,price_paise,picked_qty,crated_qty FROM order_lines WHERE order_id=?1 ORDER BY line_no').bind(id).all()).results || [];
  if (!lines.length || lines.some(line => Number(line.crated_qty) !== Number(line.quantity))) return json({ error: 'Every ordered item must be in the crate' }, 409);
  const jobId = crypto.randomUUID();
  const payload = { order: { ...order }, lines, requested_at: new Date().toISOString(), target: 'AMUL_SQL' };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO invoice_jobs(id,order_id,status,payload_json) VALUES(?1,?2,'PENDING',?3)`).bind(jobId, id, JSON.stringify(payload)),
    env.DB.prepare("UPDATE orders SET invoice_job_id=?1,workflow_status='INVOICE_QUEUED',updated_at=CURRENT_TIMESTAMP WHERE id=?2").bind(jobId, id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('QUEUE_INVOICE','ORDER',?1,?2)").bind(id, JSON.stringify({ job_id: jobId, target: 'AMUL_SQL' })),
  ]);
  return json({ id: jobId, order_id: id, status: 'PENDING' }, 201);
}

async function listInvoiceJobs(env) {
  const rows = await env.DB.prepare("SELECT id,order_id,status,payload_json,attempt_count,created_at,updated_at FROM invoice_jobs WHERE status IN ('PENDING','FAILED') ORDER BY created_at LIMIT 20").all();
  return json({ jobs: rows.results || [] });
}

async function finishInvoiceJob(request, env, jobId) {
  const body = await readObject(request, 30_000);
  const job = await env.DB.prepare('SELECT * FROM invoice_jobs WHERE id=?1').bind(jobId).first();
  if (!job) return json({ error: 'Invoice job not found' }, 404);
  const success = body.success === true;
  const invoiceNumber = cleanText(body.invoice_number, 'invoice_number', 100, false);
  const externalId = cleanText(body.external_invoice_id, 'external_invoice_id', 100, false);
  const error = cleanText(body.error, 'error', 800, false);
  if (success && (!invoiceNumber || !externalId)) return json({ error: 'Successful invoice result requires invoice number and external id' }, 400);
  await env.DB.batch([
    env.DB.prepare(`UPDATE invoice_jobs SET status=?1,attempt_count=attempt_count+1,completed_at=CASE WHEN ?1='POSTED' THEN CURRENT_TIMESTAMP ELSE completed_at END,
      external_invoice_id=?2,invoice_number=?3,last_error=?4,updated_at=CURRENT_TIMESTAMP WHERE id=?5`).bind(success ? 'POSTED' : 'FAILED', externalId, invoiceNumber, error, jobId),
    env.DB.prepare(`UPDATE orders SET workflow_status=?1,invoice_number=CASE WHEN ?1='INVOICED' THEN ?2 ELSE invoice_number END,
      status=CASE WHEN ?1='INVOICED' THEN 'FULFILLED' ELSE status END,completed_at=CASE WHEN ?1='INVOICED' THEN CURRENT_TIMESTAMP ELSE completed_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?3`)
      .bind(success ? 'INVOICED' : 'INVOICE_FAILED', invoiceNumber, job.order_id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('INVOICE_RESULT','INVOICE_JOB',?1,?2)").bind(jobId, JSON.stringify({ success, invoice_number: invoiceNumber, external_invoice_id: externalId, error })),
  ]);
  return json({ id: jobId, status: success ? 'POSTED' : 'FAILED', invoice_number: invoiceNumber });
}

async function purchaseTopups(env) {
  const rows = await env.DB.prepare(`SELECT t.*,i.sku,i.product_name,i.unit FROM purchase_topups t JOIN inventory i ON i.product_id=t.product_id
    WHERE t.status='ACTIVE' ORDER BY t.created_at DESC`).all();
  return json({ topups: rows.results || [] });
}

async function createPurchaseTopup(request, env) {
  const body = await readObject(request, 20_000);
  const productId = cleanText(body.product_id, 'product_id', 100);
  const quantity = cleanNumber(body.quantity, 'quantity', 0.000001);
  const product = await env.DB.prepare('SELECT product_id FROM inventory WHERE product_id=?1 AND active=1').bind(productId).first();
  if (!product) return json({ error: 'Product not found' }, 404);
  const id = crypto.randomUUID();
  const reference = cleanText(body.reference, 'reference', 100, false);
  const note = cleanText(body.note, 'note', 300, false);
  await env.DB.batch([
    env.DB.prepare("UPDATE purchase_topups SET status='SUPERSEDED',updated_at=CURRENT_TIMESTAMP WHERE product_id=?1 AND status='ACTIVE'").bind(productId),
    env.DB.prepare("INSERT INTO purchase_topups(id,product_id,requested_qty,reference,note,status) VALUES(?1,?2,?3,?4,?5,'ACTIVE')").bind(id, productId, quantity, reference, note),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('TOPUP','INVENTORY',?1,?2)").bind(productId, JSON.stringify({ id, quantity, reference, note })),
  ]);
  return json({ id, product_id: productId, requested_qty: quantity, status: 'ACTIVE' }, 201);
}

async function updateOrder(request, env, id, action) {
  const workflow = { confirm: 'CONFIRMED', pack: 'PACKING', dispatch: 'OUT_FOR_DELIVERY', deliver: 'DELIVERED', fulfil: 'DELIVERED', cancel: 'CANCELLED', ack: null }[action];
  if (workflow === undefined) return json({ error: 'Unknown action' }, 404);
  const order = await env.DB.prepare('SELECT id,order_number,customer_name,phone,delivery_date,status,workflow_status FROM orders WHERE id=?1').bind(id).first();
  if (!order) return json({ error: 'Order not found' }, 404);
  const currentWorkflow = String(order.workflow_status || 'RECEIVED');
  if (action === 'confirm' && currentWorkflow !== 'RECEIVED') return json({ error: 'Only a received order can start picking.' }, 409);
  if (action === 'dispatch' && currentWorkflow !== 'INVOICED') return json({ error: 'Create the invoice before dispatching this order.' }, 409);
  if (['deliver', 'fulfil'].includes(action) && currentWorkflow !== 'OUT_FOR_DELIVERY') return json({ error: 'Dispatch the order before marking it delivered.' }, 409);
  if (action === 'cancel' && ['INVOICED','OUT_FOR_DELIVERY','DELIVERED'].includes(currentWorkflow)) return json({ error: 'An invoiced or dispatched order cannot be cancelled.' }, 409);
  const target = action === 'cancel' ? 'CANCELLED' : ['deliver', 'fulfil'].includes(action) ? 'FULFILLED' : action === 'ack' ? 'SYNCED' : null;
  const allowed = action === 'ack' ? "status='NEW'" : "status IN ('NEW','SYNCED')";
  const result = await env.DB.prepare(`UPDATE orders SET
    status=COALESCE(?1,status),workflow_status=COALESCE(?2,workflow_status),updated_at=CURRENT_TIMESTAMP,
    synced_at=CASE WHEN ?1='SYNCED' THEN CURRENT_TIMESTAMP ELSE synced_at END,
    completed_at=CASE WHEN ?1 IN ('FULFILLED','CANCELLED') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id=?3 AND ${allowed}`).bind(target, workflow, id).run();
  if (!result.meta?.changes) return json({ error: 'Order not found or already completed' }, 409);
  let notification = null;
  if (['dispatch','deliver'].includes(action) && order.phone) {
    const statusText = action==='dispatch' ? 'Out for delivery' : 'Delivered';
    try {
      const templates = await fetchWhatsAppTemplates(env);
      const template = templates.find(item=>item.name==='order_delivery_update'&&item.status==='APPROVED');
      if(!template)throw new Error('Approved order_delivery_update template is unavailable');
      const parameters=[order.customer_name||'Customer',order.order_number||id,statusText,order.delivery_date||'As scheduled'];
      const sent=await sendMetaMessage(env,order.phone,approvedTemplateMessage(order.phone,'order_delivery_update',template.language||'en_US',parameters));
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time,order_id)
        VALUES(?1,'DELIVERY_UPDATE',?2,?3,'OUTBOUND','template',?4,?5,?6,?7)`).bind(`delivery:${sent.messageId}`,order.phone,order.customer_name,statusText,JSON.stringify(sent.result),String(Math.floor(Date.now()/1000)),id).run();
      notification={sent:true,message_id:sent.messageId,status:statusText};
    } catch(error) {
      const message=(error instanceof Response ? await error.text() : String(error.message||error)).slice(0,500);
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time,order_id)
        VALUES(?1,'DELIVERY_UPDATE_FAILED',?2,?3,'SYSTEM','template',?4,?5,?6,?7)`).bind(`delivery-failed:${id}:${action}:${Date.now()}`,order.phone,order.customer_name,statusText,JSON.stringify({error:message}),String(Math.floor(Date.now()/1000)),id).run();
      notification={sent:false,error:message,status:statusText};
    }
  }
  return json({ id, status: target, workflow_status: workflow, notification });
}

async function dashboard(env) {
  const [inventorySummary, orderSummary, accountSummary, customerSummary, whatsappCustomerSummary, syncRows] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) products,COALESCE(SUM(stock_qty),0) stock_units,COALESCE(SUM(reserved_qty),0) reserved_units,COALESCE(SUM(CASE WHEN manual_out_of_stock=1 OR stock_qty-reserved_qty<=0 THEN 1 ELSE 0 END),0) out_of_stock FROM inventory WHERE active=1').first(),
    env.DB.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status IN ('NEW','SYNCED') THEN 1 ELSE 0 END),0) open_orders,COALESCE(SUM(CASE WHEN date(created_at)=date('now') THEN total_paise ELSE 0 END),0) today_value_paise FROM orders").first(),
    env.DB.prepare("SELECT COALESCE(SUM(outstanding_paise),0) receivable_paise,COALESCE(SUM(CASE WHEN due_date<>'' AND date(due_date)<date('now') AND outstanding_paise>0 THEN outstanding_paise ELSE 0 END),0) overdue_paise,COALESCE(SUM(CASE WHEN substr(invoice_date,1,7)=substr(date('now'),1,7) THEN total_paise ELSE 0 END),0) month_sales_paise FROM invoices WHERE status<>'VOID' AND deleted_at IS NULL").first(),
    env.DB.prepare('SELECT COUNT(*) customers FROM customers WHERE active=1 AND deleted_at IS NULL').first(),
    env.DB.prepare('SELECT COUNT(*) customers FROM whatsapp_customers WHERE deleted_at IS NULL').first(),
    env.DB.prepare("SELECT key,value,updated_at FROM sync_state WHERE key='current_snapshot' OR key LIKE 'business:%' ORDER BY key").all(),
  ]);
  return json({ inventory: inventorySummary, orders: orderSummary, accounts: accountSummary, customers: { customers: Number(customerSummary?.customers || 0) + Number(whatsappCustomerSummary?.customers || 0) }, sync: syncRows.results || [] });
}

async function reconciliation(env) {
  const [duplicateSummary, stockSummary, invoiceSummary, customerSummary, archiveSummary, duplicateSkus, stockDifferences, invoicesMissingLines, duplicatePhones] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) groups_count,COALESCE(SUM(records),0) records_count FROM (
      SELECT COUNT(*) records FROM inventory
      WHERE active=1 AND TRIM(COALESCE(sku,''))<>''
      GROUP BY UPPER(TRIM(sku)) HAVING COUNT(*)>1
    )`).first(),
    env.DB.prepare(`SELECT COUNT(*) differences,COALESCE(SUM(ABS(stock_qty-source_stock_qty)),0) units_difference
      FROM inventory WHERE source_stock_qty IS NOT NULL AND ABS(stock_qty-source_stock_qty)>0.0001`).first(),
    env.DB.prepare(`SELECT COUNT(*) missing_lines FROM invoices i
      WHERE i.status<>'VOID' AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM invoice_lines l WHERE l.invoice_id=i.id)`).first(),
    env.DB.prepare(`SELECT COUNT(*) groups_count FROM (
      SELECT COALESCE(NULLIF(whatsapp_number,''),NULLIF(mobile,'')) phone FROM customers
      WHERE active=1 AND deleted_at IS NULL AND COALESCE(NULLIF(whatsapp_number,''),NULLIF(mobile,'')) IS NOT NULL
      GROUP BY phone HAVING COUNT(*)>1
    )`).first(),
    env.DB.prepare('SELECT COUNT(*) archived_rows,COUNT(DISTINCT source_table) archived_tables FROM local_migration_archive').first(),
    env.DB.prepare(`SELECT UPPER(TRIM(sku)) sku,COUNT(*) records,GROUP_CONCAT(DISTINCT source_device) sources,
      GROUP_CONCAT(product_name,' · ') product_names
      FROM inventory WHERE active=1 AND TRIM(COALESCE(sku,''))<>''
      GROUP BY UPPER(TRIM(sku)) HAVING COUNT(*)>1 ORDER BY records DESC,sku LIMIT 12`).all(),
    env.DB.prepare(`SELECT product_id,sku,product_name,unit,stock_qty,source_stock_qty,
      ROUND(stock_qty-source_stock_qty,2) difference,source_stock_seen_at
      FROM inventory WHERE source_stock_qty IS NOT NULL AND ABS(stock_qty-source_stock_qty)>0.0001
      ORDER BY ABS(stock_qty-source_stock_qty) DESC,product_name LIMIT 12`).all(),
    env.DB.prepare(`SELECT i.id,i.invoice_number,i.source,i.customer_name,i.invoice_date,i.total_paise
      FROM invoices i WHERE i.status<>'VOID' AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM invoice_lines l WHERE l.invoice_id=i.id)
      ORDER BY i.invoice_date DESC,i.id DESC LIMIT 12`).all(),
    env.DB.prepare(`SELECT COALESCE(NULLIF(whatsapp_number,''),NULLIF(mobile,'')) phone,COUNT(*) records,
      GROUP_CONCAT(name,' · ') customer_names
      FROM customers WHERE active=1 AND deleted_at IS NULL AND COALESCE(NULLIF(whatsapp_number,''),NULLIF(mobile,'')) IS NOT NULL
      GROUP BY phone HAVING COUNT(*)>1 ORDER BY records DESC,phone LIMIT 12`).all(),
  ]);
  return json({
    summary: {
      duplicate_sku_groups: Number(duplicateSummary?.groups_count || 0),
      duplicate_product_records: Number(duplicateSummary?.records_count || 0),
      stock_differences: Number(stockSummary?.differences || 0),
      stock_units_difference: Number(stockSummary?.units_difference || 0),
      invoices_missing_lines: Number(invoiceSummary?.missing_lines || 0),
      duplicate_phone_groups: Number(customerSummary?.groups_count || 0),
      archived_rows: Number(archiveSummary?.archived_rows || 0),
      archived_tables: Number(archiveSummary?.archived_tables || 0),
    },
    duplicate_skus: duplicateSkus.results || [],
    stock_differences: stockDifferences.results || [],
    invoices_missing_lines: invoicesMissingLines.results || [],
    duplicate_phones: duplicatePhones.results || [],
    generated_at: new Date().toISOString(),
    read_only: true,
  });
}

function pageParams(request) {
  const url = new URL(request.url);
  return { query: String(url.searchParams.get('q') || '').trim().slice(0, 80), limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100))), offset: Math.max(0, Number(url.searchParams.get('offset') || 0)) };
}

function routeDisplayName(name, aliases) {
  const source = String(name || '').trim();
  return aliases.get(source.toLocaleLowerCase()) || source || 'Unassigned route';
}

async function routes(env) {
  const [routeRows, customerRows, onlineRows, aliasRows] = await Promise.all([
    env.DB.prepare('SELECT id,source,code,name FROM routes WHERE active=1 ORDER BY name').all(),
    env.DB.prepare(`SELECT id,mobile,whatsapp_number,TRIM(COALESCE(route_name,'')) name FROM customers
      WHERE active=1 AND deleted_at IS NULL`).all(),
    env.DB.prepare(`SELECT phone,TRIM(COALESCE(route_name,'')) name FROM whatsapp_customers
      WHERE deleted_at IS NULL`).all(),
    env.DB.prepare('SELECT source_name,display_name FROM route_aliases').all(),
  ]);
  const aliases = new Map((aliasRows.results || []).map(row => [String(row.source_name || '').trim().toLocaleLowerCase(), row.display_name]));
  const result = new Map();
  const add = (rawName, count = 0, source = 'CUSTOMER') => {
    const name = routeDisplayName(rawName, aliases);
    const key = name.toLocaleLowerCase();
    const current = result.get(key) || { name, customer_count: 0, sources: new Set() };
    current.customer_count += Number(count || 0);
    current.sources.add(source);
    result.set(key, current);
  };
  for (const row of routeRows.results || []) add(row.name, 0, row.source);
  const knownPhones = new Set();
  for (const row of customerRows.results || []) {
    add(row.name, 1);
    for (const value of [row.mobile, row.whatsapp_number]) { const phone = cleanStoredPhone(value); if (phone) knownPhones.add(phone); }
  }
  for (const row of onlineRows.results || []) if (!knownPhones.has(cleanStoredPhone(row.phone))) add(row.name, 1, 'WHATSAPP');
  return json({ routes: [...result.values()].map(row => ({ ...row, sources: [...row.sources] })).sort((a, b) => a.name === 'Unassigned route' ? 1 : b.name === 'Unassigned route' ? -1 : a.name.localeCompare(b.name)) });
}

async function createRoute(request, env) {
  const body = await readObject(request, 10_000);
  const name = cleanText(body.name, 'route name', 150);
  if (name.toLocaleLowerCase() === 'unassigned route') return json({ error: 'Use a specific route name.' }, 400);
  const duplicate = await env.DB.prepare(`SELECT id FROM routes WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?1)) LIMIT 1`).bind(name).first();
  if (duplicate) return json({ error: 'This route already exists.' }, 409);
  const sourceId = crypto.randomUUID();
  const id = `CLOUD:${sourceId}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO routes(id,source,source_id,code,name,active,source_device,snapshot_id,source_updated_at,synced_at)
      VALUES(?1,'LOCAL',?2,?3,?4,1,'cloudflare-admin',?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(id, sourceId, `WEB-${sourceId.slice(0, 6).toUpperCase()}`, name),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('CREATE_ROUTE','ROUTE',?1,?2)").bind(id, JSON.stringify({ name })),
  ]);
  return json({ id, name, customer_count: 0, sources: ['LOCAL'] }, 201);
}

async function updateRoute(request, env) {
  const body = await readObject(request, 20_000);
  const oldName = cleanText(body.old_name, 'current route name', 150);
  const name = cleanText(body.name, 'route name', 150);
  if (name.toLocaleLowerCase() === 'unassigned route') return json({ error: 'Use a specific route name.' }, 400);
  if (oldName.toLocaleLowerCase() === name.toLocaleLowerCase()) return json({ name, updated: 0 });
  const aliasRows = await env.DB.prepare('SELECT source_name FROM route_aliases WHERE LOWER(display_name)=LOWER(?1)').bind(oldName).all();
  const sourceNames = new Set([oldName, ...(aliasRows.results || []).map(row => row.source_name)]);
  if (oldName === 'Unassigned route') sourceNames.add('');
  const statements = [];
  for (const sourceName of sourceNames) {
    statements.push(
      env.DB.prepare(`UPDATE customers SET route_name=?1,source_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP
        WHERE deleted_at IS NULL AND LOWER(TRIM(COALESCE(route_name,'')))=LOWER(TRIM(?2))`).bind(name, sourceName),
      env.DB.prepare(`UPDATE whatsapp_customers SET route_name=?1,updated_at=CURRENT_TIMESTAMP
        WHERE deleted_at IS NULL AND LOWER(TRIM(COALESCE(route_name,'')))=LOWER(TRIM(?2))`).bind(name, sourceName),
      env.DB.prepare(`UPDATE routes SET name=?1,source_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP
        WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?2))`).bind(name, sourceName),
      env.DB.prepare(`INSERT INTO route_aliases(source_name,display_name,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
        ON CONFLICT(source_name) DO UPDATE SET display_name=excluded.display_name,updated_at=CURRENT_TIMESTAMP`).bind(sourceName, name),
    );
  }
  statements.push(
    env.DB.prepare('UPDATE route_aliases SET display_name=?1,updated_at=CURRENT_TIMESTAMP WHERE LOWER(display_name)=LOWER(?2)').bind(name, oldName),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('RENAME_ROUTE','ROUTE',?1,?2)").bind(oldName, JSON.stringify({ old_name: oldName, name })),
  );
  await env.DB.batch(statements);
  return json({ old_name: oldName, name, updated: sourceNames.size });
}

async function customers(request, env) {
  const { query, limit, offset } = pageParams(request);
  const [rows, onlineRows, aliasRows] = await Promise.all([
    env.DB.prepare(`SELECT c.*,
      c.balance_paise+COALESCE((SELECT SUM(i.outstanding_paise) FROM invoices i
        WHERE i.customer_id=c.id AND i.source_device='cloudflare-admin' AND i.status<>'VOID' AND i.deleted_at IS NULL),0) display_balance_paise
      FROM customers c WHERE c.active=1 AND c.deleted_at IS NULL
      ORDER BY CASE WHEN TRIM(COALESCE(c.route_name,''))='' THEN 1 ELSE 0 END,c.route_name,c.name LIMIT 500`).all(),
    env.DB.prepare(`SELECT w.*,COALESCE((SELECT SUM(i.outstanding_paise) FROM invoices i
      WHERE i.customer_id='WHATSAPP:' || w.phone AND i.source_device='cloudflare-admin' AND i.status<>'VOID' AND i.deleted_at IS NULL),0) display_balance_paise
      FROM whatsapp_customers w WHERE w.deleted_at IS NULL
      ORDER BY COALESCE(shop_name,display_name,phone) LIMIT 500`).all(),
    env.DB.prepare('SELECT source_name,display_name FROM route_aliases').all(),
  ]);
  const aliases = new Map((aliasRows.results || []).map(row => [String(row.source_name || '').trim().toLocaleLowerCase(), row.display_name]));
  const result = (rows.results || []).map(row => ({ ...row, route_name: routeDisplayName(row.route_name, aliases), balance_paise: Number(row.display_balance_paise ?? row.balance_paise ?? 0), display_balance_paise: undefined }));
  // Imported FrostFlow records can contain old placeholders or incomplete phone
  // values. They must remain visible for correction instead of breaking the
  // complete customer directory. New and edited phone values still use the
  // strict cleanPhone validator.
  const knownPhones = new Set(result.flatMap(row => [row.mobile, row.whatsapp_number]).map(cleanStoredPhone).filter(Boolean));
  for (const profile of onlineRows.results || []) if (!knownPhones.has(profile.phone)) result.push({
    id: `WHATSAPP:${profile.phone}`, source: 'WHATSAPP', source_id: profile.phone, code: 'ONLINE',
    name: profile.shop_name || profile.display_name || profile.phone, mobile: profile.phone, whatsapp_number: profile.phone,
    gstin: profile.gstin || '', address: profile.address || '', city: profile.city || '', route_id: '', route_name: routeDisplayName(profile.route_name, aliases), credit_days: Number(profile.credit_days || 0),
    credit_limit_paise: 0, balance_paise: Number(profile.display_balance_paise || 0), active: 1, location_url: profile.location_url || '', last_order_at: profile.last_order_at,
  });
  const term = query.toLocaleLowerCase();
  const filtered = term ? result.filter(row => [row.name, row.code, row.mobile, row.whatsapp_number, row.route_name, row.gstin, row.city].some(value => String(value || '').toLocaleLowerCase().includes(term))) : result;
  filtered.sort((a,b)=>String(a.route_name||'ZZZ Unassigned').localeCompare(String(b.route_name||'ZZZ Unassigned'))||String(a.name||'').localeCompare(String(b.name||'')));
  return json({ customers: filtered.slice(offset, offset + limit), total: filtered.length });
}

async function createCustomer(request, env) {
  const body = await readObject(request, 30_000);
  const name = cleanText(body.name, 'name', 200);
  const phone = cleanPhone(body.whatsapp_number || body.mobile);
  const gstin = cleanGstin(body.gstin);
  const address = cleanText(body.address, 'address', 500, false);
  const city = cleanText(body.city, 'city', 100, false);
  const routeName = cleanText(body.route_name, 'route_name', 150, false);
  const creditDays = cleanInteger(body.credit_days, 'credit_days');
  if (creditDays > 365) throw new Response('credit_days is too large', { status: 400 });
  if (phone) {
    const local = phone.slice(-10);
    const duplicate = await env.DB.prepare(`SELECT id,name FROM customers WHERE active=1 AND deleted_at IS NULL AND (mobile IN (?1,?2) OR whatsapp_number IN (?1,?2)) LIMIT 1`).bind(phone, local).first();
    if (duplicate) return json({ error: `This number already belongs to ${duplicate.name}.`, customer_id: duplicate.id }, 409);
  }
  const sourceId = crypto.randomUUID();
  const id = `CLOUD:${sourceId}`;
  const code = cleanText(body.code, 'code', 80, false) || `WEB-${sourceId.slice(0, 6).toUpperCase()}`;
  const statements = [
    env.DB.prepare(`INSERT INTO customers
      (id,source,source_id,code,name,mobile,whatsapp_number,gstin,address,city,route_id,route_name,credit_days,credit_limit_paise,balance_paise,active,source_device,snapshot_id,source_updated_at,synced_at)
      VALUES(?1,'LOCAL',?2,?3,?4,?5,?5,?6,?7,?8,'',?9,?10,0,0,1,'cloudflare-admin',?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .bind(id, sourceId, code, name, phone, gstin, address, city, routeName, creditDays),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('CREATE_CUSTOMER','CUSTOMER',?1,?2)")
      .bind(id, JSON.stringify({ name, phone, gstin, route_name: routeName })),
  ];
  if (phone) statements.push(env.DB.prepare(`INSERT INTO whatsapp_customers(phone,display_name,shop_name,gstin,address,city,route_name,credit_days,updated_at)
    VALUES(?1,?2,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET shop_name=excluded.shop_name,gstin=COALESCE(NULLIF(excluded.gstin,''),whatsapp_customers.gstin),
      address=COALESCE(NULLIF(excluded.address,''),whatsapp_customers.address),city=COALESCE(NULLIF(excluded.city,''),whatsapp_customers.city),
      route_name=COALESCE(NULLIF(excluded.route_name,''),whatsapp_customers.route_name),credit_days=excluded.credit_days,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP`).bind(phone, name, gstin, address, city, routeName, creditDays));
  await env.DB.batch(statements);
  return json({ id, code, name, mobile: phone, whatsapp_number: phone, gstin, address, city, route_name: routeName, credit_days: creditDays, balance_paise: 0, source: 'LOCAL' }, 201);
}

async function updateCustomer(request, env, id) {
  if (id.startsWith('WHATSAPP:')) {
    const existingPhone = cleanPhone(id.slice('WHATSAPP:'.length));
    const current = await env.DB.prepare('SELECT * FROM whatsapp_customers WHERE phone=?1 AND deleted_at IS NULL').bind(existingPhone).first();
    if (!current) return json({ error: 'Customer not found' }, 404);
    const body = await readObject(request, 30_000);
    const name = cleanText(body.name ?? current.shop_name ?? current.display_name, 'name', 200);
    const phone = cleanPhone(body.whatsapp_number ?? body.mobile ?? existingPhone);
    const gstin = cleanGstin(body.gstin ?? current.gstin);
    const address = cleanText(body.address ?? current.address, 'address', 500, false);
    const city = cleanText(body.city ?? current.city, 'city', 100, false);
    const routeName = cleanText(body.route_name ?? current.route_name, 'route_name', 150, false);
    const creditDays = cleanInteger(body.credit_days ?? current.credit_days, 'credit_days');
    if (creditDays > 365) throw new Response('credit_days is too large', { status: 400 });
    if (phone !== existingPhone) return json({ error: 'Create a new customer for a different WhatsApp number so the existing chat history stays intact.' }, 409);
    await env.DB.batch([
      env.DB.prepare(`UPDATE whatsapp_customers SET phone=?1,display_name=?2,shop_name=?2,gstin=?3,address=?4,city=?5,route_name=?6,credit_days=?7,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE phone=?8`)
        .bind(phone, name, gstin, address, city, routeName, creditDays, existingPhone),
      env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('UPDATE_CUSTOMER','CUSTOMER',?1,?2)")
        .bind(`WHATSAPP:${phone}`, JSON.stringify({ name, phone, gstin, route_name: routeName, previous_phone: existingPhone })),
    ]);
    return json({ id: `WHATSAPP:${phone}`, source: 'WHATSAPP', code: 'ONLINE', name, mobile: phone, whatsapp_number: phone, gstin, address, city, route_name: routeName, credit_days: creditDays, balance_paise: 0 });
  }
  const current = await env.DB.prepare('SELECT * FROM customers WHERE id=?1 AND deleted_at IS NULL').bind(id).first();
  if (!current) return json({ error: 'Customer not found' }, 404);
  const body = await readObject(request, 30_000);
  const name = cleanText(body.name ?? current.name, 'name', 200);
  const phone = cleanPhone(body.whatsapp_number ?? body.mobile ?? current.whatsapp_number ?? current.mobile);
  const gstin = cleanGstin(body.gstin ?? current.gstin);
  const address = cleanText(body.address ?? current.address, 'address', 500, false);
  const city = cleanText(body.city ?? current.city, 'city', 100, false);
  const routeName = cleanText(body.route_name ?? current.route_name, 'route_name', 150, false);
  const creditDays = cleanInteger(body.credit_days ?? current.credit_days, 'credit_days');
  if (creditDays > 365) throw new Response('credit_days is too large', { status: 400 });
  if (phone) {
    const local = phone.slice(-10);
    const duplicate = await env.DB.prepare(`SELECT id,name FROM customers WHERE id<>?1 AND active=1 AND deleted_at IS NULL
      AND (mobile IN (?2,?3) OR whatsapp_number IN (?2,?3)) LIMIT 1`).bind(id, phone, local).first();
    if (duplicate) return json({ error: `This number already belongs to ${duplicate.name}.`, customer_id: duplicate.id }, 409);
  }
  const statements = [
    env.DB.prepare(`UPDATE customers SET name=?1,mobile=?2,whatsapp_number=?2,gstin=?3,address=?4,city=?5,route_name=?6,
      credit_days=?7,deleted_at=NULL,source_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE id=?8`)
      .bind(name, phone, gstin, address, city, routeName, creditDays, id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('UPDATE_CUSTOMER','CUSTOMER',?1,?2)")
      .bind(id, JSON.stringify({ name, phone, gstin, route_name: routeName, previous: { name: current.name, phone: current.whatsapp_number || current.mobile, route_name: current.route_name } })),
  ];
  if (phone) statements.push(env.DB.prepare(`INSERT INTO whatsapp_customers(phone,display_name,shop_name,gstin,address,city,route_name,credit_days,updated_at)
    VALUES(?1,?2,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET shop_name=excluded.shop_name,gstin=excluded.gstin,address=excluded.address,city=excluded.city,
      route_name=excluded.route_name,credit_days=excluded.credit_days,deleted_at=NULL,updated_at=CURRENT_TIMESTAMP`).bind(phone, name, gstin, address, city, routeName, creditDays));
  await env.DB.batch(statements);
  return json({ ...current, name, mobile: phone, whatsapp_number: phone, gstin, address, city, route_name: routeName, credit_days: creditDays });
}

async function deleteCustomer(env, id) {
  if (id.startsWith('WHATSAPP:')) {
    const phone = cleanPhone(id.slice('WHATSAPP:'.length));
    const customer = await env.DB.prepare('SELECT COALESCE(shop_name,display_name,phone) name FROM whatsapp_customers WHERE phone=?1 AND deleted_at IS NULL').bind(phone).first();
    if (!customer) return json({ error: 'Customer not found' }, 404);
    await env.DB.batch([
      env.DB.prepare('UPDATE whatsapp_customers SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE phone=?1').bind(phone),
      env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('DELETE_CUSTOMER','CUSTOMER',?1,?2)").bind(id, JSON.stringify({ name: customer.name, phone, soft_delete: true })),
    ]);
    return json({ id, name: customer.name, deleted: true });
  }
  const customer = await env.DB.prepare('SELECT * FROM customers WHERE id=?1 AND deleted_at IS NULL').bind(id).first();
  if (!customer) return json({ error: 'Customer not found' }, 404);
  const phone = cleanStoredPhone(customer.whatsapp_number || customer.mobile);
  const statements = [
    env.DB.prepare('UPDATE customers SET deleted_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE id=?1').bind(id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('DELETE_CUSTOMER','CUSTOMER',?1,?2)").bind(id, JSON.stringify({ name: customer.name, phone, soft_delete: true })),
  ];
  if (phone) statements.push(env.DB.prepare('UPDATE whatsapp_customers SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE phone=?1').bind(phone));
  await env.DB.batch(statements);
  return json({ id, name: customer.name, deleted: true });
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
  const rows = await env.DB.prepare(`SELECT * FROM invoices WHERE deleted_at IS NULL AND (?1='' OR invoice_number LIKE ?2 ESCAPE '\\' OR customer_name LIKE ?2 ESCAPE '\\' OR mobile LIKE ?2 ESCAPE '\\') ORDER BY invoice_date DESC,id DESC LIMIT ?3 OFFSET ?4`).bind(query, pattern, limit, offset).all();
  return json({ invoices: rows.results || [] });
}

function invoiceLineAmounts(quantity, unitPricePaise, gstBps) {
  const subtotal = Math.round(Number(quantity) * Number(unitPricePaise));
  const tax = Math.round(subtotal * Number(gstBps) / 10_000);
  return { subtotal_paise: subtotal, tax_paise: tax, total_paise: subtotal + tax };
}

function orderEstimateLineAmounts(quantity, unitPricePaise, gstBps) {
  const subtotal = Math.round(Number(quantity) * Number(unitPricePaise));
  return { subtotal_paise: subtotal, tax_paise: 0, total_paise: subtotal, gst_bps: Number(gstBps) || 0 };
}

function paymentStatus(total, paid) {
  return paid >= total ? 'PAID' : paid > 0 ? 'PART_PAID' : 'UNPAID';
}

async function invoiceDetail(env, id) {
  const invoice = await env.DB.prepare('SELECT * FROM invoices WHERE id=?1 AND deleted_at IS NULL').bind(id).first();
  if (!invoice) return json({ error: 'Invoice not found' }, 404);
  const lines = await env.DB.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?1 ORDER BY line_no').bind(id).all();
  let rows=lines.results || [];
  if(!rows.length && invoice.source==='AMUL'){
    const archived=await env.DB.prepare(`SELECT a.payload,p.product_name,p.sku FROM local_migration_archive a
      LEFT JOIN inventory p ON p.product_id='AMUL:' || json_extract(a.payload,'$.product_id')
      WHERE a.source_table='amul_sales_invoice_lines' AND CAST(json_extract(a.payload,'$.sal_id') AS TEXT)=?1
      ORDER BY CAST(json_extract(a.payload,'$.line_no') AS INTEGER)`).bind(String(invoice.source_id)).all();
    rows=(archived.results||[]).map(r=>{const p=JSON.parse(r.payload);return {line_no:p.line_no,product_id:'AMUL:'+p.product_id,product_name:r.product_name||String(p.product_id),sku:r.sku,quantity:p.quantity,unit:'base stock units',unit_price_paise:p.unit_rate_paise,gst_bps:null,tax_paise:p.tax_paise,total_paise:p.net_paise,subtotal_paise:p.net_paise-p.tax_paise};});
    if(rows.length){invoice.tax_paise=rows.reduce((s,r)=>s+r.tax_paise,0);invoice.subtotal_paise=rows.reduce((s,r)=>s+r.subtotal_paise,0);}
  }
  return json({ invoice, lines: rows });
}

async function createInvoice(request, env) {
  const body = await readObject(request, 150_000);
  const requestId = cleanText(body.request_id, 'request_id', 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Response('Invalid request_id', { status: 400 });
  const existing = await env.DB.prepare('SELECT id,invoice_number,total_paise,payment_status FROM invoices WHERE request_id=?1').bind(requestId).first();
  if (existing) return json(existing);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length || lines.length > 200) throw new Response('Choose 1 to 200 products', { status: 400 });
  const orderId = cleanText(body.order_id, 'order_id', 100, false);
  let order = null;
  if (orderId) {
    order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?1 AND status IN ('NEW','SYNCED')
      AND workflow_status IN ('CONFIRMED','PICKING','PACKING','PACKED')`).bind(orderId).first();
    if (!order) return json({ error: 'This order is not ready for checkout or has already been invoiced.' }, 409);
    const incomplete = await env.DB.prepare('SELECT COUNT(*) count FROM order_lines WHERE order_id=?1 AND picked_qty<>quantity').bind(orderId).first();
    if (Number(incomplete?.count || 0)) return json({ error: 'Pick every ordered item before checkout.' }, 409);
    const orderLineCount = await env.DB.prepare('SELECT COUNT(*) count FROM order_lines WHERE order_id=?1').bind(orderId).first();
    if (Number(orderLineCount?.count || 0) !== lines.length) return json({ error: 'Checkout must include every item from the selected order.' }, 400);
  }
  const customerId = cleanText(body.customer_id || order?.customer_id, 'customer_id', 140);
  let customer = null;
  if (customerId.startsWith('WHATSAPP:')) {
    const phone = cleanPhone(customerId.slice('WHATSAPP:'.length));
    const profile = await env.DB.prepare('SELECT * FROM whatsapp_customers WHERE phone=?1 AND deleted_at IS NULL').bind(phone).first();
    if (profile) customer = { id: customerId, name: profile.shop_name || profile.display_name || phone, mobile: phone, whatsapp_number: phone, route_name: profile.route_name || '', credit_days: Number(profile.credit_days || 0) };
  } else customer = await env.DB.prepare('SELECT id,name,mobile,whatsapp_number,route_name,credit_days FROM customers WHERE id=?1 AND active=1 AND deleted_at IS NULL').bind(customerId).first();
  if (!customer) return json({ error: 'Select an available customer' }, 400);
  const phone = cleanPhone(customer.whatsapp_number || customer.mobile);
  const invoiceDate = cleanDate(body.invoice_date, 'invoice_date', true);
  const dueDate = cleanDate(body.due_date, 'due_date', false) || invoiceDate;
  const discount = cleanInteger(body.discount_paise, 'discount_paise');
  const paid = cleanInteger(body.paid_paise, 'paid_paise');
  const notes = cleanText(body.notes, 'notes', 500, false);
  const method = cleanText(body.payment_method, 'payment_method', 40, false) || (paid ? 'CASH' : 'CREDIT');
  const preparedLines = [];
  const seen = new Set();
  let subtotal = 0;
  let tax = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const productId = cleanText(line.product_id, 'product_id', 100);
    if (seen.has(productId)) throw new Response('The same product cannot appear twice', { status: 400 });
    seen.add(productId);
    let quantity = cleanNumber(line.quantity, 'quantity', 0.000001);
    if (quantity > 10000) throw new Response('Quantity must not exceed 10,000', { status: 400 });
    let price = cleanInteger(line.unit_price_paise, 'unit_price_paise');
    let gstBps = cleanInteger(line.gst_bps, 'gst_bps');
    if (gstBps > 5000) throw new Response('GST must not exceed 50%', { status: 400 });
    let reservedForOrder = 0;
    if (orderId) {
      const orderLine = await env.DB.prepare(`SELECT quantity,picked_qty,price_paise,gst_bps FROM order_lines
        WHERE order_id=?1 AND product_id=?2`).bind(orderId, productId).first();
      if (!orderLine) throw new Response('Checkout products must match the selected order.', { status: 400 });
      quantity = Number(orderLine.picked_qty);
      reservedForOrder = Number(orderLine.quantity);
      price = Number(orderLine.price_paise || 0);
      gstBps = Number(orderLine.gst_bps || 0);
    }
    const product = await env.DB.prepare(`SELECT product_id,sku,product_name,unit,stock_qty,reserved_qty,manual_out_of_stock
      FROM inventory WHERE product_id=?1 AND active=1`).bind(productId).first();
    if (!product || product.manual_out_of_stock || Number(product.stock_qty) - Number(product.reserved_qty) + reservedForOrder < quantity) throw new Response(`Insufficient stock for ${product?.product_name || productId}`, { status: 409 });
    const amounts = invoiceLineAmounts(quantity, price, gstBps);
    subtotal += amounts.subtotal_paise;
    tax += amounts.tax_paise;
    preparedLines.push({ line_no: index + 1, product, quantity, price, gstBps, ...amounts });
  }
  const gross = subtotal + tax;
  if (discount > gross) throw new Response('Discount cannot exceed the invoice amount', { status: 400 });
  const total = gross - discount;
  if (paid > total) throw new Response('Amount received cannot exceed the invoice total', { status: 400 });
  const idPart = crypto.randomUUID();
  const id = `CLOUD:${idPart}`;
  const businessDate = invoiceDate.replaceAll('-', '');
  const invoiceNumber = `WEBINV-${businessDate}-${idPart.slice(0, 6).toUpperCase()}`;
  const status = paymentStatus(total, paid);
  const statements = [];
  if (orderId) statements.push(
    env.DB.prepare(`UPDATE inventory SET reserved_qty=MAX(0,reserved_qty-COALESCE((
      SELECT SUM(quantity) FROM order_lines WHERE order_id=?1 AND product_id=inventory.product_id
    ),0)) WHERE product_id IN (SELECT product_id FROM order_lines WHERE order_id=?1)`).bind(orderId),
    env.DB.prepare("UPDATE orders SET reservation_released=1,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND reservation_released=0").bind(orderId),
  );
  statements.push(env.DB.prepare(`INSERT INTO invoices
    (id,source,source_id,invoice_number,invoice_date,due_date,customer_id,customer_name,mobile,route_name,total_paise,paid_paise,outstanding_paise,payment_status,status,source_device,snapshot_id,source_updated_at,synced_at,request_id,subtotal_paise,tax_paise,discount_paise,payment_method,notes,order_id)
    VALUES(?1,'LOCAL',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'POSTED','cloudflare-admin',?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?14,?15,?16,?17,?18,?19,?20)`)
    .bind(id, idPart, invoiceNumber, invoiceDate, dueDate, customer.id, customer.name, phone, customer.route_name || '', total, paid, total - paid, status, requestId, subtotal, tax, discount, method, notes, orderId || null));
  for (const line of preparedLines) statements.push(env.DB.prepare(`INSERT INTO invoice_lines
    (invoice_id,line_no,product_id,sku,product_name,quantity,unit,unit_price_paise,gst_bps,subtotal_paise,tax_paise,total_paise)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`).bind(id, line.line_no, line.product.product_id, line.product.sku || '', line.product.product_name, line.quantity, line.product.unit, line.price, line.gstBps, line.subtotal_paise, line.tax_paise, line.total_paise));
  if (paid) {
    const paymentId = crypto.randomUUID();
    statements.push(env.DB.prepare(`INSERT INTO payments
      (id,source,source_id,receipt_number,payment_date,customer_id,customer_name,direction,method,amount_paise,reference_number,source_device,snapshot_id,source_updated_at,synced_at)
      VALUES(?1,'LOCAL',?2,?3,?4,?5,?6,'RECEIPT',?7,?8,?9,'cloudflare-admin',?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .bind(`CLOUD:${paymentId}`, paymentId, `WEBRCPT-${businessDate}-${paymentId.slice(0, 6).toUpperCase()}`, invoiceDate, customer.id, customer.name, method, paid, invoiceNumber));
  }
  if (orderId) statements.push(env.DB.prepare(`UPDATE orders SET workflow_status='INVOICED',invoice_number=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2`).bind(invoiceNumber, orderId));
  statements.push(env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('CREATE_INVOICE','INVOICE',?1,?2)").bind(id, JSON.stringify({ invoice_number: invoiceNumber, customer_id: customer.id, total_paise: total, paid_paise: paid, line_count: preparedLines.length })));
  try { await env.DB.batch(statements); } catch (error) {
    if (String(error).includes('INSUFFICIENT_STOCK')) throw new Response('Stock changed while saving. Refresh and review the invoice.', { status: 409 });
    throw error;
  }
  return json({ id, invoice_number: invoiceNumber, order_id: orderId, total_paise: total, paid_paise: paid, outstanding_paise: total - paid, payment_status: status }, 201);
}

async function voidInvoice(env, id) {
  const invoice = await env.DB.prepare("SELECT id,invoice_number,status,source_device,paid_paise FROM invoices WHERE id=?1 AND deleted_at IS NULL").bind(id).first();
  if (!invoice) return json({ error: 'Invoice not found' }, 404);
  if (invoice.source_device !== 'cloudflare-admin') return json({ error: 'Synced Amul/PC invoices must be corrected on the source PC.' }, 409);
  if (invoice.status === 'VOID') return json(invoice);
  if (Number(invoice.paid_paise || 0) > 0) return json({ error: 'Reverse the recorded payment before voiding this invoice.' }, 409);
  await env.DB.batch([
    env.DB.prepare("UPDATE invoices SET status='VOID',outstanding_paise=0,payment_status='VOID',source_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE id=?1 AND status<>'VOID'").bind(id),
    env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('VOID_INVOICE','INVOICE',?1,?2)").bind(id, JSON.stringify({ invoice_number: invoice.invoice_number })),
  ]);
  return json({ id, invoice_number: invoice.invoice_number, status: 'VOID' });
}

async function updateInvoice(request, env, id) {
  const invoice = await env.DB.prepare('SELECT * FROM invoices WHERE id=?1 AND deleted_at IS NULL').bind(id).first();
  if (!invoice) return json({ error: 'Invoice not found' }, 404);
  if (invoice.status === 'VOID') return json({ error: 'A void invoice cannot be edited.' }, 409);
  const online = invoice.source_device === 'cloudflare-admin';
  const body = await readObject(request, 150_000);
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length || lines.length>200) throw new Response('Choose 1 to 200 products', { status: 400 });
  const customerId = cleanText(body.customer_id, 'customer_id', 140);
  let customer = null;
  if (customerId.startsWith('WHATSAPP:')) {
    const phoneId = cleanPhone(customerId.slice('WHATSAPP:'.length));
    const profile = await env.DB.prepare('SELECT * FROM whatsapp_customers WHERE phone=?1 AND deleted_at IS NULL').bind(phoneId).first();
    if (profile) customer={ id:customerId,name:profile.shop_name||profile.display_name||phoneId,mobile:phoneId,whatsapp_number:phoneId,route_name:profile.route_name||'' };
  } else customer=await env.DB.prepare('SELECT id,name,mobile,whatsapp_number,route_name FROM customers WHERE id=?1 AND active=1 AND deleted_at IS NULL').bind(customerId).first();
  if (!customer) return json({ error: 'Select an available customer' }, 400);
  const oldRows=(await env.DB.prepare('SELECT product_id,quantity FROM invoice_lines WHERE invoice_id=?1').bind(id).all()).results||[];
  const oldByProduct=new Map(oldRows.map(row=>[row.product_id,Number(row.quantity)]));
  const prepared=[];
  const seen=new Set();
  let subtotal=0,tax=0;
  for(let index=0;index<lines.length;index+=1){
    const input=lines[index],productId=cleanText(input.product_id,'product_id',100);
    if(seen.has(productId))throw new Response('The same product cannot appear twice',{status:400});
    seen.add(productId);
    const quantity=cleanNumber(input.quantity,'quantity',0.000001),price=cleanInteger(input.unit_price_paise,'unit_price_paise'),gstBps=cleanInteger(input.gst_bps,'gst_bps');
    if(quantity>10000||gstBps>5000)throw new Response('Invalid invoice quantity or GST',{status:400});
    const product=await env.DB.prepare(`SELECT product_id,sku,product_name,unit,stock_qty,reserved_qty,manual_out_of_stock FROM inventory WHERE product_id=?1 AND active=1`).bind(productId).first();
    if(!product)throw new Response(`Product is unavailable: ${productId}`,{status:409});
    const available=Number(product.stock_qty||0)-Number(product.reserved_qty||0)+Number(oldByProduct.get(productId)||0);
    if(online&&(product.manual_out_of_stock||available<quantity))throw new Response(`Insufficient stock for ${product.product_name||productId}`,{status:409});
    const amounts=invoiceLineAmounts(quantity,price,gstBps);subtotal+=amounts.subtotal_paise;tax+=amounts.tax_paise;
    prepared.push({line_no:index+1,product,quantity,price,gstBps,...amounts});
  }
  const discount=cleanInteger(body.discount_paise,'discount_paise'),gross=subtotal+tax;
  if(discount>gross)throw new Response('Discount cannot exceed the invoice amount',{status:400});
  const total=gross-discount,paid=cleanInteger(body.paid_paise,'paid_paise'),invoiceDate=cleanDate(body.invoice_date,'invoice_date',true),dueDate=cleanDate(body.due_date,'due_date',false)||invoiceDate;
  if(paid>total)throw new Response('Amount received cannot exceed the invoice total',{status:400});
  const status=paymentStatus(total,paid);
  const notes=cleanText(body.notes,'notes',500,false),method=cleanText(body.payment_method,'payment_method',40,false)||'CREDIT',phone=cleanPhone(customer.whatsapp_number||customer.mobile);
  const statements=[];
  if(online)statements.push(env.DB.prepare(`UPDATE inventory SET stock_qty=stock_qty+COALESCE((SELECT SUM(quantity) FROM invoice_lines WHERE invoice_id=?1 AND product_id=inventory.product_id),0),stock_control_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE product_id IN (SELECT product_id FROM invoice_lines WHERE invoice_id=?1)`).bind(id));
  statements.push(
    env.DB.prepare('DELETE FROM invoice_lines WHERE invoice_id=?1').bind(id),
    env.DB.prepare(`UPDATE invoices SET invoice_date=?1,due_date=?2,customer_id=?3,customer_name=?4,mobile=?5,route_name=?6,total_paise=?7,paid_paise=?8,outstanding_paise=?9,payment_status=?10,subtotal_paise=?11,tax_paise=?12,discount_paise=?13,payment_method=?14,notes=?15,source_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE id=?16`)
      .bind(invoiceDate,dueDate,customer.id,customer.name,phone,customer.route_name||'',total,paid,total-paid,status,subtotal,tax,discount,method,notes,id),
  );
  for(const line of prepared)statements.push(env.DB.prepare(`INSERT INTO invoice_lines(invoice_id,line_no,product_id,sku,product_name,quantity,unit,unit_price_paise,gst_bps,subtotal_paise,tax_paise,total_paise) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`).bind(id,line.line_no,line.product.product_id,line.product.sku||'',line.product.product_name,line.quantity,line.product.unit,line.price,line.gstBps,line.subtotal_paise,line.tax_paise,line.total_paise));
  if(online){
    statements.push(env.DB.prepare("DELETE FROM payments WHERE source_device='cloudflare-admin' AND reference_number=?1").bind(invoice.invoice_number));
    if(paid){
      const paymentId=crypto.randomUUID(),businessDate=invoiceDate.replaceAll('-','');
      statements.push(env.DB.prepare(`INSERT INTO payments
        (id,source,source_id,receipt_number,payment_date,customer_id,customer_name,direction,method,amount_paise,reference_number,source_device,snapshot_id,source_updated_at,synced_at)
        VALUES(?1,'LOCAL',?2,?3,?4,?5,?6,'RECEIPT',?7,?8,?9,'cloudflare-admin',?2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
        .bind(`CLOUD:${paymentId}`,paymentId,`WEBRCPT-${businessDate}-${paymentId.slice(0,6).toUpperCase()}`,invoiceDate,customer.id,customer.name,method,paid,invoice.invoice_number));
    }
  }
  statements.push(env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('UPDATE_INVOICE','INVOICE',?1,?2)").bind(id,JSON.stringify({invoice_number:invoice.invoice_number,previous_total_paise:invoice.total_paise,total_paise:total,previous_paid_paise:invoice.paid_paise,paid_paise:paid,line_count:prepared.length,online_stock_adjusted:online})));
  try{await env.DB.batch(statements)}catch(error){if(String(error).includes('INSUFFICIENT_STOCK'))throw new Response('Stock changed while updating. Refresh and review the invoice.',{status:409});throw error}
  return json({id,invoice_number:invoice.invoice_number,total_paise:total,paid_paise:paid,outstanding_paise:total-paid,payment_status:status,online_stock_adjusted:online});
}

async function deleteInvoice(env,id){
  const invoice=await env.DB.prepare('SELECT * FROM invoices WHERE id=?1 AND deleted_at IS NULL').bind(id).first();
  if(!invoice)return json({error:'Invoice not found'},404);
  const online=invoice.source_device==='cloudflare-admin';
  let order=null;
  if(online&&invoice.order_id){
    order=await env.DB.prepare('SELECT workflow_status FROM orders WHERE id=?1').bind(invoice.order_id).first();
  }
  const reopenOrder=Boolean(online&&invoice.order_id&&order?.workflow_status==='INVOICED'&&invoice.status!=='VOID');
  const restoreStock=Boolean(online&&invoice.status!=='VOID'&&(!invoice.order_id||reopenOrder));
  const statements=[env.DB.prepare('UPDATE invoices SET deleted_at=CURRENT_TIMESTAMP,outstanding_paise=0,synced_at=CURRENT_TIMESTAMP WHERE id=?1').bind(id)];
  if(restoreStock)statements.push(env.DB.prepare(`UPDATE inventory SET stock_qty=stock_qty+COALESCE((SELECT SUM(quantity) FROM invoice_lines WHERE invoice_id=?1 AND product_id=inventory.product_id),0),stock_control_updated_at=CURRENT_TIMESTAMP,synced_at=CURRENT_TIMESTAMP WHERE product_id IN (SELECT product_id FROM invoice_lines WHERE invoice_id=?1)`).bind(id));
  if(reopenOrder)statements.push(
    env.DB.prepare(`UPDATE inventory SET reserved_qty=reserved_qty+COALESCE((SELECT SUM(quantity) FROM order_lines WHERE order_id=?1 AND product_id=inventory.product_id),0) WHERE product_id IN (SELECT product_id FROM order_lines WHERE order_id=?1)`).bind(invoice.order_id),
    env.DB.prepare("UPDATE orders SET reservation_released=0,workflow_status='PICKING',invoice_number=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1").bind(invoice.order_id),
  );
  else if(online&&invoice.order_id)statements.push(env.DB.prepare('UPDATE orders SET invoice_number=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1').bind(invoice.order_id));
  if(online)statements.push(env.DB.prepare("DELETE FROM payments WHERE source_device='cloudflare-admin' AND reference_number=?1").bind(invoice.invoice_number));
  statements.push(env.DB.prepare("INSERT INTO operations_audit(action,entity_type,entity_id,detail_json) VALUES('DELETE_INVOICE','INVOICE',?1,?2)").bind(id,JSON.stringify({invoice_number:invoice.invoice_number,order_id:invoice.order_id||null,order_workflow_status:order?.workflow_status||null,total_paise:invoice.total_paise,paid_paise:invoice.paid_paise,source_device:invoice.source_device,soft_delete:true,stock_restored:restoreStock,order_reopened:reopenOrder,linked_online_payment_removed:online&&Number(invoice.paid_paise||0)>0})));
  await env.DB.batch(statements);
  return json({id,invoice_number:invoice.invoice_number,deleted:true,reopened_order_id:reopenOrder?invoice.order_id:null,stock_restored:restoreStock,payment_removed:online&&Number(invoice.paid_paise||0)>0,order_preserved:Boolean(online&&invoice.order_id&&!reopenOrder)});
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

async function fetchWhatsAppTemplates(env) {
  if (!env.META_ACCESS_TOKEN || !env.META_WABA_ID) throw new Response('WhatsApp templates are not configured yet.', { status: 503 });
  const version = /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || '') ? env.META_GRAPH_VERSION : 'v25.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(env.META_WABA_ID)}/message_templates?fields=id,name,status,category,language,components&limit=100`, {
    headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Response(result.error?.message || 'Unable to load WhatsApp templates.', { status: 502 });
  return (result.data || []).map(({ id, name, status, category, language, components }) => {
    const body = (components || []).find(component => String(component.type).toUpperCase() === 'BODY')?.text || '';
    const indexes = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]));
    return { id, name, status, category, language, body, parameter_count: indexes.length ? Math.max(...indexes) : 0 };
  });
}

async function whatsappTemplates(env) {
  return json({ templates: await fetchWhatsAppTemplates(env) });
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
  // Acknowledge only after every event is stored. Retries are deduplicated by event ID.
  for(let offset=0;offset<statements.length;offset+=50)await env.DB.batch(statements.slice(offset,offset+50));
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

function catalogueInviteMessage(to, language = 'en_US') {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: 'amul_catalogue', language: { code: language } },
  };
}

function approvedTemplateMessage(to, templateName, language, parameters = []) {
  const message = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: templateName, language: { code: language } },
  };
  if (parameters.length) message.template.components = [{ type: 'body', parameters: parameters.map(value => ({ type: 'text', text: value })) }];
  return message;
}

async function inviteWhatsAppCustomer(request, env) {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_ID || !env.META_WABA_ID) return json({ error: 'WhatsApp invitations are not configured yet.' }, 503);
  const body = await readObject(request, 20_000);
  if (body.opt_in !== true) return json({ error: 'Confirm that this customer agreed to receive WhatsApp messages.' }, 400);
  const to = cleanPhone(body.to);
  if (!to) throw new Response('Customer number is required', { status: 400 });
  const customerName = cleanText(body.customer_name, 'customer_name', 120, false);
  const language = cleanText(body.language, 'language', 20, false) || 'en_US';
  const templates = await fetchWhatsAppTemplates(env);
  const template = templates.find(item => item.name === 'amul_catalogue' && item.language === language);
  if (!template) return json({ error: `The amul_catalogue ${language} template is not available in Meta.` }, 409);
  if (template.status !== 'APPROVED') return json({ error: `Meta has not approved the catalogue invite yet (current status: ${template.status}).` }, 409);

  let result, messageId;
  try { ({ result, messageId } = await sendMetaMessage(env, to, catalogueInviteMessage(to, language))); }
  catch (error) { return json({ error: String(error.message || error) }, 502); }
  await env.DB.batch([
    profileUpsert(env, to, customerName, false),
    env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time)
      VALUES(?1,'INVITE',?2,?3,'OUTBOUND','template','amul_catalogue',?4,?5)`).bind(`invite:${messageId}`, to, customerName, JSON.stringify(result), String(Math.floor(Date.now() / 1000))),
  ]);
  return json({ accepted: true, message_id: messageId, to, template: 'amul_catalogue' }, 201);
}

async function sendWhatsAppTemplate(request, env) {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_ID || !env.META_WABA_ID) return json({ error: 'WhatsApp templates are not configured yet.' }, 503);
  const body = await readObject(request, 30_000);
  if (body.opt_in !== true) return json({ error: 'Confirm that this customer agreed to receive WhatsApp messages.' }, 400);
  const to = cleanPhone(body.to);
  if (!to) throw new Response('Customer number is required', { status: 400 });
  const customerName = cleanText(body.customer_name, 'customer_name', 120, false);
  const templateName = cleanText(body.template_name, 'template_name', 120);
  const language = cleanText(body.language, 'language', 20, false) || 'en_US';
  const templates = await fetchWhatsAppTemplates(env);
  const template = templates.find(item => item.name === templateName && item.language === language);
  if (!template) return json({ error: `The ${templateName} ${language} template is not available in Meta.` }, 409);
  if (template.status !== 'APPROVED') return json({ error: `Meta has not approved ${templateName} yet (current status: ${template.status}).` }, 409);
  if (template.category === 'AUTHENTICATION') return json({ error: 'Authentication templates cannot be sent from this business-messaging form.' }, 400);
  const supplied = Array.isArray(body.parameters) ? body.parameters : [];
  if (supplied.length !== template.parameter_count) return json({ error: `${templateName} requires ${template.parameter_count} message values.` }, 400);
  const parameters = supplied.map((value, index) => cleanText(value, `parameter_${index + 1}`, 1024));

  let result, messageId;
  try { ({ result, messageId } = await sendMetaMessage(env, to, approvedTemplateMessage(to, templateName, language, parameters))); }
  catch (error) { return json({ error: String(error.message || error) }, 502); }
  await env.DB.batch([
    profileUpsert(env, to, customerName, false),
    env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_events(event_id,event_type,from_number,customer_name,direction,message_type,body,raw_json,event_time)
      VALUES(?1,'TEMPLATE',?2,?3,'OUTBOUND','template',?4,?5,?6)`).bind(`template:${messageId}`, to, customerName, templateName, JSON.stringify({ meta: result, parameters }), String(Math.floor(Date.now() / 1000))),
  ]);
  return json({ accepted: true, message_id: messageId, to, template: templateName }, 201);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/health') return json({ ok: true, service: 'frostflow-online', version: '0.9.0', database: 'cloudflare-d1-central' });
  if (path === '/webhooks/whatsapp' || path === '/webhooks/whatsapp/') return whatsappWebhook(request, env);
  if (path === '/api/catalog/orders' && request.method === 'POST') return createOrder(request, env, { publicCatalog: true });
  if (path === '/api/catalog/availability' && request.method === 'GET') return publicAvailability(env);
  if (request.method === 'GET' && (path === '/catalog' || path === '/catalog/' || path === '/catalog.js' || path === '/catalog.css' || path === '/catalog-data.json' || path.startsWith('/images/'))) {
    if (path === '/catalog') return Response.redirect(new URL('/catalog/', request.url), 308);
    return env.ASSETS.fetch(request);
  }

  if (path.startsWith('/api/sync/')) {
    if (!await syncAuthorized(request, env)) return json({ error: 'Unauthorized sync agent' }, 401);
    if (path === '/api/sync/snapshot' && request.method === 'POST') return acceptSnapshot(request, env);
    if (path === '/api/sync/business' && request.method === 'POST') return acceptBusinessSnapshot(request, env);
    if (path === '/api/sync/orders' && request.method === 'GET') return json({ orders: await listOrders(env, true) });
    if (path === '/api/sync/invoice-jobs' && request.method === 'GET') return listInvoiceJobs(env);
    const invoiceResult = path.match(/^\/api\/sync\/invoice-jobs\/([^/]+)\/result$/);
    if (invoiceResult && request.method === 'POST') return finishInvoiceJob(request, env, decodeURIComponent(invoiceResult[1]));
    const ack = path.match(/^\/api\/sync\/orders\/([^/]+)\/ack$/);
    if (ack && request.method === 'POST') return updateOrder(request, env, decodeURIComponent(ack[1]), 'ack');
    return json({ error: 'Sync endpoint not found' }, 404);
  }

  if (!await appAuthorized(request, env)) return json({ error: 'Authentication required' }, 401, { 'WWW-Authenticate': 'Basic realm="FrostFlow Online", charset="UTF-8"' });
  if (path === '/api/dashboard' && request.method === 'GET') return dashboard(env);
  if (path === '/api/reconciliation' && request.method === 'GET') return reconciliation(env);
  if (path === '/api/inventory' && request.method === 'GET') return inventory(request, env);
  const stockControl = path.match(/^\/api\/inventory\/([^/]+)\/availability$/);
  if (stockControl && request.method === 'PATCH') return setInventoryAvailability(request, env, decodeURIComponent(stockControl[1]));
  const stockQuantity = path.match(/^\/api\/inventory\/([^/]+)\/quantity$/);
  if (stockQuantity && request.method === 'PATCH') return setInventoryQuantity(request, env, decodeURIComponent(stockQuantity[1]));
  if (path === '/api/purchase-topups' && request.method === 'GET') return purchaseTopups(env);
  if (path === '/api/purchase-topups' && request.method === 'POST') return createPurchaseTopup(request, env);
  if (path === '/api/routes' && request.method === 'GET') return routes(env);
  if (path === '/api/routes' && request.method === 'POST') return createRoute(request, env);
  if (path === '/api/routes' && request.method === 'PUT') return updateRoute(request, env);
  if (path === '/api/customers' && request.method === 'GET') return customers(request, env);
  if (path === '/api/customers' && request.method === 'POST') return createCustomer(request, env);
  const customerDetailMatch = path.match(/^\/api\/customers\/([^/]+)$/);
  if (customerDetailMatch && request.method === 'PUT') return updateCustomer(request, env, decodeURIComponent(customerDetailMatch[1]));
  if (customerDetailMatch && request.method === 'DELETE') return deleteCustomer(env, decodeURIComponent(customerDetailMatch[1]));
  if (path === '/api/distribution/orders' && request.method === 'GET') return distributionOrders(request, env);
  if (path === '/api/invoices' && request.method === 'GET') return invoices(request, env);
  if (path === '/api/invoices' && request.method === 'POST') return createInvoice(request, env);
  const invoiceDetailMatch = path.match(/^\/api\/invoices\/([^/]+)$/);
  if (invoiceDetailMatch && request.method === 'GET') return invoiceDetail(env, decodeURIComponent(invoiceDetailMatch[1]));
  if (invoiceDetailMatch && request.method === 'PUT') return updateInvoice(request, env, decodeURIComponent(invoiceDetailMatch[1]));
  if (invoiceDetailMatch && request.method === 'DELETE') return deleteInvoice(env, decodeURIComponent(invoiceDetailMatch[1]));
  const voidInvoiceMatch = path.match(/^\/api\/invoices\/([^/]+)\/void$/);
  if (voidInvoiceMatch && request.method === 'POST') return voidInvoice(env, decodeURIComponent(voidInvoiceMatch[1]));
  if (path === '/api/payments' && request.method === 'GET') return payments(request, env);
  if (path === '/api/orders' && request.method === 'GET') return json({ orders: await listOrders(env) });
  if (path === '/api/orders' && request.method === 'POST') return createOrder(request, env);
  const pickOrder = path.match(/^\/api\/orders\/([^/]+)\/pick$/);
  if (pickOrder && request.method === 'PATCH') return updatePickedLine(request, env, decodeURIComponent(pickOrder[1]));
  const crate = path.match(/^\/api\/orders\/([^/]+)\/crate$/);
  if (crate && request.method === 'POST') return crateOrder(request, env, decodeURIComponent(crate[1]));
  const invoice = path.match(/^\/api\/orders\/([^/]+)\/invoice$/);
  if (invoice && request.method === 'POST') return queueInvoice(env, decodeURIComponent(invoice[1]));
  const orderAction = path.match(/^\/api\/orders\/([^/]+)\/(confirm|pack|dispatch|deliver|cancel|fulfil)$/);
  if (orderAction && request.method === 'POST') return updateOrder(request, env, decodeURIComponent(orderAction[1]), orderAction[2]);
  if (path === '/api/whatsapp/events' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT event_id,event_type,from_number,customer_name,direction,message_type,body,event_time,received_at,order_id FROM whatsapp_events ORDER BY received_at DESC LIMIT 200').all();
    return json({ events: rows.results || [] });
  }
  if (path === '/api/whatsapp/conversations' && request.method === 'GET') return whatsappConversations(env);
  if (path === '/api/whatsapp/templates' && request.method === 'GET') return whatsappTemplates(env);
  if (path === '/api/whatsapp/invite' && request.method === 'POST') return inviteWhatsAppCustomer(request, env);
  if (path === '/api/whatsapp/template' && request.method === 'POST') return sendWhatsAppTemplate(request, env);
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

export { acceptBusinessSnapshot, equalSecret, cleanPhone, cleanStoredPhone, cleanGstin, cleanLocationUrl, catalogueReply, catalogueRequested, catalogueInviteMessage, approvedTemplateMessage, supportsWhatsAppWebhook, invoiceLineAmounts, orderEstimateLineAmounts, paymentStatus, routeDisplayName, defaultWholesaleUnit, cleanWholesaleUnit, baseOrderQuantity };
