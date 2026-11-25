'use strict';

const { inTransaction } = require('../db');
const { AppError, clean, nonNegativeWhole, businessToday } = require('../domain');
const { ProductUnits } = require('./product-units');

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(entry => entry.name === column);
}

function short(value, label, max = 250) {
  const result = clean(value);
  if (result.length > max) throw new AppError(`${label} is too long.`);
  return result;
}

function quantity(value, label = 'Quantity', allowZero = false) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') {
    if (allowZero && value === null) return null;
    throw new AppError(`${label} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < (allowZero ? 0 : 0.001) || number > 100000 || Math.abs(number * 1000 - Math.round(number * 1000)) > 0.000001)
    throw new AppError(`${label} must be a positive number of 1,000th units or less.`);
  return number;
}

function money(value, label = 'Price') {
  const number = nonNegativeWhole(value, label);
  if (number > 1000000000) throw new AppError(`${label} is too large.`);
  return number;
}

function amount(quantityValue, pricePaise) {
  const mills = BigInt(Math.round(quantityValue * 1000));
  const paise = (mills * BigInt(pricePaise) + 500n) / 1000n;
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('Line amount is too large.');
  return Number(paise);
}

function taxAmount(subtotalPaise, gstBps) {
  return Number((BigInt(subtotalPaise) * BigInt(gstBps) + 5000n) / 10000n);
}

function json(value) { return JSON.stringify(value ?? {}); }

function categoryId(name) {
  return String(name || 'Other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

function amulCategory(name) {
  const value = String(name || '').toLowerCase();
  if (/samosa|patty|patties|fries|nugget|momo|pizza|paratha|snack|hash brown/.test(value)) return 'Frozen Snacks';
  if (/butter|cheese|paneer|milk|curd|dahi|lassi|ghee|chaas|yogurt|cream cheese|milk powder/.test(value)) return 'Dairy';
  if (/ice.?cream|tricone|tricon|kulfi|frostik|chocobar|choco bar|ice lolly|sundae|family pack|ice candy|\bcup\b|\btub\b|\bbrick\b|\bcone\b|\bstick\b/.test(value)) return 'Ice Cream';
  return 'Other';
}

class WholesalePicking {
  constructor(db) {
    this.db = db;
    this.unitsService = new ProductUnits(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS wholesale_pick_orders (
        id INTEGER PRIMARY KEY,
        order_number TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK(source IN ('PHONE','ONLINE')),
        source_ref TEXT UNIQUE,
        customer_key TEXT,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        gstin TEXT NOT NULL DEFAULT '',
        route_name TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','PICKING','HOLD','READY','DRAFTED')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wholesale_pick_orders_status ON wholesale_pick_orders(status,created_at DESC);
      CREATE TABLE IF NOT EXISTS wholesale_pick_lines (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES wholesale_pick_orders(id) ON DELETE CASCADE,
        product_key TEXT NOT NULL,
        product_name TEXT NOT NULL,
        sku TEXT NOT NULL DEFAULT '',
        requested_quantity REAL NOT NULL CHECK(requested_quantity > 0),
        picked_quantity REAL CHECK(picked_quantity IS NULL OR picked_quantity >= 0),
        unit_code TEXT NOT NULL DEFAULT 'BASE',
        unit_label TEXT NOT NULL DEFAULT 'PC',
        unit_factor INTEGER NOT NULL DEFAULT 1 CHECK(unit_factor > 0),
        unit_price_paise INTEGER NOT NULL DEFAULT 0 CHECK(unit_price_paise >= 0),
        gst_bps INTEGER NOT NULL DEFAULT 0 CHECK(gst_bps BETWEEN 0 AND 10000),
        shortage_reason TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL,
        UNIQUE(order_id,sort_order)
      );
      CREATE INDEX IF NOT EXISTS idx_wholesale_pick_lines_order ON wholesale_pick_lines(order_id,sort_order);
      CREATE TABLE IF NOT EXISTS wholesale_invoice_drafts (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL UNIQUE REFERENCES wholesale_pick_orders(id),
        draft_number TEXT NOT NULL UNIQUE,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        gstin TEXT NOT NULL DEFAULT '',
        subtotal_paise INTEGER NOT NULL,
        tax_paise INTEGER NOT NULL,
        total_paise INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS wholesale_invoice_draft_lines (
        id INTEGER PRIMARY KEY,
        draft_id INTEGER NOT NULL REFERENCES wholesale_invoice_drafts(id) ON DELETE CASCADE,
        product_name TEXT NOT NULL,
        sku TEXT NOT NULL DEFAULT '',
        quantity REAL NOT NULL CHECK(quantity > 0),
        unit_label TEXT NOT NULL,
        unit_price_paise INTEGER NOT NULL CHECK(unit_price_paise > 0),
        gst_bps INTEGER NOT NULL,
        subtotal_paise INTEGER NOT NULL,
        tax_paise INTEGER NOT NULL,
        total_paise INTEGER NOT NULL,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wholesale_pick_audit (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES wholesale_pick_orders(id),
        action TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  audit(orderId, action, details = {}) {
    this.db.prepare('INSERT INTO wholesale_pick_audit(order_id,action,details_json) VALUES(?,?,?)')
      .run(orderId, action, json(details));
  }

  unitChoices(source, id, fallback = 'PC') {
    try {
      return this.unitsService.list(source, id).filter(unit => Number.isSafeInteger(unit.factor) && unit.factor > 0)
        .map(unit => ({ code: String(unit.code), label: String(unit.label), factor: unit.factor }));
    } catch {
      // A newly installed local app can browse its product cache before the
      // Amul UOM data has completed its first sync.
      return [{ code: 'BASE', label: fallback, factor: 1 }];
    }
  }

  product(key) {
    const match = /^([A-Z]+):(.+)$/.exec(String(key || ''));
    if (!match || !['AMUL','LOCAL'].includes(match[1])) throw new AppError('Select a product from the catalogue.');
    const [, source, id] = match;
    if (source === 'AMUL') {
      if (!tableExists(this.db, 'amul_products_local')) throw new AppError('The Amul product sync is not ready.', 409);
      const row = this.db.prepare('SELECT * FROM amul_products_local WHERE product_id=? AND active=1').get(id);
      if (!row) throw new AppError('The selected Amul product is unavailable.', 404);
      const category = amulCategory(row.product_name);
      return { key, source, id, name: row.product_name || row.sku || id, sku: row.sku || row.code || '',
        category, categoryId: categoryId(category),
        pricePaise: money(row.selling_price_paise || 0), stockQty: Number(row.stock_qty || 0), gstBps: 0,
        units: this.unitChoices(source, id, 'PC') };
    }
    const row = this.db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
    if (!row) throw new AppError('The selected local product is unavailable.', 404);
    const stock = this.db.prepare('SELECT COALESCE(SUM(quantity_available),0) qty FROM inventory_batches WHERE product_id=?').get(id);
    const category = row.category || 'Other';
    return { key, source, id, name: row.name, sku: row.sku || '', category, categoryId: categoryId(category),
      pricePaise: money(row.wholesale_price_paise || 0),
      stockQty: Number(stock?.qty || 0), gstBps: Number(row.gst_bps || 0), units: this.unitChoices(source, id, row.unit || 'PCS') };
  }

  basicCatalogRows() {
    const rows = [];
    if (tableExists(this.db, 'amul_products_local')) {
      for (const product of this.db.prepare('SELECT product_id,product_name,sku,code,barcode FROM amul_products_local WHERE active=1 ORDER BY product_name').all()) {
        const category = amulCategory(product.product_name);
        rows.push({ key: `AMUL:${product.product_id}`, name: product.product_name || product.sku || product.product_id,
          sku: product.sku || product.code || '', barcode: product.barcode || '', category, categoryId: categoryId(category) });
      }
    }
    for (const product of this.db.prepare('SELECT id,name,sku,barcode,category FROM products WHERE active=1 ORDER BY name').all()) {
      const category = product.category || 'Other';
      rows.push({ key: `LOCAL:${product.id}`, name: product.name, sku: product.sku || '',
        barcode: product.barcode || '', category, categoryId: categoryId(category) });
    }
    return rows;
  }

  categories() {
    const counts = new Map();
    for (const item of this.basicCatalogRows()) {
      const current = counts.get(item.categoryId);
      counts.set(item.categoryId, { id: item.categoryId, name: item.category, count: (current?.count || 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  catalog(query = '', category = '', offset = 0) {
    const q = short(query, 'Product search', 100);
    const selected = short(category, 'Category', 100);
    const start = nonNegativeWhole(offset, 'Catalogue offset');
    if (start > 100000) throw new AppError('Catalogue offset is too large.');
    const needle = q.toLocaleLowerCase();
    const matched = this.basicCatalogRows().filter(item =>
      (!selected || item.categoryId === selected) &&
      (!needle || `${item.name} ${item.sku} ${item.barcode}`.toLocaleLowerCase().includes(needle)));
    matched.sort((a, b) => {
      const exactA = needle && (a.sku.toLocaleLowerCase() === needle || a.barcode.toLocaleLowerCase() === needle) ? 0 : 1;
      const exactB = needle && (b.sku.toLocaleLowerCase() === needle || b.barcode.toLocaleLowerCase() === needle) ? 0 : 1;
      return exactA - exactB || a.name.localeCompare(b.name);
    });
    return matched.slice(start, start + 60).map(item => this.product(item.key));
  }

  customers(query = '') {
    const q = short(query, 'Customer search', 100);
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const result = [];
    if (tableExists(this.db, 'amul_retailers')) {
      const notDeleted = columnExists(this.db, 'amul_retailers', 'local_deleted') ? 'AND local_deleted=0' : '';
      const rows = this.db.prepare(`SELECT * FROM amul_retailers WHERE active=1 ${notDeleted} AND
        (retailer_name LIKE ? ESCAPE '\\' OR retailer_code LIKE ? ESCAPE '\\' OR mobile LIKE ? ESCAPE '\\')
        ORDER BY retailer_name LIMIT 30`).all(pattern, pattern, pattern);
      for (const row of rows) result.push({ key: `AMUL:${row.retailer_id}`, name: row.retailer_name,
        code: row.retailer_code || '', phone: row.mobile || '', address: row.address || '',
        gstin: row.gstin || '', routeName: row.route_name || '' });
    }
    const rows = this.db.prepare(`SELECT * FROM parties WHERE active=1 AND party_type IN ('CUSTOMER','BOTH') AND
      (name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR mobile LIKE ? ESCAPE '\\')
      ORDER BY name LIMIT 30`).all(pattern, pattern, pattern);
    for (const row of rows) result.push({ key: `LOCAL:${row.id}`, name: row.name, code: row.code || '',
      phone: row.mobile || '', address: row.address || '', gstin: row.gstin || '', routeName: '' });
    return result.slice(0, 40);
  }

  customer(key) {
    const match = /^([A-Z]+):(.+)$/.exec(String(key || ''));
    if (!match || !['AMUL','LOCAL'].includes(match[1])) throw new AppError('Select a customer from the list.');
    const [, source, id] = match;
    if (source === 'AMUL') {
      if (!tableExists(this.db, 'amul_retailers')) throw new AppError('Customer sync is not ready.', 409);
      const notDeleted = columnExists(this.db, 'amul_retailers', 'local_deleted') ? 'AND local_deleted=0' : '';
      const row = this.db.prepare(`SELECT * FROM amul_retailers WHERE retailer_id=? AND active=1 ${notDeleted}`).get(id);
      if (!row) throw new AppError('The selected retailer is unavailable.', 404);
      return { key, name: row.retailer_name, phone: row.mobile || '', address: row.address || '',
        gstin: row.gstin || '', routeName: row.route_name || '' };
    }
    const row = this.db.prepare("SELECT * FROM parties WHERE id=? AND active=1 AND party_type IN ('CUSTOMER','BOTH')").get(id);
    if (!row) throw new AppError('The selected customer is unavailable.', 404);
    return { key, name: row.name, phone: row.mobile || '', address: row.address || '', gstin: row.gstin || '', routeName: '' };
  }

  insertOrder(header, items) {
    const result = this.db.prepare(`INSERT INTO wholesale_pick_orders
      (order_number,source,source_ref,customer_key,customer_name,phone,address,gstin,route_name,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('', header.source, header.sourceRef || null, header.customerKey || null,
      header.customerName, header.phone || '', header.address || '', header.gstin || '', header.routeName || '', header.notes || '');
    const id = Number(result.lastInsertRowid);
    const orderNumber = header.orderNumber || `WO-${businessToday().replaceAll('-', '')}-${String(id).padStart(5, '0')}`;
    this.db.prepare('UPDATE wholesale_pick_orders SET order_number=? WHERE id=?').run(orderNumber, id);
    const addLine = this.db.prepare(`INSERT INTO wholesale_pick_lines
      (order_id,product_key,product_name,sku,requested_quantity,picked_quantity,unit_code,unit_label,unit_factor,unit_price_paise,gst_bps,shortage_reason,sort_order)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    items.forEach((item, index) => addLine.run(id, item.productKey, item.name, item.sku || '', item.requestedQuantity,
      item.pickedQuantity ?? null, item.unitCode || 'BASE', item.unitLabel || 'PC', item.unitFactor || 1,
      item.unitPricePaise || 0, item.gstBps || 0, item.shortageReason || '', index + 1));
    this.audit(id, 'CREATE', { source: header.source, sourceRef: header.sourceRef || null, lineCount: items.length });
    return this.detail(id);
  }

  createOrder(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Enter an order.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 150) throw new AppError('Add 1 to 150 order items.');
    const selected = body.customerKey ? this.customer(body.customerKey) : null;
    const customerName = short(selected?.name || body.customerName, 'Customer name', 150);
    if (!customerName) throw new AppError('Customer name is required.');
    const header = { source: 'PHONE', customerKey: selected?.key || '', customerName,
      phone: short(selected?.phone || body.phone, 'Phone', 30), address: short(selected?.address || body.address, 'Address', 500),
      gstin: short(selected?.gstin || body.gstin, 'GSTIN', 30), routeName: short(selected?.routeName || body.routeName, 'Route', 150),
      notes: short(body.notes, 'Notes', 1000) };
    const items = body.items.map(raw => {
      const product = this.product(raw.productKey);
      const unit = product.units.find(option => option.code === (raw.unitCode || 'BASE'));
      if (!unit) throw new AppError(`Choose a current unit for ${product.name}.`);
      const requestedQuantity = quantity(raw.quantity, 'Requested quantity');
      if (Math.abs(requestedQuantity * unit.factor - Math.round(requestedQuantity * unit.factor)) > 0.000001)
        throw new AppError(`${product.name} must use a whole number of stock units.`);
      const unitPricePaise = raw.unitPricePaise === undefined
        ? money(product.pricePaise * unit.factor) : money(raw.unitPricePaise);
      return { productKey: product.key, name: product.name, sku: product.sku,
        requestedQuantity, pickedQuantity: null, unitCode: unit.code, unitLabel: unit.label,
        unitFactor: unit.factor, unitPricePaise, gstBps: product.gstBps };
    });
    return inTransaction(this.db, () => this.insertOrder(header, items));
  }

  importInbox() {
    if (!tableExists(this.db, 'whatsapp_order_requests')) return { imported: 0, skipped: 0, orders: this.list() };
    const rows = this.db.prepare("SELECT message_id,payload FROM whatsapp_order_requests WHERE message_id LIKE 'cloud:%' ORDER BY received_at").all();
    let imported = 0, skipped = 0;
    for (const row of rows) {
      if (this.db.prepare('SELECT id FROM wholesale_pick_orders WHERE source_ref=?').get(row.message_id)) { skipped++; continue; }
      let order;
      try { order = JSON.parse(row.payload); } catch { skipped++; continue; }
      if (!order || !Array.isArray(order.lines) || !order.lines.length) { skipped++; continue; }
      const items = [];
      for (const line of order.lines) {
        const factor = Number(line.units_per_box || 1);
        const rawUnit = String(line.requested_unit || line.unit || 'PC').toUpperCase();
        const unitFactor = rawUnit === 'BOX' && Number.isSafeInteger(factor) && factor > 1 ? factor : 1;
        const requestedQuantity = quantity(line.requested_quantity ?? line.quantity / unitFactor, 'Requested quantity');
        const pricePaise = money(line.price_paise || 0);
        const key = String(line.product_id || '');
        const productKey = /^(AMUL|LOCAL|CUSTOM):/.test(key) ? key : `AMUL:${key}`;
        items.push({ productKey, name: short(line.product_name, 'Product name', 200) || key,
          sku: String(line.sku || ''), requestedQuantity, pickedQuantity: null,
          unitCode: unitFactor > 1 ? 'BOX' : 'BASE', unitLabel: unitFactor > 1 ? 'BOX' : rawUnit,
          unitFactor, unitPricePaise: money(pricePaise * unitFactor),
          gstBps: nonNegativeWhole(line.gst_bps || 0, 'GST rate') });
      }
      const header = { source: 'ONLINE', sourceRef: row.message_id,
        orderNumber: short(order.order_number, 'Online order number', 100) || undefined,
        customerKey: short(order.customer_id, 'Customer ID', 100),
        customerName: short(order.customer_name, 'Customer name', 150) || 'Online customer',
        phone: short(order.phone, 'Phone', 30), address: short(order.address, 'Address', 500),
        gstin: short(order.gstin, 'GSTIN', 30), routeName: short(order.route_name, 'Route', 150),
        notes: short(order.note, 'Notes', 1000) };
      try { inTransaction(this.db, () => this.insertOrder(header, items)); imported++; }
      catch (error) { if (String(error.message).includes('UNIQUE')) skipped++; else throw error; }
    }
    return { imported, skipped, orders: this.list() };
  }

  list() {
    return this.db.prepare(`SELECT o.id,o.order_number orderNumber,o.source,o.source_ref sourceRef,
      o.customer_name customerName,o.phone,o.status,o.created_at createdAt,
      (SELECT COUNT(*) FROM wholesale_pick_lines l WHERE l.order_id=o.id) lineCount,
      (SELECT COUNT(*) FROM wholesale_pick_lines l WHERE l.order_id=o.id AND l.picked_quantity IS NOT NULL) checkedCount,
      (SELECT id FROM wholesale_invoice_drafts d WHERE d.order_id=o.id) draftId
      FROM wholesale_pick_orders o ORDER BY o.created_at DESC,o.id DESC LIMIT 500`).all();
  }

  detail(id) {
    const orderId = nonNegativeWhole(id, 'Order');
    const row = this.db.prepare(`SELECT o.id,o.order_number orderNumber,o.source,o.source_ref sourceRef,o.customer_key customerKey,
      o.customer_name customerName,o.phone,o.address,o.gstin,o.route_name routeName,o.notes,o.status,
      o.created_at createdAt,o.updated_at updatedAt,
      (SELECT id FROM wholesale_invoice_drafts d WHERE d.order_id=o.id) draftId
      FROM wholesale_pick_orders o WHERE o.id=?`).get(orderId);
    if (!row) throw new AppError('Order not found.', 404);
    row.lines = this.db.prepare(`SELECT id,product_key productKey,product_name name,sku,
      requested_quantity requestedQuantity,picked_quantity pickedQuantity,
      unit_code unitCode,unit_label unitLabel,unit_factor unitFactor,
      unit_price_paise unitPricePaise,gst_bps gstBps,shortage_reason shortageReason
      FROM wholesale_pick_lines WHERE order_id=? ORDER BY sort_order`).all(orderId);
    return row;
  }

  setPicked(orderId, lineId, body) {
    return inTransaction(this.db, () => {
      const order = this.detail(orderId);
      if (order.status === 'DRAFTED') throw new AppError('This invoice draft is already locked.', 409);
      if (order.status === 'HOLD') throw new AppError('Resume this order before picking.', 409);
      const line = order.lines.find(item => item.id === nonNegativeWhole(lineId, 'Line'));
      if (!line) throw new AppError('Order line not found.', 404);
      const picked = body?.pickedQuantity === null ? null : quantity(body?.pickedQuantity, 'Picked quantity', true);
      if (picked !== null && picked > line.requestedQuantity + 0.000001) throw new AppError('Picked quantity exceeds the order.', 409);
      const shortageReason = short(body?.shortageReason, 'Shortage reason', 250);
      if (picked !== null && picked < line.requestedQuantity && !shortageReason)
        throw new AppError('Enter a reason for a partial or missing item.');
      const price = body?.unitPricePaise === undefined ? line.unitPricePaise : money(body.unitPricePaise);
      this.db.prepare(`UPDATE wholesale_pick_lines SET picked_quantity=?,shortage_reason=?,unit_price_paise=? WHERE id=?`)
        .run(picked, picked === null ? '' : shortageReason, price, line.id);
      this.db.prepare("UPDATE wholesale_pick_orders SET status='PICKING',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id);
      this.audit(order.id, 'PICK', { lineId: line.id, pickedQuantity: picked, requestedQuantity: line.requestedQuantity,
        shortageReason: picked === null ? '' : shortageReason, priceChanged: price !== line.unitPricePaise });
      return this.detail(order.id);
    });
  }

  setStatus(id, status) {
    return inTransaction(this.db, () => {
      const order = this.detail(id);
      const next = String(status || '').toUpperCase();
      if (order.status === 'DRAFTED') throw new AppError('This order has a locked invoice draft.', 409);
      if (!['HOLD','PICKING','READY'].includes(next)) throw new AppError('Choose Hold, Picking or Ready.');
      if (next === 'READY') {
        if (order.lines.some(line => line.pickedQuantity === null)) throw new AppError('Check every item before marking the order ready.');
        if (!order.lines.some(line => line.pickedQuantity > 0)) throw new AppError('Pick at least one item before making an invoice draft.');
      }
      this.db.prepare('UPDATE wholesale_pick_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, order.id);
      this.audit(order.id, 'STATUS', { from: order.status, to: next });
      return this.detail(order.id);
    });
  }

  createDraft(id) {
    return inTransaction(this.db, () => {
      const order = this.detail(id);
      if (order.draftId) return this.draft(order.draftId);
      if (order.status !== 'READY') throw new AppError('Finish the checklist and mark the order ready first.', 409);
      const picked = order.lines.filter(line => line.pickedQuantity > 0);
      if (!picked.length) throw new AppError('Pick at least one item.', 409);
      if (picked.some(line => !line.unitPricePaise)) throw new AppError('Set a price for every picked item before making the draft.', 409);
      const rows = picked.map(line => {
        const subtotalPaise = amount(line.pickedQuantity, line.unitPricePaise);
        const taxPaise = taxAmount(subtotalPaise, line.gstBps);
        return { ...line, quantity: line.pickedQuantity, subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
      });
      const subtotalPaise = rows.reduce((total, line) => total + line.subtotalPaise, 0);
      const taxPaise = rows.reduce((total, line) => total + line.taxPaise, 0);
      const totalPaise = subtotalPaise + taxPaise;
      if (![subtotalPaise,taxPaise,totalPaise].every(Number.isSafeInteger)) throw new AppError('Draft amount is too large.');
      const result = this.db.prepare(`INSERT INTO wholesale_invoice_drafts
        (order_id,draft_number,customer_name,phone,address,gstin,subtotal_paise,tax_paise,total_paise)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(order.id, `DRAFT-${String(order.id).padStart(5, '0')}`, order.customerName,
          order.phone, order.address, order.gstin, subtotalPaise, taxPaise, totalPaise);
      const draftId = Number(result.lastInsertRowid);
      const addLine = this.db.prepare(`INSERT INTO wholesale_invoice_draft_lines
        (draft_id,product_name,sku,quantity,unit_label,unit_price_paise,gst_bps,subtotal_paise,tax_paise,total_paise,sort_order)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach((line, index) => addLine.run(draftId, line.name, line.sku, line.quantity,
        line.unitLabel, line.unitPricePaise, line.gstBps, line.subtotalPaise, line.taxPaise, line.totalPaise, index + 1));
      this.db.prepare("UPDATE wholesale_pick_orders SET status='DRAFTED',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id);
      this.audit(order.id, 'DRAFT', { draftId, pickedLines: rows.length, totalPaise });
      return this.draft(draftId);
    });
  }

  draft(id) {
    const draftId = nonNegativeWhole(id, 'Draft');
    const row = this.db.prepare(`SELECT d.id,d.draft_number draftNumber,d.order_id orderId,
      o.order_number orderNumber,o.source,d.customer_name customerName,d.phone,d.address,d.gstin,
      o.route_name routeName,o.notes,d.created_at createdAt,
      d.subtotal_paise subtotalPaise,d.tax_paise taxPaise,d.total_paise totalPaise
      FROM wholesale_invoice_drafts d JOIN wholesale_pick_orders o ON o.id=d.order_id WHERE d.id=?`).get(draftId);
    if (!row) throw new AppError('Invoice draft not found.', 404);
    row.lines = this.db.prepare(`SELECT product_name name,sku,quantity,unit_label unitLabel,
      unit_price_paise unitPricePaise,gst_bps gstBps,
      subtotal_paise subtotalPaise,tax_paise taxPaise,total_paise totalPaise
      FROM wholesale_invoice_draft_lines WHERE draft_id=? ORDER BY sort_order`).all(draftId);
    const config = Object.fromEntries(this.db.prepare("SELECT key,value FROM settings WHERE key IN ('company_name','company_gstin','company_address','company_phone')")
      .all().map(item => [item.key, item.value]));
    const taxReviewNeeded = !!this.db.prepare(`SELECT 1 FROM wholesale_pick_lines
      WHERE order_id=? AND picked_quantity>0 AND product_key LIKE 'AMUL:%' AND gst_bps=0 LIMIT 1`).get(row.orderId);
    const companyName = clean(config.company_name);
    Object.assign(row, { companyName: !companyName || companyName === 'My Ice Cream Business' ? 'MR ENTERPRISES' : companyName,
      companyGstin: config.company_gstin || '',
      companyAddress: config.company_address || '', companyPhone: config.company_phone || '',
      taxReviewNeeded, status: 'DRAFT', notice: 'INVOICE DRAFT - NOT POSTED TO THE BILLING DATABASE. Confirm prices and tax in the billing system.' });
    return row;
  }
}

module.exports = { WholesalePicking };
