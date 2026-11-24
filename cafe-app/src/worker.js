import menu from './menu.json' with { type: 'json' };

const encoder = new TextEncoder();
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_LINES = 30;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function randomHex(length) {
  return [...crypto.getRandomValues(new Uint8Array(length))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function equalSecret(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function checkOrigin(request) {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== new URL(request.url).origin) ||
      (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new HttpError('Cross-site request rejected', 403);
  }
}

async function readJson(request, maxBytes = 40_000) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new HttpError('JSON required', 415);
  }
  if (Number(request.headers.get('Content-Length') || 0) > maxBytes) throw new HttpError('Request too large', 413);
  const raw = await request.text();
  if (encoder.encode(raw).length > maxBytes) throw new HttpError('Request too large', 413);
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError('Invalid JSON'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError('JSON object required');
  return body;
}

function cleanText(value, field, max, required = true) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new HttpError(`${field} is required`);
  if (result.length > max) throw new HttpError(`${field} is too long`);
  return result;
}

const itemIndex = new Map();
for (const category of menu.categories) {
  for (const item of category.items) {
    if (itemIndex.has(item.id)) throw new Error(`Duplicate café menu item: ${item.id}`);
    itemIndex.set(item.id, { ...item, category: category.name });
  }
}

function selectedChoices(group, raw, groupId) {
  if (!Array.isArray(raw)) throw new HttpError(`${group.name} must be a list`);
  const available = new Set(group.choices.map(choice => typeof choice === 'string' ? choice : choice.id));
  for (const value of raw) if (typeof value !== 'string' || !available.has(value)) throw new HttpError(`Invalid ${group.name.toLowerCase()} choice`);
  if (groupId === 'sundae-extras' && new Set(raw).size !== raw.length) throw new HttpError(`Duplicate ${group.name.toLowerCase()} choice`);
  return raw;
}

function priceItem(item, submitted) {
  const allowed = item.optionGroups || [];
  const options = submitted ?? {};
  if (!options || Array.isArray(options) || typeof options !== 'object') throw new HttpError('Invalid item options');
  for (const groupId of Object.keys(options)) if (!allowed.includes(groupId)) throw new HttpError('Unsupported item option');
  const normalized = {};
  let price = item.price * 100;
  for (const groupId of allowed) {
    const group = menu.optionGroups[groupId];
    if (!group) throw new Error(`Unknown menu option group: ${groupId}`);
    const selected = options[groupId];
    if (group.type === 'checkbox') {
      if (selected !== undefined && typeof selected !== 'boolean') throw new HttpError(`${group.name} must be yes or no`);
      if (selected === true) {
        normalized[groupId] = true;
        price += group.priceDelta * 100;
      }
    } else if (group.type === 'single') {
      if (selected === undefined || selected === '') {
        if (group.required) throw new HttpError(`${group.name} is required`);
        continue;
      }
      const choice = group.choices.find(value => value.id === selected);
      if (!choice) throw new HttpError(`Invalid ${group.name.toLowerCase()} choice`);
      normalized[groupId] = selected;
      price += (choice.priceDelta || 0) * 100;
    } else if (group.type === 'multi') {
      if (selected === undefined) continue;
      const choices = selectedChoices(group, selected, groupId);
      normalized[groupId] = choices;
      for (const value of choices) {
        const choice = group.choices.find(entry => typeof entry === 'object' && entry.id === value);
        if (choice) price += (choice.priceDelta || 0) * 100;
      }
    }
  }
  if (item.id === 'build-your-own-sundae') {
    const size = normalized['sundae-size'];
    const scoopCount = { single: 1, double: 2, triple: 3 }[size];
    const flavors = normalized['sundae-flavors'] || [];
    const sauces = normalized['sundae-sauce'] || [];
    const toppings = normalized['sundae-topping'] || [];
    const extras = normalized['sundae-extras'] || [];
    if (flavors.length !== scoopCount) throw new HttpError('Choose one flavor for each scoop');
    if (sauces.length < 1 || sauces.length > 2) throw new HttpError('Choose one sauce, with an optional extra');
    if (toppings.length < 1 || toppings.length > 2) throw new HttpError('Choose one topping, with an optional extra');
    if ((sauces.length === 2) !== extras.includes('additional-sauce')) throw new HttpError('Extra sauce selection does not match');
    if ((toppings.length === 2) !== extras.includes('additional-topping')) throw new HttpError('Extra topping selection does not match');
  }
  if (!Number.isSafeInteger(price) || price < 0) throw new HttpError('Invalid item price');
  return { unit_price_paise: price, options: normalized };
}

function orderDateKey() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}${part('month')}${part('day')}`;
}

function asUtc(value) {
  return value && !/[zZ]|[+-]\d\d:\d\d$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
}

function publicOrder(row, request) {
  const url = new URL('/', request.url);
  url.searchParams.set('order', row.tracking_token);
  return {
    id: row.id, order_number: row.order_number, status: row.status,
    tracking_token: row.tracking_token, tracking_url: url.toString(),
    total_paise: row.total_paise,
  };
}

async function createOrder(request, env) {
  checkOrigin(request);
  const body = await readJson(request);
  const requestId = cleanText(body.request_id, 'request_id', 80);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw new HttpError('Invalid request_id');
  const prior = await env.DB.prepare('SELECT * FROM cafe_orders WHERE request_id=?1').bind(requestId).first();
  if (prior) return json(publicOrder(prior, request), 200);
  const customerName = cleanText(body.customer_name, 'customer_name', 80);
  const serviceType = cleanText(body.service_type, 'service_type', 20);
  if (!['DINE_IN', 'TAKEAWAY'].includes(serviceType)) throw new HttpError('Choose dine-in or takeaway');
  const tableNumber = cleanText(body.table_number, 'table_number', 16, serviceType === 'DINE_IN');
  if (serviceType === 'DINE_IN' && !/^[\p{L}\p{N}][\p{L}\p{N} -]{0,15}$/u.test(tableNumber)) throw new HttpError('Invalid table number');
  const note = cleanText(body.note, 'note', 300, false);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_LINES) throw new HttpError(`Choose 1–${MAX_LINES} items`);
  const lines = [];
  let total = 0;
  let totalQuantity = 0;
  for (const submitted of body.items) {
    if (!submitted || Array.isArray(submitted) || typeof submitted !== 'object') throw new HttpError('Invalid cart item');
    const item = itemIndex.get(submitted.item_id);
    if (!item) throw new HttpError('Item is no longer on the menu');
    const quantity = Number(submitted.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new HttpError('Quantity must be 1–20');
    const priced = priceItem(item, submitted.options);
    const lineTotal = priced.unit_price_paise * quantity;
    total += lineTotal;
    totalQuantity += quantity;
    lines.push({ item, quantity, ...priced, total_paise: lineTotal });
  }
  if (totalQuantity > 100 || total > 2_000_000) throw new HttpError('Order is too large');
  if (!env.CAFE_SESSION_SECRET) throw new HttpError('Ordering is temporarily unavailable', 503);
  const now = Math.floor(Date.now() / 1000);
  const ipHash = await sha256(`${env.CAFE_SESSION_SECRET}:${request.headers.get('CF-Connecting-IP') || 'local'}`);
  const rate = await env.DB.prepare(`INSERT INTO cafe_order_rate(ip_hash,window_started,order_count)
    VALUES(?1,?2,1) ON CONFLICT(ip_hash) DO UPDATE SET
      order_count=CASE WHEN window_started<=?3 THEN 1 ELSE order_count+1 END,
      window_started=CASE WHEN window_started<=?3 THEN ?2 ELSE window_started END
    WHERE window_started<=?3 OR order_count<40`)
    .bind(ipHash, now, now - 600).run();
  if (!rate.meta?.changes) throw new HttpError('Too many orders from this connection. Please ask the café team for help.', 429);
  const id = crypto.randomUUID();
  const trackingToken = randomHex(24);
  const orderNumber = `CF-${orderDateKey()}-${id.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const statements = [env.DB.prepare(`INSERT INTO cafe_orders
    (id,request_id,tracking_token,order_number,customer_name,service_type,table_number,note,total_paise)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(id, requestId, trackingToken, orderNumber, customerName, serviceType,
      serviceType === 'DINE_IN' ? tableNumber : null, note, total)];
  lines.forEach((line, index) => statements.push(env.DB.prepare(`INSERT INTO cafe_order_items
    (order_id,line_no,item_id,name,category,quantity,unit_price_paise,total_paise,options_json)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(id, index + 1, line.item.id, line.item.name, line.item.category,
      line.quantity, line.unit_price_paise, line.total_paise, JSON.stringify(line.options))));
  try { await env.DB.batch(statements); }
  catch (error) {
    const existing = await env.DB.prepare('SELECT * FROM cafe_orders WHERE request_id=?1').bind(requestId).first();
    if (existing) return json(publicOrder(existing, request), 200);
    throw error;
  }
  return json(publicOrder({ id, order_number: orderNumber, status: 'RECEIVED',
    tracking_token: trackingToken, total_paise: total }, request), 201);
}

function formatItem(row) {
  let options = {};
  try { options = JSON.parse(row.options_json || '{}'); } catch { /* Preserve order visibility. */ }
  return { item_id: row.item_id, name: row.name, category: row.category,
    quantity: row.quantity, unit_price_paise: row.unit_price_paise,
    total_paise: row.total_paise, options };
}

async function trackOrder(token, env) {
  const row = await env.DB.prepare(`SELECT id,order_number,customer_name,service_type,table_number,
    status,total_paise,created_at,updated_at FROM cafe_orders WHERE tracking_token=?1`).bind(token).first();
  if (!row) throw new HttpError('Order not found', 404);
  const items = (await env.DB.prepare(`SELECT item_id,name,category,quantity,unit_price_paise,
    total_paise,options_json FROM cafe_order_items WHERE order_id=?1 ORDER BY line_no`).bind(row.id).all()).results || [];
  row.created_at = asUtc(row.created_at);
  row.updated_at = asUtc(row.updated_at);
  return json({ order: row, items: items.map(formatItem) });
}

function cookieValue(request) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(/(?:^|;\s*)__Secure-cafe_session=([a-f0-9]{64})(?:;|$)/i);
  return match?.[1] || '';
}

function sessionCookie(token, maxAge) {
  return `__Secure-cafe_session=${token}; Path=/api/cafe/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

async function sessionRow(request, env) {
  const token = cookieValue(request);
  if (!token) return null;
  return env.DB.prepare('SELECT token_hash FROM cafe_admin_sessions WHERE token_hash=?1 AND expires_at>?2')
    .bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
}

async function requireAdmin(request, env) {
  if (!await sessionRow(request, env)) throw new HttpError('Sign in to continue', 401);
}

async function login(request, env) {
  checkOrigin(request);
  const body = await readJson(request, 2_000);
  if (!env.CAFE_ADMIN_USER || !env.CAFE_ADMIN_PASSWORD || !env.CAFE_SESSION_SECRET) {
    throw new HttpError('Kitchen sign-in is not configured', 503);
  }
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const ipHash = await sha256(`${env.CAFE_SESSION_SECRET}:${ip}`);
  const attempt = await env.DB.prepare('SELECT failure_count,window_started FROM cafe_auth_attempts WHERE ip_hash=?1').bind(ipHash).first();
  if (attempt && attempt.window_started > now - 900 && attempt.failure_count >= 8) {
    throw new HttpError('Too many sign-in attempts. Try again later.', 429);
  }
  const username = cleanText(body.username, 'username', 80, false);
  const password = cleanText(body.password, 'password', 200, false);
  const [userMatches, passwordMatches] = await Promise.all([
    equalSecret(username, env.CAFE_ADMIN_USER),
    equalSecret(password, env.CAFE_ADMIN_PASSWORD),
  ]);
  if (!userMatches || !passwordMatches) {
    const failures = attempt && attempt.window_started > now - 900 ? attempt.failure_count + 1 : 1;
    await env.DB.prepare(`INSERT INTO cafe_auth_attempts(ip_hash,failure_count,window_started)
      VALUES(?1,?2,?3) ON CONFLICT(ip_hash) DO UPDATE SET
      failure_count=excluded.failure_count,window_started=excluded.window_started`)
      .bind(ipHash, failures, failures === 1 ? now : attempt.window_started).run();
    throw new HttpError('Invalid username or password', 401);
  }
  const token = randomHex(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cafe_auth_attempts WHERE ip_hash=?1').bind(ipHash),
    env.DB.prepare('DELETE FROM cafe_admin_sessions WHERE expires_at<=?1').bind(now),
    env.DB.prepare('INSERT INTO cafe_admin_sessions(token_hash,created_at,expires_at) VALUES(?1,?2,?3)')
      .bind(await sha256(token), now, now + SESSION_SECONDS),
  ]);
  return json({ authenticated: true }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_SECONDS) });
}

async function logout(request, env) {
  checkOrigin(request);
  const token = cookieValue(request);
  if (token) await env.DB.prepare('DELETE FROM cafe_admin_sessions WHERE token_hash=?1').bind(await sha256(token)).run();
  return json({ authenticated: false }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function listKitchenOrders(env) {
  const orders = (await env.DB.prepare(`SELECT id,order_number,customer_name,service_type,table_number,
    note,status,total_paise,created_at,updated_at FROM cafe_orders
    ORDER BY CASE WHEN status IN ('RECEIVED','PREPARING','READY') THEN 0 ELSE 1 END,
      created_at DESC LIMIT 200`).all()).results || [];
  if (!orders.length) return json({ orders: [] });
  const placeholders = orders.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT order_id,item_id,name,category,quantity,unit_price_paise,
    total_paise,options_json FROM cafe_order_items WHERE order_id IN (${placeholders}) ORDER BY line_no`)
    .bind(...orders.map(order => order.id)).all()).results || [];
  const byOrder = new Map(orders.map(order => [order.id, []]));
  for (const row of rows) byOrder.get(row.order_id)?.push(formatItem(row));
  for (const order of orders) {
    order.created_at = asUtc(order.created_at);
    order.updated_at = asUtc(order.updated_at);
    order.items = byOrder.get(order.id);
  }
  return json({ orders });
}

async function setKitchenStatus(request, env, id) {
  checkOrigin(request);
  const body = await readJson(request, 2_000);
  const next = cleanText(body.status, 'status', 20);
  const allowedFrom = {
    PREPARING: ['RECEIVED'],
    READY: ['PREPARING'],
    COMPLETED: ['READY'],
    CANCELLED: ['RECEIVED', 'PREPARING'],
  }[next];
  if (!allowedFrom) throw new HttpError('Invalid status');
  const placeholders = allowedFrom.map(() => '?').join(',');
  const result = await env.DB.prepare(`UPDATE cafe_orders SET status=?1,updated_at=CURRENT_TIMESTAMP
    WHERE id=?2 AND status IN (${placeholders})`).bind(next, id, ...allowedFrom).run();
  if (!result.meta?.changes) {
    const current = await env.DB.prepare('SELECT status FROM cafe_orders WHERE id=?1').bind(id).first();
    throw new HttpError(current ? `Order is already ${current.status.toLowerCase()}` : 'Order not found', current ? 409 : 404);
  }
  return json({ id, status: next });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/cafe/health' && request.method === 'GET') return json({ ok: true, service: 'frostflow-cafe' });
  if (path === '/api/cafe/menu' && request.method === 'GET') {
    return json({ currency: menu.currency, categories: menu.categories, optionGroups: menu.optionGroups });
  }
  if (path === '/api/cafe/orders' && request.method === 'POST') return createOrder(request, env);
  const track = path.match(/^\/api\/cafe\/orders\/([a-f0-9]{48})$/i);
  if (track && request.method === 'GET') return trackOrder(track[1], env);
  if (path === '/api/cafe/admin/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/cafe/admin/logout' && request.method === 'POST') return logout(request, env);
  if (path === '/api/cafe/admin/session' && request.method === 'GET') {
    return await sessionRow(request, env) ? json({ authenticated: true }) : json({ authenticated: false }, 401);
  }
  if (path.startsWith('/api/cafe/admin/')) {
    await requireAdmin(request, env);
    if (path === '/api/cafe/admin/orders' && request.method === 'GET') return listKitchenOrders(env);
    const status = path.match(/^\/api\/cafe\/admin\/orders\/([a-f0-9-]{36})\/status$/i);
    if (status && request.method === 'POST') return setKitchenStatus(request, env, status[1]);
  }
  if (path.startsWith('/api/')) throw new HttpError('Endpoint not found', 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError('Method not allowed', 405);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Café request failed', error);
      return json({ error: 'Request failed safely. Please try again.' }, 500);
    }
  },
};

export { priceItem, checkOrigin, orderDateKey, equalSecret };
