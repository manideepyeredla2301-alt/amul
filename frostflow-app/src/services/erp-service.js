const fs = require('node:fs');
const path = require('node:path');
const { inTransaction, DB_PATH, DATA_DIR } = require('../db');
const { AppError, clean, whole, nonNegativeWhole, safeAmount, paise, dateOnly, addDays, businessToday, rate, multiply, sum, proportional, paymentMethod } = require('../domain');
const json = (value) => JSON.stringify(value ?? {});
const {ProductUnits}=require('./product-units');

class ERPService {
  constructor(db) {
    this.db = db;
    this.units=new ProductUnits(db);
    if(!db.prepare('PRAGMA table_info(invoice_items)').all().some(c=>c.name==='unit_details'))db.exec("ALTER TABLE invoice_items ADD COLUMN unit_details TEXT NOT NULL DEFAULT '{}'");
    this.migrateAllocations();
  }

  audit(action, entityType, entityId, metadata = {}, actor = 'Owner') {
    this.db.prepare(`INSERT INTO audit_log (actor, action, entity_type, entity_id, metadata_json)
      VALUES (?, ?, ?, ?, ?)`).run(actor, action, entityType, entityId ?? null, json(metadata));
  }

  setting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  }

  nextDocument(prefixKey, table, column, date) {
    const prefix = this.setting(prefixKey) || prefixKey.toUpperCase();
    const day = String(date).replaceAll('-', '');
    const pattern = `${prefix}-${day}-%`;
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`).get(pattern).count;
    return `${prefix}-${day}-${String(Number(count) + 1).padStart(4, '0')}`;
  }

  getProduct(id) {
    const product = this.db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(id));
    if (!product) throw new AppError('The selected product is unavailable.', 404, 'PRODUCT_NOT_FOUND');
    return product;
  }

  getParty(id, expected) {
    const party = this.db.prepare('SELECT * FROM parties WHERE id = ? AND active = 1').get(Number(id));
    if (!party) throw new AppError('The selected customer or supplier is unavailable.', 404, 'PARTY_NOT_FOUND');
    if (expected && party.party_type !== expected && party.party_type !== 'BOTH') {
      throw new AppError(`The selected party is not a ${expected.toLowerCase()}.`);
    }
    return party;
  }

  taxAmounts(taxablePaise, gstBps, party) {
    const tax = proportional(taxablePaise, rate(gstBps), 10000);
    const intraState = !party || party.state_code === this.setting('company_state_code');
    return intraState
      ? { cgst: Math.floor(tax / 2), sgst: tax - Math.floor(tax / 2), igst: 0 }
      : { cgst: 0, sgst: 0, igst: tax };
  }

  createProduct(input) {
    return inTransaction(this.db, () => {
    const sku = clean(input.sku).toUpperCase();
    const name = clean(input.name);
    if (!sku || !name) throw new AppError('SKU and product name are required.');
    const values = [
      sku, clean(input.barcode) || null, name, clean(input.brand) || null,
      clean(input.category) || 'Ice Cream', clean(input.unit) || 'PCS', clean(input.hsnCode) || null,
      rate(input.gstBps ?? 1800), paise(input.retailPrice ?? 0, 'Retail price'),
      paise(input.wholesalePrice ?? 0, 'Wholesale price'), nonNegativeWhole(input.reorderLevel ?? 0, 'Reorder level'),
      paise(input.purchasePrice ?? 0, 'Purchase price'),
    ];
    try {
      const result = this.db.prepare(`INSERT INTO products
        (sku, barcode, name, brand, category, unit, hsn_code, gst_bps, retail_price_paise, wholesale_price_paise, reorder_level, purchase_price_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(...values);
      this.db.prepare('UPDATE products SET mrp_paise=? WHERE id=?').run(paise(input.mrpPrice ?? 0,'MRP'),result.lastInsertRowid);
      this.audit('CREATE', 'PRODUCT', Number(result.lastInsertRowid), { sku, name, values, mrp:input.mrpPrice ?? 0 });
      return this.getProduct(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new AppError('SKU and barcode must be unique.');
      throw error;
    }
    });
  }

  importAmulProducts() {
    return inTransaction(this.db, () => {
      const rows = this.db.prepare('SELECT * FROM amul_products_local WHERE active=1 ORDER BY product_name').all();
      const insert = this.db.prepare(`INSERT INTO products (sku,barcode,name,brand,category,unit,hsn_code,gst_bps,retail_price_paise,wholesale_price_paise,reorder_level,purchase_price_paise,mrp_paise) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let imported=0, skipped=0;
      for(const p of rows){
        const sku=String(p.sku || p.code || ('AMUL-'+p.product_id)).trim().toUpperCase();
        if(this.db.prepare('SELECT id FROM products WHERE sku=? OR (barcode IS NOT NULL AND barcode=? )').get(sku,p.barcode || null)){skipped++;continue;}
        insert.run(sku,p.barcode || null,p.product_name || sku,'Amul','Ice Cream','PCS','2105',1800,p.mrp_paise || p.selling_price_paise || 0,p.selling_price_paise || 0,0,0,p.mrp_paise || 0); imported++;
      }
      this.audit('IMPORT','PRODUCTS',null,{source:'AMUL',imported,skipped});
      return {imported,skipped,total:rows.length};
    });
  }

  importAmulStock() {
    return inTransaction(this.db, () => {
      const rows=this.db.prepare(`SELECT i.*,p.sku,p.barcode FROM amul_inventory_local i JOIN amul_products_local p ON p.product_id=i.product_id WHERE i.stock_qty>0`).all();
      let imported=0,skipped=0;
      for(const r of rows){const product=this.db.prepare('SELECT id,purchase_price_paise FROM products WHERE sku=? OR (barcode IS NOT NULL AND barcode=?)').get(String(r.sku||'').toUpperCase(),r.barcode||null);if(!product){skipped++;continue;}const batch=String(r.batch_code||('AMUL-'+r.batch_id));const expiry=r.expiry_date||null;const cost=product.purchase_price_paise||0;const old=this.db.prepare('SELECT id FROM inventory_batches WHERE product_id=? AND batch_number=? AND expiry_date IS ?').get(product.id,batch,expiry);if(old){this.db.prepare('UPDATE inventory_batches SET quantity_available=?,quantity_received=? WHERE id=?').run(Math.max(0,Number(r.stock_qty)),Math.max(0,Number(r.stock_qty)),old.id);}else{this.db.prepare('INSERT INTO inventory_batches(product_id,batch_number,expiry_date,cost_paise,quantity_received,quantity_available,source_document) VALUES(?,?,?,?,?,?,?)').run(product.id,batch,expiry,cost,Number(r.stock_qty),Number(r.stock_qty),'AMUL_SYNC');}imported++;}
      this.audit('IMPORT','INVENTORY',null,{source:'AMUL',imported,skipped});return {imported,skipped,total:rows.length};
    });
  }

  updateProduct(id, input) {
    return inTransaction(this.db, () => {
      const before = this.getProduct(id);
      const fields = { sku: 'sku', barcode: 'barcode', name: 'name', brand: 'brand', category: 'category', unit: 'unit', hsnCode: 'hsn_code', gstBps: 'gst_bps', reorderLevel: 'reorder_level', purchasePrice: 'purchase_price_paise', wholesalePrice: 'wholesale_price_paise', retailPrice: 'retail_price_paise' };
      const updates = {};
      if(input.mrpPrice!==undefined) updates.mrp_paise=paise(input.mrpPrice,'MRP');
      for (const [key, column] of Object.entries(fields)) {
        if (input[key] === undefined) continue;
        let value = /Price$/.test(key) ? paise(input[key], key) : key === 'gstBps' ? rate(input[key]) : key === 'reorderLevel' ? nonNegativeWhole(input[key], 'Reorder level') : clean(input[key]);
        if (key === 'sku') value = value.toUpperCase();
        if (['sku','name','category','unit'].includes(key) && !value) throw new AppError(`${key} cannot be blank.`);
        updates[column] = value === '' ? null : value;
      }
      if (!Object.keys(updates).length) throw new AppError('No product changes were supplied.');
      try {
        this.db.prepare(`UPDATE products SET ${Object.keys(updates).map((key) => `${key} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(updates), before.id);
      } catch (error) { if (String(error.message).includes('UNIQUE')) throw new AppError('SKU and barcode must be unique.'); throw error; }
      const after = this.getProduct(before.id);
      this.audit('UPDATE', 'PRODUCT', before.id, { before, after });
      return after;
    });
  }

  listProducts() {
    const today = businessToday();
    return this.db.prepare(`SELECT p.*, COALESCE(SUM(b.quantity_available), 0) AS stock_qty,
      COALESCE(SUM(CASE WHEN (b.expiry_date IS NULL OR b.expiry_date >= ?) AND p.active = 1 THEN b.quantity_available ELSE 0 END),0) AS saleable_qty,
      COALESCE(SUM(CASE WHEN b.expiry_date < ? THEN b.quantity_available ELSE 0 END),0) AS expired_qty,
      COALESCE(SUM(b.quantity_available * b.cost_paise), 0) AS stock_value_paise,
      COALESCE(SUM(b.quantity_available * p.wholesale_price_paise),0) AS wholesale_value_paise,
      COALESCE(SUM(b.quantity_available * p.retail_price_paise),0) AS retail_value_paise,
      COALESCE(SUM(CASE WHEN (b.expiry_date IS NULL OR b.expiry_date >= ?) AND p.active = 1 THEN b.quantity_available * b.cost_paise ELSE 0 END),0) AS saleable_cost_value_paise,
      COALESCE(SUM(CASE WHEN (b.expiry_date IS NULL OR b.expiry_date >= ?) AND p.active = 1 THEN b.quantity_available * p.wholesale_price_paise ELSE 0 END),0) AS saleable_wholesale_value_paise,
      COALESCE(SUM(CASE WHEN (b.expiry_date IS NULL OR b.expiry_date >= ?) AND p.active = 1 THEN b.quantity_available * p.retail_price_paise ELSE 0 END),0) AS saleable_retail_value_paise,
      MIN(CASE WHEN b.quantity_available > 0 THEN b.expiry_date END) AS nearest_expiry
      FROM products p LEFT JOIN inventory_batches b ON b.product_id = p.id
      GROUP BY p.id ORDER BY p.active DESC, p.name COLLATE NOCASE`).all(today,today,today,today,today);
  }

  inventorySummary() {
    const products = this.listProducts();
    const total = (key) => sum(products.map((row) => row[key]));
    return { product_count: products.length, stock_units: total('stock_qty'), saleable_units: total('saleable_qty'), expired_units: total('expired_qty'), cost_value_paise: total('stock_value_paise'), wholesale_value_paise: total('wholesale_value_paise'), retail_value_paise: total('retail_value_paise'), saleable_cost_value_paise: total('saleable_cost_value_paise'), saleable_wholesale_value_paise: total('saleable_wholesale_value_paise'), saleable_retail_value_paise: total('saleable_retail_value_paise'), low_stock_count: products.filter((row) => row.active && row.saleable_qty <= row.reorder_level).length, as_of_date: businessToday(), prices_include_gst: false };
  }

  createParty(input) {
    return inTransaction(this.db, () => {
    const name = clean(input.name);
    const type = clean(input.partyType || 'CUSTOMER').toUpperCase();
    if (!name) throw new AppError('Customer or supplier name is required.');
    if (!['CUSTOMER', 'SUPPLIER', 'BOTH'].includes(type)) throw new AppError('Invalid party type.');
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM parties').get().count;
    const code = clean(input.code).toUpperCase() || `${type.slice(0, 3)}-${String(Number(count) + 1).padStart(4, '0')}`;
    try {
      const result = this.db.prepare(`INSERT INTO parties
        (party_type, code, name, mobile, whatsapp_number, gstin, address, city, state_code, pincode, credit_days, credit_limit_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
        type, code, name, clean(input.mobile) || null, clean(input.whatsappNumber) || null, clean(input.gstin).toUpperCase() || null,
        clean(input.address) || null, clean(input.city) || null, clean(input.stateCode) || this.setting('company_state_code'),
        clean(input.pincode) || null, nonNegativeWhole(input.creditDays ?? this.setting('default_credit_days'), 'Credit days'),
        paise(input.creditLimit ?? 0, 'Credit limit'),
      );
      this.audit('CREATE', 'PARTY', Number(result.lastInsertRowid), { code, name, type });
      return this.getParty(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new AppError('Party code must be unique.');
      throw error;
    }
    });
  }

  updateParty(id, input) {
    return inTransaction(this.db, () => {
      const old = this.getParty(id);
      if (!old) throw new AppError('Customer not found.', 404);
      const name = clean(input.name ?? old.name);
      if (!name) throw new AppError('Name is required.');
      const fields = {name};
      for (const [key, column] of Object.entries({mobile:'mobile',whatsappNumber:'whatsapp_number',gstin:'gstin',address:'address',city:'city',stateCode:'state_code',pincode:'pincode'})) fields[column] = input[key] === undefined ? old[column] : clean(input[key]);
      fields.credit_days = nonNegativeWhole(input.creditDays ?? old.credit_days, 'Credit days');
      fields.credit_limit_paise = input.creditLimit === undefined ? old.credit_limit_paise : paise(input.creditLimit, 'Credit limit');
      this.db.prepare(`UPDATE parties SET ${Object.keys(fields).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), old.id);
      this.audit('UPDATE', 'PARTY', old.id, {before:old,after:fields});
      return this.getParty(old.id);
    });
  }

  listParties(type = null) {
    let sql = `SELECT p.*, COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS balance_paise,
      COALESCE(SUM(CASE WHEN l.entry_type IN ('SALE','RECEIPT','SALES_RETURN','OPENING_ADJUSTMENT') THEN l.debit_paise-l.credit_paise ELSE 0 END),0) AS customer_balance_paise,
      COALESCE(SUM(CASE WHEN l.entry_type IN ('PURCHASE','PAYMENT','PURCHASE_RETURN','OPENING_ADJUSTMENT') THEN l.debit_paise-l.credit_paise ELSE 0 END),0) AS supplier_balance_paise
      FROM parties p LEFT JOIN party_ledger_entries l ON l.party_id = p.id`;
    const params = [];
    if (type) {
      sql += ' WHERE (p.party_type = ? OR p.party_type = \'BOTH\')';
      params.push(type);
    }
    sql += ' GROUP BY p.id ORDER BY p.active DESC, p.name COLLATE NOCASE';
    return this.db.prepare(sql).all(...params).map((row) => {
      const balance = type === 'CUSTOMER' ? row.customer_balance_paise : type === 'SUPPLIER' ? row.supplier_balance_paise : row.balance_paise;
      return { ...row,balance_paise: balance,receivable_paise: Math.max(0,balance),credit_paise: Math.max(0,-balance),payable_paise: Math.max(0,-row.supplier_balance_paise) };
    });
  }

  partyLedger(partyId) {
    const party = this.getParty(partyId);
    const rows = this.db.prepare(`SELECT * FROM party_ledger_entries WHERE party_id = ? ORDER BY entry_date, id`).all(party.id);
    let balance = 0;
    const entries = rows.map((row) => { balance += row.debit_paise - row.credit_paise; return { ...row, balance_paise: balance }; });
    return { party, entries, balance_paise: balance, receivable_paise: Math.max(0,balance), credit_paise: Math.max(0,-balance) };
  }

  validateLines(inputItems, party, priceField) {
    if (!Array.isArray(inputItems) || inputItems.length === 0) throw new AppError('At least one product line is required.');
    return inputItems.map((source) => {
      const product = this.getProduct(source.productId);
      const pack=source.unitCode?this.units.normalize('LOCAL',product.id,source,product[priceField]/100):null;
      const quantity = pack?pack.quantity:whole(source.quantity, `Quantity for ${product.name}`);
      const unitPricePaise = pack?Math.round(pack.baseRate*100):source.unitPrice !== undefined ? paise(source.unitPrice, `Price for ${product.name}`) : product[priceField];
      let taxable = pack?pack.amount:multiply(quantity, unitPricePaise);
      const gstBps = source.gstBps === undefined ? product.gst_bps : rate(source.gstBps);
      const gross=taxable;
      if(source.taxInclusive) taxable=proportional(gross,10000,10000+gstBps);
      const tax = this.taxAmounts(taxable, gstBps, party);
      if(source.taxInclusive) {
        const included=gross-taxable;
        if(!party || party.state_code===this.setting('company_state_code')) {tax.cgst=Math.floor(included/2);tax.sgst=included-tax.cgst;tax.igst=0;}
        else {tax.cgst=0;tax.sgst=0;tax.igst=included;}
      }
      return { product, quantity, unitPricePaise, taxable, gstBps, unitDetails:pack?.unit || {}, taxInclusive:!!source.taxInclusive, ...tax, total: sum([taxable,tax.cgst,tax.sgst,tax.igst]) };
    });
  }

  totals(lines) {
    const totalFor = (key) => sum(lines.map((line) => line[key]));
    const subtotal = totalFor('taxable');
    const cgst = totalFor('cgst');
    const sgst = totalFor('sgst');
    const igst = totalFor('igst');
    return { subtotal, cgst, sgst, igst, total: sum([subtotal,cgst,sgst,igst]) };
  }

  receivePurchase(input) {
    return inTransaction(this.db, () => {
      const supplier = this.getParty(input.supplierId, 'SUPPLIER');
      const billDate = dateOnly(input.billDate);
      if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError('At least one purchase line is required.');
      const lines = input.items.map((raw) => {
        const product = this.getProduct(raw.productId);
        const quantity = whole(raw.quantity, `Quantity for ${product.name}`);
        const unitCostPaise = raw.unitCost === undefined ? product.purchase_price_paise : paise(raw.unitCost, `Cost for ${product.name}`);
        const taxable = multiply(quantity, unitCostPaise);
        const gstBps = raw.gstBps === undefined ? product.gst_bps : rate(raw.gstBps);
        const tax = this.taxAmounts(taxable, gstBps, supplier);
        const batchNumber = clean(raw.batchNumber);
        if (!batchNumber) throw new AppError(`Batch number is required for ${product.name}.`);
        const expiryDate = clean(raw.expiryDate) ? dateOnly(raw.expiryDate, 'Expiry date') : null;
        return { product, quantity, unitCostPaise, taxable, gstBps, batchNumber, expiryDate, ...tax, total: sum([taxable,tax.cgst,tax.sgst,tax.igst]) };
      });
      const totals = this.totals(lines);
      const billNumber = clean(input.billNumber) || this.nextDocument('purchase_prefix', 'purchase_bills', 'bill_number', billDate);
      const header = this.db.prepare(`INSERT INTO purchase_bills
        (bill_number, supplier_id, supplier_bill_number, bill_date, subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
        billNumber, supplier.id, clean(input.supplierBillNumber) || null, billDate, totals.subtotal, totals.cgst, totals.sgst, totals.igst, totals.total, clean(input.notes) || null,
      );
      const billId = Number(header.lastInsertRowid);
      const addItem = this.db.prepare(`INSERT INTO purchase_items
        (purchase_bill_id, product_id, batch_number, expiry_date, quantity, unit_cost_paise, gst_bps, taxable_paise, cgst_paise, sgst_paise, igst_paise, line_total_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const batchInsert = this.db.prepare(`INSERT INTO inventory_batches
        (product_id, batch_number, expiry_date, cost_paise, quantity_received, quantity_available, source_document)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const batchUpdate = this.db.prepare(`UPDATE inventory_batches SET quantity_received = quantity_received + ?, quantity_available = quantity_available + ? WHERE id = ?`);
      const movement = this.db.prepare(`INSERT INTO stock_movements
        (product_id, batch_id, movement_type, quantity_delta, unit_cost_paise, reference_type, reference_id, reason)
        VALUES (?, ?, 'PURCHASE_RECEIPT', ?, ?, 'PURCHASE_BILL', ?, ?)`);
      for (const line of lines) {
        addItem.run(billId, line.product.id, line.batchNumber, line.expiryDate, line.quantity, line.unitCostPaise, line.gstBps, line.taxable, line.cgst, line.sgst, line.igst, line.total);
        const existing = this.db.prepare(`SELECT * FROM inventory_batches WHERE product_id = ? AND batch_number = ? AND expiry_date IS ?`).get(line.product.id, line.batchNumber, line.expiryDate);
        let batchId;
        if (existing) {
          if (existing.cost_paise !== line.unitCostPaise) throw new AppError(`Batch ${line.batchNumber} already has a different purchase cost. Use a distinct lot/batch reference for this cost; historical stock cannot be revalued by a receipt.`, 409, 'BATCH_COST_CONFLICT');
          sum([existing.quantity_received,line.quantity], 'Received quantity');
          multiply(sum([existing.quantity_available,line.quantity]), line.unitCostPaise, 'Batch value');
          batchId = existing.id;
          batchUpdate.run(line.quantity, line.quantity, batchId);
        } else {
          batchId = Number(batchInsert.run(line.product.id, line.batchNumber, line.expiryDate, line.unitCostPaise, line.quantity, line.quantity, billNumber).lastInsertRowid);
        }
        movement.run(line.product.id, batchId, line.quantity, line.unitCostPaise, billId, `Stock received through ${billNumber}`);
        this.db.prepare('UPDATE products SET purchase_price_paise = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(line.unitCostPaise, line.product.id);
      }
      if (totals.total > 0) this.db.prepare(`INSERT INTO party_ledger_entries
        (party_id, entry_date, entry_type, credit_paise, reference_type, reference_id, narration)
        VALUES (?, ?, 'PURCHASE', ?, 'PURCHASE_BILL', ?, ?)` ).run(supplier.id, billDate, totals.total, billId, `Purchase ${billNumber}`);
      this.audit('POST', 'PURCHASE_BILL', billId, { billNumber, supplier: supplier.name, totalPaise: totals.total });
      this.allocateSupplierCredit(supplier.id,true);
      return { id: billId, billNumber, ...totals };
    });
  }

  allocateStock(productId, quantity, movementType, referenceType, referenceId, reason) {
    const today = businessToday();
    const batches = this.db.prepare(`SELECT * FROM inventory_batches
      WHERE product_id = ? AND quantity_available > 0 AND (expiry_date IS NULL OR expiry_date >= ?)
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, id ASC`).all(productId, today);
    let remaining = quantity;
    const allocations = [];
    const movement = this.db.prepare(`INSERT INTO stock_movements
      (product_id, batch_id, movement_type, quantity_delta, unit_cost_paise, reference_type, reference_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const take = this.db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available - ? WHERE id = ? AND quantity_available >= ?');
    for (const batch of batches) {
      if (remaining === 0) break;
      const picked = Math.min(remaining, batch.quantity_available);
      const result = take.run(picked, batch.id, picked);
      if (result.changes !== 1) throw new AppError('Stock changed while creating the document. Please retry.', 409, 'STOCK_CHANGED');
      movement.run(productId, batch.id, movementType, -picked, batch.cost_paise, referenceType, referenceId, reason);
      allocations.push({ batchId: batch.id, batchNumber: batch.batch_number, quantity: picked, unitCostPaise: batch.cost_paise, expiryDate: batch.expiry_date });
      remaining -= picked;
    }
    if (remaining > 0) {
      const product = this.getProduct(productId);
      throw new AppError(`Insufficient non-expired stock for ${product.name}. Short by ${remaining}.`, 409, 'INSUFFICIENT_STOCK');
    }
    return allocations;
  }

  createInvoice(input) {
    return inTransaction(this.db, () => {
      const channel = clean(input.channel).toUpperCase();
      if (!['RETAIL', 'DISTRIBUTION'].includes(channel)) throw new AppError('Invoice channel must be RETAIL or DISTRIBUTION.');
      const customer = input.customerId ? this.getParty(input.customerId, 'CUSTOMER') : null;
      if (channel === 'DISTRIBUTION' && !customer) throw new AppError('A customer is required for a distribution invoice.');
      if (input.salesOrderId) {
        const order = this.db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(whole(input.salesOrderId, 'Order'));
        if (!order || order.customer_id !== customer?.id || !['CONFIRMED','PACKING','DELIVERED'].includes(order.status)) throw new AppError('The order is unavailable, already invoiced or belongs to another customer.');
      }
      const invoiceDate = dateOnly(input.invoiceDate);
      const deliveryDate = channel === 'DISTRIBUTION' ? dateOnly(input.deliveryDate || invoiceDate, 'Delivery date') : invoiceDate;
      const invoiceItems=input.priceMode==='MRP' && channel==='RETAIL' ? input.items.map(item=>{
        const product=this.getProduct(item.productId);
        if(product.mrp_paise<=0) throw new AppError('Set MRP for '+product.name+' before selling in POS.');
        const factor=item.unitCode?this.units.list('LOCAL',product.id).find(u=>u.code===item.unitCode)?.factor:1;
        if(!factor)throw new AppError('Select a valid product unit.');
        return {...item,unitPrice:product.mrp_paise*factor/100,gstBps:product.gst_bps,taxInclusive:true};
      }) : input.items;
      const lines = this.validateLines(invoiceItems, customer, channel === 'RETAIL' ? 'retail_price_paise' : 'wholesale_price_paise');
      const totals = this.totals(lines);
      const payments = Array.isArray(input.payments) ? input.payments : [];
      const paid = sum(payments.map((payment) => { paymentMethod(payment.method || 'CASH'); return paise(payment.amount, 'Payment amount'); }));
      if (paid > totals.total) throw new AppError('Payment cannot exceed invoice total.');
      if (channel === 'RETAIL' && !customer && paid !== totals.total) throw new AppError('Walk-in POS sales must be fully paid. Select a customer to create a credit sale.');
      const invoiceNumber = clean(input.invoiceNumber) || this.nextDocument('invoice_prefix', 'invoices', 'invoice_number', invoiceDate);
      const dueDate = customer ? addDays(deliveryDate, customer.credit_days) : null;
      const paymentStatus = paid === totals.total ? 'PAID' : paid === 0 ? 'UNPAID' : 'PART_PAID';
      const header = this.db.prepare(`INSERT INTO invoices
        (invoice_number, channel, customer_id, sales_order_id, invoice_date, delivery_date, due_date, subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise, paid_paise, payment_status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
        invoiceNumber, channel, customer?.id ?? null, input.salesOrderId ? Number(input.salesOrderId) : null, invoiceDate, deliveryDate, dueDate,
        totals.subtotal, totals.cgst, totals.sgst, totals.igst, totals.total, paid, paymentStatus, clean(input.notes) || null,
      );
      const invoiceId = Number(header.lastInsertRowid);
      const item = this.db.prepare(`INSERT INTO invoice_items
        (invoice_id, product_id, quantity, unit_price_paise, gst_bps, taxable_paise, cgst_paise, sgst_paise, igst_paise, line_total_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const line of lines) {
        const itemId = Number(item.run(invoiceId, line.product.id, line.quantity, line.unitPricePaise, line.gstBps, line.taxable, line.cgst, line.sgst, line.igst, line.total).lastInsertRowid);
        this.db.prepare('UPDATE invoice_items SET tax_inclusive=? WHERE id=?').run(line.taxInclusive?1:0,itemId);
        this.db.prepare('UPDATE invoice_items SET unit_details=? WHERE id=?').run(json(line.unitDetails),itemId);
        const allocations = this.allocateStock(line.product.id, line.quantity, channel === 'RETAIL' ? 'SALE_RETAIL' : 'SALE_DISTRIBUTION', 'INVOICE', invoiceId, `Sold through ${invoiceNumber}`);
        for (const allocation of allocations) this.db.prepare('INSERT INTO invoice_stock_allocations (invoice_item_id,batch_id,quantity,unit_cost_paise) VALUES (?,?,?,?)').run(itemId,allocation.batchId,allocation.quantity,allocation.unitCostPaise);
      }
      if (customer && totals.total > 0) {
        this.db.prepare(`INSERT INTO party_ledger_entries
          (party_id, entry_date, entry_type, debit_paise, reference_type, reference_id, narration)
          VALUES (?, ?, 'SALE', ?, 'INVOICE', ?, ?)` ).run(customer.id, invoiceDate, totals.total, invoiceId, `Invoice ${invoiceNumber}`);
      }
      for (const payment of payments) {
        const amount = paise(payment.amount, 'Payment amount');
        if (amount === 0) continue;
        const receiptNumber = this.nextDocument('receipt_prefix', 'payments', 'receipt_number', invoiceDate);
        const paymentId = Number(this.db.prepare(`INSERT INTO payments
          (receipt_number, party_id, invoice_id, payment_date, direction, method, amount_paise, reference_number, notes)
          VALUES (?, ?, ?, ?, 'RECEIPT', ?, ?, ?, ?)` ).run(
          receiptNumber, customer?.id ?? null, invoiceId, invoiceDate, paymentMethod(payment.method || 'CASH'), amount,
          clean(payment.referenceNumber) || null, `Payment against ${invoiceNumber}`,
        ).lastInsertRowid);
        this.db.prepare('INSERT INTO payment_allocations (payment_id,invoice_id,amount_paise) VALUES (?,?,?)').run(paymentId,invoiceId,amount);
        if (customer) this.db.prepare(`INSERT INTO party_ledger_entries
          (party_id, entry_date, entry_type, credit_paise, reference_type, reference_id, narration)
          VALUES (?, ?, 'RECEIPT', ?, 'INVOICE', ?, ?)` ).run(customer.id, invoiceDate, amount, invoiceId, `Receipt against ${invoiceNumber}`);
      }
      if (input.salesOrderId) this.db.prepare(`UPDATE sales_orders SET status = 'INVOICED', delivery_date = ? WHERE id = ?`).run(deliveryDate, Number(input.salesOrderId));
      if (customer) this.allocateCustomerCredit(customer.id, true);
      this.audit('POST', 'INVOICE', invoiceId, { invoiceNumber, channel, totalPaise: totals.total, paidPaise: paid });
      const posted = this.invoiceBalances(invoiceId);
      return { id: invoiceId, invoiceNumber, channel, dueDate, paymentStatus: posted.payment_status, ...totals, paidPaise: posted.paid_paise };
    });
  }

  editInvoice(id,input) {
    return inTransaction(this.db,()=>{
      const before=this.invoiceDetail(id), invoice=before.invoice;
      if(invoice.status!=='POSTED') throw new AppError('Only posted invoices can be corrected.');
      if(before.items.some(l=>l.returned_quantity>0)) throw new AppError('This invoice has returns. Correct it through the returns workflow to preserve returned quantities.');
      const reason=clean(input.reason);
      if(!reason) throw new AppError('A correction reason is required.');
      const customer=invoice.customer_id?this.getParty(invoice.customer_id,'CUSTOMER'):null;
      const lines=this.validateLines(input.items,customer,invoice.channel==='RETAIL'?'retail_price_paise':'wholesale_price_paise');
      const totals=this.totals(lines);
      if(totals.total<invoice.paid_paise+invoice.credit_applied_paise) throw new AppError('Correct allocated payments before reducing the total below the amount paid.');
      if(!customer && totals.total!==invoice.paid_paise) throw new AppError('Walk-in corrections must match the payment total. Use a return for refunds.');
      for(const a of before.allocations) {
        const productId=before.items.find(l=>l.id===a.invoice_item_id).product_id;
        this.db.prepare('UPDATE inventory_batches SET quantity_available=quantity_available+? WHERE id=?').run(a.quantity,a.batch_id);
        this.db.prepare("INSERT INTO stock_movements(product_id,batch_id,movement_type,quantity_delta,unit_cost_paise,reference_type,reference_id,reason) VALUES(?,?,'ADJUSTMENT_IN',?,?,'INVOICE',?,?)").run(productId,a.batch_id,a.quantity,a.unit_cost_paise,invoice.id,reason);
      }
      this.db.prepare('DELETE FROM invoice_stock_allocations WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id=?)').run(invoice.id);
      this.db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(invoice.id);
      const put=this.db.prepare('INSERT INTO invoice_items(invoice_id,product_id,quantity,unit_price_paise,gst_bps,taxable_paise,cgst_paise,sgst_paise,igst_paise,line_total_paise) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for(const l of lines) {
        const lineId=Number(put.run(invoice.id,l.product.id,l.quantity,l.unitPricePaise,l.gstBps,l.taxable,l.cgst,l.sgst,l.igst,l.total).lastInsertRowid);
        this.db.prepare('UPDATE invoice_items SET tax_inclusive=? WHERE id=?').run(l.taxInclusive?1:0,lineId);
        this.db.prepare('UPDATE invoice_items SET unit_details=? WHERE id=?').run(json(l.unitDetails),lineId);
        for(const a of this.allocateStock(l.product.id,l.quantity,invoice.channel==='RETAIL'?'SALE_RETAIL':'SALE_DISTRIBUTION','INVOICE',invoice.id,reason)) this.db.prepare('INSERT INTO invoice_stock_allocations(invoice_item_id,batch_id,quantity,unit_cost_paise) VALUES(?,?,?,?)').run(lineId,a.batchId,a.quantity,a.unitCostPaise);
      }
      this.db.prepare('UPDATE invoices SET subtotal_paise=?,cgst_paise=?,sgst_paise=?,igst_paise=?,total_paise=? WHERE id=?').run(totals.subtotal,totals.cgst,totals.sgst,totals.igst,totals.total,invoice.id);
      const delta=totals.total-invoice.total_paise;
      if(customer && delta) this.db.prepare("INSERT INTO party_ledger_entries(party_id,entry_date,entry_type,debit_paise,credit_paise,reference_type,reference_id,narration) VALUES(?,?,'SALE',?,?,'INVOICE',?,?)").run(customer.id,businessToday(),Math.max(delta,0),Math.max(-delta,0),invoice.id,reason);
      this.refreshInvoice(invoice.id);
      this.audit('UPDATE','INVOICE',invoice.id,{reason,before,after:this.invoiceDetail(invoice.id)});
      return this.invoiceDetail(invoice.id);
    });
  }

  createOrder(input) {
    return inTransaction(this.db, () => {
      const customer = this.getParty(input.customerId, 'CUSTOMER');
      const orderDate = dateOnly(input.orderDate);
      const lines = this.validateLines(input.items, customer, 'wholesale_price_paise');
      const orderNumber = clean(input.orderNumber) || this.nextDocument('order_prefix', 'sales_orders', 'order_number', orderDate);
      const result = this.db.prepare(`INSERT INTO sales_orders (order_number, customer_id, order_date, status, notes)
        VALUES (?, ?, ?, 'CONFIRMED', ?)` ).run(orderNumber, customer.id, orderDate, clean(input.notes) || null);
      const orderId = Number(result.lastInsertRowid);
      const item = this.db.prepare(`INSERT INTO sales_order_items (order_id, product_id, quantity, unit_price_paise, gst_bps) VALUES (?, ?, ?, ?, ?)`);
      for (const line of lines) item.run(orderId, line.product.id, line.quantity, line.unitPricePaise, line.gstBps);
      this.audit('CREATE', 'SALES_ORDER', orderId, { orderNumber, customer: customer.name });
      return { id: orderId, orderNumber };
    });
  }

  deliverOrder(orderId, deliveryDate) {
    const order = this.db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(Number(orderId));
    if (!order) throw new AppError('Order not found.', 404, 'ORDER_NOT_FOUND');
    if (!['CONFIRMED', 'PACKING', 'DELIVERED'].includes(order.status)) throw new AppError('Only confirmed orders can be delivered.');
    const rows = this.db.prepare('SELECT * FROM sales_order_items WHERE order_id = ?').all(order.id);
    return this.createInvoice({
      channel: 'DISTRIBUTION', customerId: order.customer_id, salesOrderId: order.id,
      invoiceDate: deliveryDate || new Date().toISOString().slice(0, 10), deliveryDate: deliveryDate || new Date().toISOString().slice(0, 10),
      items: rows.map((row) => ({ productId: row.product_id, quantity: row.quantity, unitPrice: row.unit_price_paise / 100, gstBps: row.gst_bps })),
      notes: `Generated from order ${order.order_number}`,
    });
  }

  migrateAllocations() {
    if (this.db.prepare("SELECT value FROM schema_meta WHERE key = 'allocation_migration_v2'").get()) return;
    inTransaction(this.db, () => {
      this.db.exec(`INSERT OR IGNORE INTO payment_allocations (payment_id,invoice_id,amount_paise)
        SELECT id,invoice_id,amount_paise FROM payments WHERE direction = 'RECEIPT' AND method != 'CREDIT' AND invoice_id IS NOT NULL`);
      // Older versions stored sale lot movements against the invoice, not the line.
      // Reconstruct the original line ordering from those immutable movements.
      const invoices = this.db.prepare('SELECT id FROM invoices ORDER BY id').all();
      for (const invoice of invoices) {
        const items = this.db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoice.id);
        const movements = this.db.prepare("SELECT * FROM stock_movements WHERE reference_type = 'INVOICE' AND reference_id = ? AND movement_type IN ('SALE_RETAIL','SALE_DISTRIBUTION') ORDER BY id").all(invoice.id).map((row) => ({ ...row, remaining: -row.quantity_delta }));
        for (const item of items) {
          let remaining = item.quantity;
          for (const movement of movements.filter((row) => row.product_id === item.product_id)) {
            const quantity = Math.min(remaining, movement.remaining);
            if (!quantity) continue;
            this.db.prepare('INSERT INTO invoice_stock_allocations (invoice_item_id,batch_id,quantity,unit_cost_paise) VALUES (?,?,?,?)').run(item.id,movement.batch_id,quantity,movement.unit_cost_paise);
            movement.remaining -= quantity; remaining -= quantity;
          }
        }
        this.releaseInvoiceExcess(invoice.id);
      }
      for (const party of this.db.prepare("SELECT id FROM parties WHERE party_type IN ('CUSTOMER','BOTH')").all()) this.allocateCustomerCredit(party.id);
      this.db.prepare("INSERT INTO schema_meta (key,value) VALUES ('allocation_migration_v2',?)").run(new Date().toISOString());
      if (invoices.length) this.audit('MIGRATE', 'PAYMENT_ALLOCATIONS', null, { invoices: invoices.length, version: 2 });
    });
  }

  invoiceBalances(invoiceId) {
    const invoice = this.db.prepare(`SELECT i.*,
      COALESCE((SELECT SUM(r.total_paise) FROM returns r WHERE r.invoice_id = i.id AND r.return_type = 'SALES_RETURN' AND r.status = 'POSTED'),0) AS returned_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM opening_credit_allocations a WHERE a.invoice_id=i.id),0) AS credit_applied_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.invoice_id = i.id),0) AS allocated_paise
      FROM invoices i WHERE i.id = ?`).get(Number(invoiceId));
    if (!invoice) throw new AppError('Invoice not found.',404,'INVOICE_NOT_FOUND');
    const net = Math.max(0,invoice.total_paise - invoice.returned_paise);
    const outstanding = Math.max(0, net - invoice.allocated_paise - invoice.credit_applied_paise);
    return { ...invoice, paid_paise: invoice.allocated_paise, net_total_paise: net, outstanding_paise: outstanding, payment_status: outstanding === 0 ? 'PAID' : invoice.allocated_paise + invoice.credit_applied_paise > 0 ? 'PART_PAID' : 'UNPAID' };
  }

  refreshInvoice(invoiceId) {
    const invoice = this.invoiceBalances(invoiceId);
    this.db.prepare('UPDATE invoices SET paid_paise = ?,payment_status = ? WHERE id = ?').run(invoice.paid_paise,invoice.payment_status,invoice.id);
    return invoice;
  }

  releaseInvoiceExcess(invoiceId) {
    const invoice = this.invoiceBalances(invoiceId);
    let excess = Math.max(0, invoice.paid_paise + invoice.credit_applied_paise - invoice.net_total_paise);
    for (const allocation of this.db.prepare('SELECT * FROM payment_allocations WHERE invoice_id = ? ORDER BY id DESC').all(invoiceId)) {
      if (!excess) break;
      const released = Math.min(excess,allocation.amount_paise);
      if (released === allocation.amount_paise) this.db.prepare('DELETE FROM payment_allocations WHERE id = ?').run(allocation.id);
      else this.db.prepare('UPDATE payment_allocations SET amount_paise = amount_paise - ? WHERE id = ?').run(released,allocation.id);
      excess -= released;
      this.audit('RELEASE', 'PAYMENT_ALLOCATION', allocation.id, { invoiceId, paymentId: allocation.payment_id, releasedPaise: released });
    }
    this.releaseOpeningCredit('invoice_id',invoiceId,excess);
    return this.refreshInvoice(invoiceId);
  }

  releaseOpeningCredit(column, documentId, excess) {
    for (const allocation of this.db.prepare(`SELECT * FROM opening_credit_allocations WHERE ${column}=? ORDER BY id DESC`).all(documentId)) {
      if (!excess) break;
      const released = Math.min(excess,allocation.amount_paise);
      if (released === allocation.amount_paise) this.db.prepare('DELETE FROM opening_credit_allocations WHERE id=?').run(allocation.id);
      else this.db.prepare('UPDATE opening_credit_allocations SET amount_paise=amount_paise-? WHERE id=?').run(released,allocation.id);
      excess -= released;
      this.audit('RELEASE','OPENING_CREDIT_ALLOCATION',allocation.id,{ documentId,column,releasedPaise: released });
    }
  }

  allocateOpeningCredit(partyId, documents, kind) {
    const column = kind === 'CUSTOMER' ? 'invoice_id' : 'purchase_bill_id';
    const sign = kind === 'CUSTOMER' ? 'l.credit_paise-l.debit_paise' : 'l.debit_paise-l.credit_paise';
    const entries = this.db.prepare(`SELECT l.id,(${sign})-COALESCE((SELECT SUM(a.amount_paise) FROM opening_credit_allocations a WHERE a.ledger_entry_id=l.id),0) AS available_paise
      FROM party_ledger_entries l WHERE l.party_id=? AND l.entry_type='OPENING_ADJUSTMENT' AND (${sign})>0 ORDER BY l.entry_date,l.id`).all(partyId);
    const changes = [];
    for (const entry of entries) {
      let available = entry.available_paise;
      for (const document of documents) {
        const amount = Math.min(available,document.outstanding_paise);
        if (amount <= 0) continue;
        this.db.prepare(`INSERT INTO opening_credit_allocations (ledger_entry_id,${column},amount_paise) VALUES (?,?,?)`).run(entry.id,document.id,amount);
        available -= amount; document.outstanding_paise -= amount;
        changes.push({ ledgerEntryId: entry.id,documentId: document.id,kind,amountPaise: amount });
      }
    }
    if (changes.length) this.audit('ALLOCATE','OPENING_CREDIT',partyId,{ allocations: changes });
    return changes;
  }

  allocateCustomerCredit(partyId, reserveOpening = false) {
    const receipts = this.db.prepare(`SELECT p.*,p.amount_paise-COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.payment_id=p.id),0) AS available_paise
      FROM payments p WHERE p.party_id=? AND p.direction='RECEIPT' AND p.method!='CREDIT' ORDER BY p.payment_date,p.id`).all(partyId);
    const invoices = this.db.prepare("SELECT id FROM invoices WHERE customer_id=? AND status='POSTED' ORDER BY COALESCE(due_date,invoice_date),invoice_date,id").all(partyId).map((row) => this.invoiceBalances(row.id));
    this.allocateOpeningCredit(partyId,invoices,'CUSTOMER');
    let reserve = reserveOpening ? Math.max(0,this.db.prepare("SELECT COALESCE(SUM(debit_paise-credit_paise),0) AS value FROM party_ledger_entries WHERE party_id=? AND entry_type='OPENING_ADJUSTMENT'").get(partyId).value) : 0;
    const changes = [];
    for (const receipt of receipts) {
      let available = receipt.available_paise;
      const reserved = Math.min(available,reserve); available -= reserved; reserve -= reserved;
      for (const invoice of invoices) {
        const amount = Math.min(available,invoice.outstanding_paise);
        if (amount <= 0) continue;
        this.db.prepare(`INSERT INTO payment_allocations (payment_id,invoice_id,amount_paise) VALUES (?,?,?)
          ON CONFLICT(payment_id,invoice_id) DO UPDATE SET amount_paise=amount_paise+excluded.amount_paise`).run(receipt.id,invoice.id,amount);
        available -= amount; invoice.outstanding_paise -= amount;
        changes.push({ paymentId: receipt.id, invoiceId: invoice.id, amountPaise: amount });
      }
    }
    for (const invoice of invoices) this.refreshInvoice(invoice.id);
    if (changes.length) this.audit('ALLOCATE','CUSTOMER_CREDIT',partyId,{ allocations: changes });
    return changes;
  }

  purchaseBalances(purchaseBillId) {
    const bill = this.db.prepare(`SELECT b.*,
      COALESCE((SELECT SUM(r.total_paise) FROM returns r WHERE r.purchase_bill_id=b.id AND r.return_type='PURCHASE_RETURN' AND r.status='POSTED'),0) AS returned_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM opening_credit_allocations a WHERE a.purchase_bill_id=b.id),0) AS credit_applied_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM supplier_payment_allocations a WHERE a.purchase_bill_id=b.id),0) AS paid_paise
      FROM purchase_bills b WHERE b.id=?`).get(Number(purchaseBillId));
    if (!bill) throw new AppError('Purchase bill not found.',404,'PURCHASE_NOT_FOUND');
    const net = Math.max(0,bill.total_paise-bill.returned_paise);
    const outstanding = Math.max(0,net-bill.paid_paise-bill.credit_applied_paise);
    return { ...bill, net_total_paise: net, outstanding_paise: outstanding, payment_status: outstanding === 0 ? 'PAID' : bill.paid_paise+bill.credit_applied_paise > 0 ? 'PART_PAID' : 'UNPAID' };
  }

  allocateSupplierCredit(partyId,reserveOpening = false) {
    const payments = this.db.prepare(`SELECT p.*,p.amount_paise-COALESCE((SELECT SUM(a.amount_paise) FROM supplier_payment_allocations a WHERE a.payment_id=p.id),0) AS available_paise
      FROM payments p WHERE p.party_id=? AND p.direction='PAYMENT' ORDER BY p.payment_date,p.id`).all(partyId);
    const bills = this.db.prepare("SELECT id FROM purchase_bills WHERE supplier_id=? AND status='POSTED' ORDER BY bill_date,id").all(partyId).map((row) => this.purchaseBalances(row.id));
    this.allocateOpeningCredit(partyId,bills,'SUPPLIER');
    const changes = [];
    let reserve = reserveOpening ? Math.max(0,this.db.prepare("SELECT COALESCE(SUM(credit_paise-debit_paise),0) AS value FROM party_ledger_entries WHERE party_id=? AND entry_type='OPENING_ADJUSTMENT'").get(partyId).value) : 0;
    for (const payment of payments) {
      let available = payment.available_paise;
      const reserved = Math.min(available,reserve); available -= reserved; reserve -= reserved;
      for (const bill of bills) {
        const amount = Math.min(available,bill.outstanding_paise);
        if (amount <= 0) continue;
        this.db.prepare(`INSERT INTO supplier_payment_allocations (payment_id,purchase_bill_id,amount_paise) VALUES (?,?,?)
          ON CONFLICT(payment_id,purchase_bill_id) DO UPDATE SET amount_paise=amount_paise+excluded.amount_paise`).run(payment.id,bill.id,amount);
        available -= amount; bill.outstanding_paise -= amount;
        changes.push({ paymentId: payment.id,purchaseBillId: bill.id,amountPaise: amount });
      }
    }
    for (const bill of bills) { const balance = this.purchaseBalances(bill.id); this.db.prepare('UPDATE purchase_bills SET payment_status=? WHERE id=?').run(balance.payment_status,bill.id); }
    if (changes.length) this.audit('ALLOCATE','SUPPLIER_CREDIT',partyId,{ allocations: changes });
    return changes;
  }

  recordSupplierPayment(input) {
    return inTransaction(this.db, () => {
      const party = this.getParty(input.partyId || input.supplierId,'SUPPLIER');
      const amount = paise(input.amount,'Supplier payment');
      if (!amount) throw new AppError('Payment amount must be greater than zero.');
      const paymentDate = dateOnly(input.paymentDate);
      const bill = input.purchaseBillId ? this.purchaseBalances(input.purchaseBillId) : null;
      if (bill && (bill.supplier_id !== party.id || bill.status !== 'POSTED')) throw new AppError('This purchase bill does not belong to this supplier.');
      if (bill && amount > bill.outstanding_paise) throw new AppError('Payment exceeds this purchase bill balance. Omit the bill to record an advance.');
      const receiptNumber = clean(input.receiptNumber) || this.nextDocument('receipt_prefix','payments','receipt_number',paymentDate);
      const id = Number(this.db.prepare(`INSERT INTO payments (receipt_number,party_id,payment_date,direction,method,amount_paise,reference_number,notes)
        VALUES (?,?,?,'PAYMENT',?,?,?,?)`).run(receiptNumber,party.id,paymentDate,paymentMethod(input.method || 'BANK'),amount,clean(input.referenceNumber)||null,clean(input.notes)||null).lastInsertRowid);
      this.db.prepare(`INSERT INTO party_ledger_entries (party_id,entry_date,entry_type,debit_paise,reference_type,reference_id,narration)
        VALUES (?,?,'PAYMENT',?,'PAYMENT',?,?)`).run(party.id,paymentDate,amount,id,`Supplier payment ${receiptNumber}`);
      if (bill) this.db.prepare('INSERT INTO supplier_payment_allocations (payment_id,purchase_bill_id,amount_paise) VALUES (?,?,?)').run(id,bill.id,amount);
      const allocations = this.allocateSupplierCredit(party.id);
      this.audit('POST','PAYMENT',id,{ receiptNumber,partyId: party.id,direction: 'PAYMENT',amountPaise: amount,purchaseBillId: bill?.id,allocations });
      return { id,receiptNumber,amountPaise: amount,allocations };
    });
  }

  recordReceipt(input) {
    return inTransaction(this.db, () => {
      const party = this.getParty(input.partyId, 'CUSTOMER');
      const amount = paise(input.amount, 'Receipt amount');
      if (amount === 0) throw new AppError('Receipt amount must be greater than zero.');
      const paymentDate = dateOnly(input.paymentDate);
      let invoice = null;
      if (input.invoiceId) {
        invoice = this.invoiceBalances(input.invoiceId);
        if (invoice.status !== 'POSTED' || invoice.customer_id !== party.id) throw new AppError('The selected invoice does not belong to this customer.');
        if (amount > invoice.outstanding_paise) throw new AppError('Receipt exceeds the outstanding amount on this invoice. Omit the invoice to record customer credit.');
      }
      const receiptNumber = clean(input.receiptNumber) || this.nextDocument('receipt_prefix', 'payments', 'receipt_number', paymentDate);
      const result = this.db.prepare(`INSERT INTO payments
        (receipt_number, party_id, invoice_id, payment_date, direction, method, amount_paise, reference_number, notes)
        VALUES (?, ?, ?, ?, 'RECEIPT', ?, ?, ?, ?)` ).run(
        receiptNumber, party.id, invoice?.id ?? null, paymentDate, paymentMethod(input.method || 'UPI'), amount,
        clean(input.referenceNumber) || null, clean(input.notes) || null,
      );
      this.db.prepare(`INSERT INTO party_ledger_entries
        (party_id, entry_date, entry_type, credit_paise, reference_type, reference_id, narration)
        VALUES (?, ?, 'RECEIPT', ?, 'PAYMENT', ?, ?)` ).run(party.id, paymentDate, amount, Number(result.lastInsertRowid), `Receipt ${receiptNumber}`);
      const id = Number(result.lastInsertRowid);
      if (invoice) this.db.prepare('INSERT INTO payment_allocations (payment_id,invoice_id,amount_paise) VALUES (?,?,?)').run(id,invoice.id,amount);
      const allocations = this.allocateCustomerCredit(party.id);
      this.audit('POST', 'PAYMENT', id, { receiptNumber, party: party.name, amountPaise: amount, invoiceId: invoice?.id, allocations });
      return { id, receiptNumber, amountPaise: amount, allocations };
    });
  }

  queueReminder(invoiceId) {
    return inTransaction(this.db, () => {
      const invoice = this.db.prepare(`SELECT i.*, p.name AS customer_name, p.whatsapp_number, p.mobile FROM invoices i
        JOIN parties p ON p.id = i.customer_id WHERE i.id = ? AND i.status = 'POSTED' AND i.payment_status != 'PAID'`).get(Number(invoiceId));
      if (!invoice) throw new AppError('An unpaid customer invoice is required for a reminder.', 404, 'REMINDER_NOT_ELIGIBLE');
      const prior = this.db.prepare(`SELECT id, status FROM reminder_history WHERE invoice_id = ? AND date(created_at) = date('now')
        AND status IN ('QUEUED','SENT') ORDER BY id DESC LIMIT 1`).get(invoice.id);
      if (prior) return { id: prior.id, status: prior.status, skippedDuplicate: true };
      const outstanding = this.invoiceBalances(invoice.id).outstanding_paise;
      if (!outstanding) throw new AppError('This invoice has no outstanding payment.');
      const recipient = invoice.whatsapp_number || invoice.mobile || null;
      const message = `Dear ${invoice.customer_name}, payment of ₹${(outstanding / 100).toFixed(2)} against invoice ${invoice.invoice_number} is due${invoice.due_date ? ` on ${invoice.due_date}` : ''}. Please contact us if already paid. — ${this.setting('company_name')}`;
      const status = recipient ? 'QUEUED' : 'SKIPPED';
      const result = this.db.prepare(`INSERT INTO reminder_history (invoice_id, channel, recipient, status, message)
        VALUES (?, 'WHATSAPP', ?, ?, ?)` ).run(invoice.id, recipient, status, message);
      this.audit('QUEUE', 'PAYMENT_REMINDER', Number(result.lastInsertRowid), { invoiceNumber: invoice.invoice_number, recipient, status });
      return { id: Number(result.lastInsertRowid), status, recipient, message };
    });
  }

  reminderHistory() {
    return this.db.prepare(`SELECT r.*, i.invoice_number, p.name AS customer_name FROM reminder_history r
      JOIN invoices i ON i.id = r.invoice_id JOIN parties p ON p.id = i.customer_id ORDER BY r.created_at DESC, r.id DESC`).all();
  }

  recordExpense(input) {
    return inTransaction(this.db, () => {
      const expenseDate = dateOnly(input.expenseDate);
      const category = clean(input.category);
      if (!category) throw new AppError('Expense category is required.');
      const amount = paise(input.amount, 'Expense amount');
      if (amount === 0) throw new AppError('Expense amount must be greater than zero.');
      const gstBps = rate(input.gstBps ?? 0);
      const gst = proportional(amount,gstBps,10000 + gstBps);
      const number = clean(input.expenseNumber) || this.nextDocument('expense_prefix', 'expenses', 'expense_number', expenseDate);
      const result = this.db.prepare(`INSERT INTO expenses
        (expense_number, expense_date, category, payee, method, amount_paise, gst_bps, gst_paise, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(number, expenseDate, category, clean(input.payee) || null,
        paymentMethod(input.method || 'CASH'), amount, gstBps, gst, clean(input.notes) || null);
      this.audit('POST', 'EXPENSE', Number(result.lastInsertRowid), { number, category, amountPaise: amount });
      return { id: Number(result.lastInsertRowid), expenseNumber: number, amountPaise: amount };
    });
  }

  adjustStock(input) {
    return inTransaction(this.db, () => {
      const product = this.getProduct(input.productId);
      const quantity = whole(input.quantity, 'Adjustment quantity');
      const type = clean(input.type).toUpperCase();
      const allowed = ['DAMAGE', 'EXPIRY', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'];
      if (!allowed.includes(type)) throw new AppError('Invalid stock adjustment type.');
      const reason = clean(input.reason);
      if (!reason) throw new AppError('A reason is required for every stock adjustment.');
      if (type === 'ADJUSTMENT_IN') {
        const batchNumber = clean(input.batchNumber) || `ADJ-${Date.now()}`;
        const expiryDate = clean(input.expiryDate) ? dateOnly(input.expiryDate,'Expiry date') : null;
        const batch = this.db.prepare('SELECT * FROM inventory_batches WHERE product_id=? AND batch_number=? AND expiry_date IS ?').get(product.id,batchNumber,expiryDate);
        return this.setBatchStock({ ...input,productId: product.id,batchNumber,expiryDate,quantity: sum([batch?.quantity_available || 0,quantity]),reason });
      }
      if (input.batchId) {
        const batch = this.db.prepare('SELECT * FROM inventory_batches WHERE id=? AND product_id=?').get(whole(input.batchId,'Batch'),product.id);
        if (!batch) throw new AppError('Select a batch belonging to this product.');
        if (batch.quantity_available < quantity) throw new AppError('This batch does not have enough stock.',409,'INSUFFICIENT_STOCK');
        this.db.prepare('UPDATE inventory_batches SET quantity_available=quantity_available-? WHERE id=?').run(quantity,batch.id);
        const movementId = Number(this.db.prepare(`INSERT INTO stock_movements (product_id,batch_id,movement_type,quantity_delta,unit_cost_paise,reference_type,reference_id,reason)
          VALUES (?,?,?,?,?,'STOCK_ADJUSTMENT',?,?)`).run(product.id,batch.id,type,-quantity,batch.cost_paise,batch.id,reason).lastInsertRowid);
        this.audit('POST','STOCK_ADJUSTMENT',movementId,{ productId: product.id,batchId: batch.id,type,quantity,reason });
        return { id: movementId,productId: product.id,batchId: batch.id,quantityDelta: -quantity };
      }
      if (type === 'EXPIRY') throw new AppError('Select the exact expired batch to write off.');
      const movementType = type;
      const allocations = this.allocateStock(product.id, quantity, movementType, 'STOCK_ADJUSTMENT', null, reason);
      this.audit('POST', 'STOCK_ADJUSTMENT', null, { product: product.name, type, quantity, reason, allocations });
      return { productId: product.id, quantityDelta: -quantity, allocations };
    });
  }

  setBatchStock(input) {
    return inTransaction(this.db, () => {
      const product = this.getProduct(input.productId);
      const batchNumber = clean(input.batchNumber);
      const reason = clean(input.reason);
      if (!batchNumber || !reason) throw new AppError('Batch number and an adjustment reason are required for stock counts.');
      const expiryDate = clean(input.expiryDate) ? dateOnly(input.expiryDate,'Expiry date') : null;
      const quantity = nonNegativeWhole(input.quantity,'Counted quantity');
      const before = this.db.prepare('SELECT * FROM inventory_batches WHERE product_id=? AND batch_number=? AND expiry_date IS ?').get(product.id,batchNumber,expiryDate);
      const unitCost = input.unitCost === undefined ? (before?.cost_paise ?? product.purchase_price_paise) : paise(input.unitCost,'Unit cost');
      if (before && before.cost_paise !== unitCost) throw new AppError('Existing lot cost cannot be changed by a stock count. Use a distinct lot for stock bought at another cost.',409,'BATCH_COST_CONFLICT');
      multiply(quantity,unitCost,'Batch value');
      const delta = quantity - (before?.quantity_available || 0);
      let id = before?.id;
      if (before) {
        const received = sum([before.quantity_received,Math.max(0,delta)],'Received quantity');
        this.db.prepare('UPDATE inventory_batches SET quantity_available=?,quantity_received=? WHERE id=?').run(quantity,received,id);
      } else id = Number(this.db.prepare(`INSERT INTO inventory_batches (product_id,batch_number,expiry_date,cost_paise,quantity_received,quantity_available,source_document)
        VALUES (?,?,?,?,?,?,'STOCK_COUNT')`).run(product.id,batchNumber,expiryDate,unitCost,quantity,quantity).lastInsertRowid);
      if (delta) this.db.prepare(`INSERT INTO stock_movements (product_id,batch_id,movement_type,quantity_delta,unit_cost_paise,reference_type,reference_id,reason)
        VALUES (?,?,?,?,?,'STOCK_ADJUSTMENT',?,?)`).run(product.id,id,delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',delta,unitCost,id,reason);
      this.audit('STOCK_COUNT','STOCK_ADJUSTMENT',id,{ productId: product.id,batchNumber,expiryDate,beforeQuantity: before?.quantity_available || 0,afterQuantity: quantity,quantityDelta: delta,unitCostPaise: unitCost,reason });
      return { id,batchId: id,productId: product.id,quantity,quantityDelta: delta };
    });
  }

  createSalesReturn(input) {
    return inTransaction(this.db, () => {
      const invoice = this.db.prepare('SELECT * FROM invoices WHERE id = ? AND status = \'POSTED\'').get(Number(input.invoiceId));
      if (!invoice) throw new AppError('A posted invoice is required for a sales return.');
      const returnDate = dateOnly(input.returnDate);
      if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError('At least one returned product is required.');
      const number = clean(input.returnNumber) || this.nextDocument('return_prefix', 'returns', 'return_number', returnDate);
      const header = this.db.prepare(`INSERT INTO returns (return_number, return_type, party_id, invoice_id, return_date, reason)
        VALUES (?, 'SALES_RETURN', ?, ?, ?, ?)` ).run(number, invoice.customer_id, invoice.id, returnDate, clean(input.reason) || null);
      const returnId = Number(header.lastInsertRowid);
      let total = 0;
      for (const raw of input.items) {
        const invoiceItem = this.db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?').get(Number(raw.invoiceItemId), invoice.id);
        if (!invoiceItem) throw new AppError('A return line does not belong to the selected invoice.');
        const quantity = whole(raw.quantity, 'Return quantity');
        const previouslyReturned = this.db.prepare(`SELECT COALESCE(SUM(ri.quantity), 0) AS quantity FROM return_items ri
          JOIN returns r ON r.id = ri.return_id WHERE r.return_type = 'SALES_RETURN' AND r.status = 'POSTED' AND ri.source_item_id = ?`).get(invoiceItem.id).quantity;
        if (quantity + previouslyReturned > invoiceItem.quantity) throw new AppError('Returned quantity cannot exceed the remaining quantity on this invoice line.');
        const lineTotal = proportional(invoiceItem.line_total_paise,previouslyReturned+quantity,invoiceItem.quantity) - proportional(invoiceItem.line_total_paise,previouslyReturned,invoiceItem.quantity);
        const allocations = this.db.prepare(`SELECT a.*,b.batch_number,b.expiry_date,b.quantity_available,
          COALESCE((SELECT SUM(ri.quantity) FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE ri.source_allocation_id=a.id AND r.status='POSTED'),0) AS returned_quantity
          FROM invoice_stock_allocations a JOIN inventory_batches b ON b.id=a.batch_id WHERE a.invoice_item_id=? ORDER BY a.id`).all(invoiceItem.id);
        let legacyReturned = this.db.prepare(`SELECT COALESCE(SUM(ri.quantity),0) AS quantity FROM return_items ri JOIN returns r ON r.id=ri.return_id
          WHERE ri.source_item_id=? AND ri.source_allocation_id IS NULL AND r.return_type='SALES_RETURN' AND r.status='POSTED'`).get(invoiceItem.id).quantity;
        let remaining = quantity;
        let processed = 0;
        for (const allocation of allocations) {
          const legacyUsed = Math.min(legacyReturned,allocation.quantity-allocation.returned_quantity);
          legacyReturned -= legacyUsed;
          const available = allocation.quantity-allocation.returned_quantity-legacyUsed;
          if (raw.batchId && Number(raw.batchId) !== allocation.batch_id) continue;
          const restored = Math.min(remaining,available);
          if (restored <= 0) continue;
          const partTotal = proportional(lineTotal,processed+restored,quantity)-proportional(lineTotal,processed,quantity);
          this.db.prepare(`INSERT INTO return_items (return_id,source_item_id,source_allocation_id,product_id,batch_id,quantity,unit_price_paise,gst_bps,line_total_paise)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(returnId,invoiceItem.id,allocation.id,invoiceItem.product_id,allocation.batch_id,restored,invoiceItem.unit_price_paise,invoiceItem.gst_bps,partTotal);
          // A return retains its exact original cost and expiry; it never becomes a fresh, non-expiring lot.
          if (raw.restock !== false) {
            sum([allocation.quantity_available,restored],'Batch quantity');
            this.db.prepare('UPDATE inventory_batches SET quantity_available=quantity_available+? WHERE id=?').run(restored,allocation.batch_id);
            this.db.prepare(`INSERT INTO stock_movements (product_id,batch_id,movement_type,quantity_delta,unit_cost_paise,reference_type,reference_id,reason)
              VALUES (?,?,'SALES_RETURN',?,?,'RETURN',?,?)`).run(invoiceItem.product_id,allocation.batch_id,restored,allocation.unit_cost_paise,returnId,clean(input.reason)||'Sales return');
          }
          remaining -= restored; processed += restored;
        }
        if (remaining) throw new AppError('The original sold batches cannot support this return quantity. Verify the selected batch and source invoice.',409,'RETURN_PROVENANCE_REQUIRED');
        total = sum([total,lineTotal]);
      }
      this.db.prepare('UPDATE returns SET total_paise = ? WHERE id = ?').run(total, returnId);
      if (invoice.customer_id && total > 0) this.db.prepare(`INSERT INTO party_ledger_entries
        (party_id, entry_date, entry_type, credit_paise, reference_type, reference_id, narration)
        VALUES (?, ?, 'SALES_RETURN', ?, 'RETURN', ?, ?)` ).run(invoice.customer_id, returnDate, total, returnId, `Sales return ${number}`);
      this.releaseInvoiceExcess(invoice.id);
      if (invoice.customer_id) this.allocateCustomerCredit(invoice.customer_id);
      this.audit('POST', 'RETURN', returnId, { number, type: 'SALES_RETURN', invoiceId: invoice.id, totalPaise: total, items: input.items });
      return { id: returnId, returnNumber: number, totalPaise: total, settlement: invoice.customer_id ? 'Customer balance credited; existing receipts reallocated or held as credit.' : 'Refund due recorded; no cash refund has been posted.' };
    });
  }

  createPurchaseReturn(input) {
    return inTransaction(this.db, () => {
      const bill = this.db.prepare('SELECT * FROM purchase_bills WHERE id = ? AND status = \'POSTED\'').get(Number(input.purchaseBillId));
      if (!bill) throw new AppError('A posted purchase bill is required for a purchase return.');
      const returnDate = dateOnly(input.returnDate);
      if (!Array.isArray(input.items) || input.items.length === 0) throw new AppError('At least one returned product is required.');
      const number = clean(input.returnNumber) || this.nextDocument('return_prefix', 'returns', 'return_number', returnDate);
      const header = this.db.prepare(`INSERT INTO returns (return_number, return_type, party_id, purchase_bill_id, return_date, reason)
        VALUES (?, 'PURCHASE_RETURN', ?, ?, ?, ?)` ).run(number, bill.supplier_id, bill.id, returnDate, clean(input.reason) || null);
      const returnId = Number(header.lastInsertRowid);
      let total = 0;
      for (const raw of input.items) {
        const purchaseItem = this.db.prepare('SELECT * FROM purchase_items WHERE id = ? AND purchase_bill_id = ?').get(Number(raw.purchaseItemId), bill.id);
        if (!purchaseItem) throw new AppError('A return line does not belong to the selected purchase bill.');
        const quantity = whole(raw.quantity, 'Return quantity');
        const previouslyReturned = this.db.prepare(`SELECT COALESCE(SUM(ri.quantity), 0) AS quantity FROM return_items ri
          JOIN returns r ON r.id = ri.return_id WHERE r.return_type = 'PURCHASE_RETURN' AND r.status = 'POSTED' AND ri.source_item_id = ?`).get(purchaseItem.id).quantity;
        if (quantity + previouslyReturned > purchaseItem.quantity) throw new AppError('Returned quantity cannot exceed the original purchase line.');
        const batch = this.db.prepare(`SELECT * FROM inventory_batches WHERE product_id = ? AND batch_number = ? AND expiry_date IS ?`).get(purchaseItem.product_id, purchaseItem.batch_number, purchaseItem.expiry_date);
        if (!batch || batch.quantity_available < quantity) throw new AppError('There is not enough of the original batch available to return.', 409, 'INSUFFICIENT_STOCK');
        const changed = this.db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available - ? WHERE id = ? AND quantity_available >= ?').run(quantity, batch.id, quantity);
        if (changed.changes !== 1) throw new AppError('Stock changed while creating the return. Please retry.', 409, 'STOCK_CHANGED');
        const lineTotal = proportional(purchaseItem.line_total_paise,previouslyReturned+quantity,purchaseItem.quantity) - proportional(purchaseItem.line_total_paise,previouslyReturned,purchaseItem.quantity);
        this.db.prepare(`INSERT INTO return_items (return_id, source_item_id, product_id, batch_id, quantity, unit_price_paise, gst_bps, line_total_paise)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ).run(returnId, purchaseItem.id, purchaseItem.product_id, batch.id, quantity, purchaseItem.unit_cost_paise, purchaseItem.gst_bps, lineTotal);
        this.db.prepare(`INSERT INTO stock_movements
          (product_id, batch_id, movement_type, quantity_delta, unit_cost_paise, reference_type, reference_id, reason)
          VALUES (?, ?, 'PURCHASE_RETURN', ?, ?, 'RETURN', ?, ?)` ).run(purchaseItem.product_id, batch.id, -quantity, batch.cost_paise, returnId, clean(input.reason) || 'Purchase return');
        total = sum([total,lineTotal]);
      }
      this.db.prepare('UPDATE returns SET total_paise = ? WHERE id = ?').run(total, returnId);
      if (total > 0) this.db.prepare(`INSERT INTO party_ledger_entries
        (party_id, entry_date, entry_type, debit_paise, reference_type, reference_id, narration)
        VALUES (?, ?, 'PURCHASE_RETURN', ?, 'RETURN', ?, ?)` ).run(bill.supplier_id, returnDate, total, returnId, `Purchase return ${number}`);
      const returnBalance = this.purchaseBalances(bill.id);
      let excess = Math.max(0,returnBalance.paid_paise+returnBalance.credit_applied_paise-returnBalance.net_total_paise);
      for (const allocation of this.db.prepare('SELECT * FROM supplier_payment_allocations WHERE purchase_bill_id=? ORDER BY id DESC').all(bill.id)) {
        if (!excess) break;
        const released = Math.min(excess,allocation.amount_paise);
        if (released === allocation.amount_paise) this.db.prepare('DELETE FROM supplier_payment_allocations WHERE id=?').run(allocation.id);
        else this.db.prepare('UPDATE supplier_payment_allocations SET amount_paise=amount_paise-? WHERE id=?').run(released,allocation.id);
        excess -= released;
        this.audit('RELEASE','SUPPLIER_PAYMENT_ALLOCATION',allocation.id,{ purchaseBillId: bill.id,paymentId: allocation.payment_id,releasedPaise: released });
      }
      this.releaseOpeningCredit('purchase_bill_id',bill.id,excess);
      this.allocateSupplierCredit(bill.supplier_id);
      this.audit('POST', 'RETURN', returnId, { number, type: 'PURCHASE_RETURN', purchaseBillId: bill.id, totalPaise: total });
      return { id: returnId, returnNumber: number, totalPaise: total };
    });
  }

  inventory() {
    const today = businessToday();
    return this.db.prepare(`SELECT p.id AS product_id, p.sku, p.name, p.unit, p.reorder_level,p.purchase_price_paise,p.wholesale_price_paise,p.retail_price_paise,
      b.id AS batch_id, b.batch_number, b.expiry_date, b.cost_paise, b.quantity_received, b.quantity_available,
      b.quantity_available * b.cost_paise AS value_paise,
      b.quantity_available * p.wholesale_price_paise AS wholesale_value_paise,
      b.quantity_available * p.retail_price_paise AS retail_value_paise,
      CASE WHEN (b.expiry_date IS NULL OR b.expiry_date >= ?) AND p.active=1 THEN b.quantity_available ELSE 0 END AS saleable_qty,
      CASE WHEN b.expiry_date IS NOT NULL AND b.expiry_date < ? THEN 'EXPIRED'
           WHEN b.expiry_date IS NOT NULL AND b.expiry_date <= ? THEN 'EXPIRING'
           WHEN (SELECT COALESCE(SUM(b2.quantity_available),0) FROM inventory_batches b2 WHERE b2.product_id=p.id AND (b2.expiry_date IS NULL OR b2.expiry_date>=?)) <= p.reorder_level THEN 'LOW' ELSE 'OK' END AS alert
      FROM inventory_batches b JOIN products p ON p.id = b.product_id
      WHERE b.quantity_available > 0 ORDER BY CASE WHEN b.expiry_date IS NULL THEN 1 ELSE 0 END, b.expiry_date, p.name`).all(today,today,addDays(today,30),today);
  }

  receivables() {
    const invoices = this.invoices().filter((row) => row.status === 'POSTED' && row.customer_id && row.outstanding_paise > 0);
    const customers = this.listParties('CUSTOMER').map((party) => {
      const rows = invoices.filter((invoice) => invoice.customer_id === party.id);
      const totalFor = (filter) => sum(rows.filter(filter).map((row) => row.outstanding_paise));
      const outstanding = totalFor(() => true);
      return { ...party,invoice_outstanding_paise: outstanding,unallocated_balance_paise: party.balance_paise-outstanding,
        opening_unaged_paise: Math.max(0,party.balance_paise-outstanding),overdue_paise: totalFor((row) => row.days_overdue > 0),current_paise: totalFor((row) => row.days_overdue === 0),
        aging_1_7_paise: totalFor((row) => row.days_overdue >= 1 && row.days_overdue <= 7),aging_8_30_paise: totalFor((row) => row.days_overdue >= 8 && row.days_overdue <= 30),aging_31_plus_paise: totalFor((row) => row.days_overdue >= 31),
        oldest_due_date: rows.filter((row) => row.due_date).map((row) => row.due_date).sort()[0] || null,open_invoice_count: rows.length };
    });
    const totalFor = (key) => sum(customers.map((row) => row[key]));
    return { as_of_date: businessToday(),summary: { customer_count: customers.length,outstanding_customer_count: customers.filter((row) => row.receivable_paise > 0).length,receivable_paise: totalFor('receivable_paise'),credit_paise: totalFor('credit_paise'),overdue_paise: totalFor('overdue_paise'),current_paise: totalFor('current_paise'),opening_unaged_paise: totalFor('opening_unaged_paise'),aging_1_7_paise: totalFor('aging_1_7_paise'),aging_8_30_paise: totalFor('aging_8_30_paise'),aging_31_plus_paise: totalFor('aging_31_plus_paise') },customers,invoices };
  }

  dashboard() {
    const today = businessToday();
    const stats = this.db.prepare(`SELECT
      (SELECT COALESCE(SUM(quantity_available * cost_paise), 0) FROM inventory_batches) AS inventory_value_paise,
      (SELECT COALESCE(SUM(total_paise), 0) FROM invoices WHERE status = 'POSTED' AND invoice_date = ?) AS sales_today_paise,
      (SELECT COALESCE(SUM(total_paise), 0) FROM invoices WHERE status = 'POSTED' AND substr(invoice_date,1,7) = ?) AS sales_month_paise,
      (SELECT COALESCE(SUM(amount_paise), 0) FROM payments WHERE direction = 'RECEIPT' AND method!='CREDIT' AND payment_date = ?) AS collections_today_paise,
      (SELECT COALESCE(SUM(quantity_available), 0) FROM inventory_batches) AS stock_units`).get(today,today.slice(0,7),today);
    const amulStats = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='amul_sales_invoices'").get() ? this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN invoice_date=? THEN total_paise ELSE 0 END),0) AS sales_today_paise,
      COALESCE(SUM(CASE WHEN substr(invoice_date,1,7)=? THEN total_paise ELSE 0 END),0) AS sales_month_paise,
      COALESCE(SUM(CASE WHEN payment_date=? THEN paid_paise ELSE 0 END),0) AS collections_today_paise,
      COALESCE(SUM(total_paise-paid_paise),0) AS receivable_paise,
      COALESCE(SUM(CASE WHEN due_date<? AND total_paise>paid_paise THEN total_paise-paid_paise ELSE 0 END),0) AS overdue_paise
      FROM amul_sales_invoices WHERE local_deleted=0`).get(today,today.slice(0,7),today,today) : {sales_today_paise:0,sales_month_paise:0,collections_today_paise:0,receivable_paise:0,overdue_paise:0};
    const amulPosStats = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='amul_pos_sales'").get() ? this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN sale_date=? THEN amount_paise ELSE 0 END),0) AS sales_today_paise,
      COALESCE(SUM(CASE WHEN substr(sale_date,1,7)=? THEN amount_paise ELSE 0 END),0) AS sales_month_paise,
      COALESCE(SUM(CASE WHEN sale_date=? THEN amount_paise ELSE 0 END),0) AS collections_today_paise
      FROM amul_pos_sales`).get(today,today.slice(0,7),today) : {sales_today_paise:0,sales_month_paise:0,collections_today_paise:0};
    const lowStock = this.listProducts().filter((row) => row.active && row.saleable_qty <= row.reorder_level).map((row) => ({ ...row,stock_qty: row.saleable_qty })).sort((a,b) => a.stock_qty-b.stock_qty).slice(0,8);
    const expiring = this.db.prepare(`SELECT p.name, b.batch_number, b.expiry_date, b.quantity_available FROM inventory_batches b
      JOIN products p ON p.id = b.product_id WHERE b.quantity_available > 0 AND b.expiry_date IS NOT NULL
      AND b.expiry_date <= ? ORDER BY b.expiry_date LIMIT 8`).all(addDays(today,30));
    const receivables = this.receivables();
    stats.local_sales_today_paise = stats.sales_today_paise;
    stats.local_sales_month_paise = stats.sales_month_paise;
    stats.local_collections_today_paise = stats.collections_today_paise;
    stats.local_receivable_paise = receivables.summary.receivable_paise;
    stats.amul_sales_today_paise = amulStats.sales_today_paise + amulPosStats.sales_today_paise;
    stats.amul_sales_month_paise = amulStats.sales_month_paise + amulPosStats.sales_month_paise;
    stats.amul_collections_today_paise = amulStats.collections_today_paise + amulPosStats.collections_today_paise;
    stats.amul_receivable_paise = amulStats.receivable_paise;
    stats.amul_overdue_paise = amulStats.overdue_paise;
    stats.sales_today_paise += stats.amul_sales_today_paise;
    stats.sales_month_paise += stats.amul_sales_month_paise;
    stats.collections_today_paise += stats.amul_collections_today_paise;
    stats.receivable_paise = receivables.summary.receivable_paise + amulStats.receivable_paise;
    stats.customer_credit_paise = receivables.summary.credit_paise;
    stats.overdue_paise = receivables.summary.overdue_paise + amulStats.overdue_paise;
    stats.payable_paise = sum(this.listParties('SUPPLIER').map((row) => row.payable_paise));
    const inventorySummary = this.inventorySummary();
    const overdue = receivables.invoices.filter((row) => row.days_overdue > 0).sort((a,b) => a.due_date.localeCompare(b.due_date)).slice(0,10);
    return { stats: { ...stats,...inventorySummary }, lowStock, expiring, overdue, inventorySummary, receivablesSummary: receivables.summary };
  }

  invoices() {
    const today = businessToday();
    return this.db.prepare(`SELECT i.*,p.name AS customer_name,
      COALESCE((SELECT SUM(r.total_paise) FROM returns r WHERE r.invoice_id=i.id AND r.return_type='SALES_RETURN' AND r.status='POSTED'),0) AS returned_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM opening_credit_allocations a WHERE a.invoice_id=i.id),0) AS credit_applied_paise,
      COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.invoice_id=i.id),0) AS allocated_paise
      FROM invoices i LEFT JOIN parties p ON p.id=i.customer_id ORDER BY i.invoice_date DESC,i.id DESC`).all().map((row) => {
      const outstanding = Math.max(0,row.total_paise-row.returned_paise-row.allocated_paise-row.credit_applied_paise);
      const daysOverdue = outstanding && row.due_date ? Math.max(0,Math.floor((Date.parse(today)-Date.parse(row.due_date))/86400000)) : 0;
      return { ...row,paid_paise: row.allocated_paise,net_total_paise: row.total_paise-row.returned_paise,outstanding_paise: outstanding,days_overdue: daysOverdue,payment_status: outstanding === 0 ? 'PAID' : row.allocated_paise+row.credit_applied_paise > 0 ? 'PART_PAID' : 'UNPAID' };
    });
  }

  invoiceDetail(invoiceId) {
    const invoice = this.invoices().find((row) => row.id === Number(invoiceId));
    if (!invoice) throw new AppError('Invoice not found.', 404, 'INVOICE_NOT_FOUND');
    const items = this.db.prepare(`SELECT ii.*, p.name AS product_name, COALESCE((SELECT SUM(ri.quantity) FROM return_items ri
      JOIN returns r ON r.id = ri.return_id WHERE r.return_type = 'SALES_RETURN' AND r.status = 'POSTED' AND ri.source_item_id = ii.id), 0) AS returned_quantity
      FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE ii.invoice_id = ?`).all(invoice.id);
    const allocations = this.db.prepare(`SELECT a.*,b.batch_number,b.expiry_date FROM invoice_stock_allocations a JOIN inventory_batches b ON b.id=a.batch_id JOIN invoice_items ii ON ii.id=a.invoice_item_id WHERE ii.invoice_id=?`).all(invoice.id);
    const refundDue = !invoice.customer_id ? this.db.prepare(`SELECT COALESCE(SUM(p.amount_paise-COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.payment_id=p.id),0)),0) AS value FROM payments p WHERE p.invoice_id=? AND p.direction='RECEIPT'`).get(invoice.id).value : 0;
    return { invoice: { ...invoice,refund_due_paise: refundDue }, items, allocations };
  }

  orders() {
    return this.db.prepare(`SELECT o.*, p.name AS customer_name, COUNT(oi.id) AS line_count
      FROM sales_orders o JOIN parties p ON p.id = o.customer_id LEFT JOIN sales_order_items oi ON oi.order_id = o.id
      GROUP BY o.id ORDER BY o.order_date DESC, o.id DESC`).all();
  }

  purchaseBills() {
    return this.db.prepare(`SELECT b.id, p.name AS supplier_name FROM purchase_bills b
      LEFT JOIN parties p ON p.id = b.supplier_id ORDER BY b.bill_date DESC, b.id DESC`).all().map((row) => ({ ...this.purchaseBalances(row.id),supplier_name: row.supplier_name }));
  }

  purchaseDetail(purchaseBillId) {
    const bill = this.db.prepare(`SELECT b.*, p.name AS supplier_name FROM purchase_bills b LEFT JOIN parties p ON p.id = b.supplier_id WHERE b.id = ?`).get(Number(purchaseBillId));
    if (!bill) throw new AppError('Purchase bill not found.', 404, 'PURCHASE_NOT_FOUND');
    const items = this.db.prepare(`SELECT pi.*, p.name AS product_name, COALESCE((SELECT SUM(ri.quantity) FROM return_items ri
      JOIN returns r ON r.id = ri.return_id WHERE r.return_type = 'PURCHASE_RETURN' AND r.status = 'POSTED' AND ri.source_item_id = pi.id), 0) AS returned_quantity
      FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_bill_id = ?`).all(bill.id);
    return { bill: { ...bill,...this.purchaseBalances(bill.id) }, items };
  }

  returns() {
    return this.db.prepare(`SELECT r.*, p.name AS party_name, i.invoice_number, b.bill_number FROM returns r
      LEFT JOIN parties p ON p.id = r.party_id LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN purchase_bills b ON b.id = r.purchase_bill_id
      ORDER BY r.return_date DESC, r.id DESC`).all();
  }

  payments() {
    return this.db.prepare(`SELECT pay.*, p.name AS party_name, i.invoice_number,
      CASE WHEN pay.direction='RECEIPT' THEN COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.payment_id=pay.id),0)
      ELSE COALESCE((SELECT SUM(a.amount_paise) FROM supplier_payment_allocations a WHERE a.payment_id=pay.id),0) END AS allocated_paise
      FROM payments pay
      LEFT JOIN parties p ON p.id = pay.party_id LEFT JOIN invoices i ON i.id = pay.invoice_id
      ORDER BY pay.payment_date DESC, pay.id DESC`).all().map((row) => ({ ...row,unallocated_paise: row.amount_paise-row.allocated_paise,
        allocations: row.direction === 'RECEIPT' ? this.db.prepare('SELECT a.*,i.invoice_number FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.payment_id=?').all(row.id) : this.db.prepare('SELECT a.*,b.bill_number FROM supplier_payment_allocations a JOIN purchase_bills b ON b.id=a.purchase_bill_id WHERE a.payment_id=?').all(row.id) }));
  }

  expenses() { return this.db.prepare('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC').all(); }
  auditLog() { return this.db.prepare('SELECT * FROM audit_log ORDER BY occurred_at DESC, id DESC').all().map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) })); }

  reports() {
    const salesByDay = this.db.prepare(`SELECT date,SUM(gross_sales_paise) AS gross_sales_paise,SUM(returns_paise) AS returns_paise,
      SUM(gross_sales_paise-returns_paise) AS sales_paise,SUM(output_tax_paise) AS output_tax_paise FROM (
        SELECT invoice_date AS date,total_paise AS gross_sales_paise,0 AS returns_paise,cgst_paise+sgst_paise+igst_paise AS output_tax_paise FROM invoices WHERE status='POSTED'
        UNION ALL SELECT return_date AS date,0 AS gross_sales_paise,total_paise AS returns_paise,0 AS output_tax_paise FROM returns WHERE return_type='SALES_RETURN' AND status='POSTED'
      ) GROUP BY date ORDER BY date`).all();
    const gst = this.db.prepare(`SELECT
      COALESCE((SELECT SUM(cgst_paise + sgst_paise + igst_paise) FROM invoices WHERE status = 'POSTED'),0) AS output_tax_paise,
      COALESCE((SELECT SUM(cgst_paise + sgst_paise + igst_paise) FROM purchase_bills WHERE status = 'POSTED'),0) AS input_tax_paise,
      COALESCE((SELECT SUM(gst_paise) FROM expenses),0) AS expense_input_tax_paise`).get();
    const returnTax = (type,table) => sum(this.db.prepare(`SELECT source.quantity,source.cgst_paise+source.sgst_paise+source.igst_paise AS tax_paise,SUM(ri.quantity) AS returned_quantity
      FROM return_items ri JOIN returns r ON r.id=ri.return_id JOIN ${table} source ON source.id=ri.source_item_id
      WHERE r.return_type=? AND r.status='POSTED' GROUP BY source.id`).all(type).map((row) => proportional(row.tax_paise,row.returned_quantity,row.quantity)));
    const salesReturnTax = returnTax('SALES_RETURN','invoice_items');
    const purchaseReturnTax = returnTax('PURCHASE_RETURN','purchase_items');
    const customerBalances = this.listParties('CUSTOMER').filter((row) => row.balance_paise !== 0).sort((a,b) => b.balance_paise-a.balance_paise);
    const netOutput = Math.max(0,gst.output_tax_paise-salesReturnTax);
    const netInput = Math.max(0,gst.input_tax_paise-purchaseReturnTax);
    return { salesByDay,gst: { ...gst,gross_output_tax_paise: gst.output_tax_paise,gross_input_tax_paise: gst.input_tax_paise,sales_return_tax_paise: salesReturnTax,purchase_return_tax_paise: purchaseReturnTax,
      output_tax_paise: netOutput,input_tax_paise: netInput,estimated_tax_payable_paise: Math.max(0,netOutput-netInput-gst.expense_input_tax_paise),basis: 'Recorded tax less recorded return tax; input-credit eligibility and statutory filing require review.' },customerBalances,inventory: this.inventorySummary(),receivables: this.receivables().summary };
  }

  createBackup() {
    const actualDatabase = this.db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
    const directory = path.join(actualDatabase ? path.dirname(actualDatabase) : DATA_DIR, 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const target = path.join(directory, `frostflow-${stamp}.sqlite`);
    const sqlPath = target.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${sqlPath}'`);
    this.audit('CREATE', 'BACKUP', null, { filename: path.basename(target) });
    return { filename: path.basename(target), createdAt: new Date().toISOString() };
  }

  seedDemo() {
    return inTransaction(this.db, () => {
    if (this.db.prepare('SELECT COUNT(*) AS count FROM products').get().count > 0) throw new AppError('Demo data can only be loaded into an empty product catalogue.');
    const products = [
      ['KWI-CHOCO-100', 'Kwality Choco Bar 100 ml', 40, 32, 18, 15],
      ['KWI-VANI-500', 'Kwality Vanilla Family Pack 500 ml', 220, 180, 18, 8],
      ['AMU-BUTTER-100', 'Amul Butterscotch Cone 100 ml', 55, 44, 18, 12],
      ['AMU-MANGO-750', 'Amul Mango Tub 750 ml', 310, 260, 18, 5],
    ];
    const supplier = this.createParty({ partyType: 'SUPPLIER', name: 'Demo Frozen Foods Supplier', mobile: '9876543210' });
    const customer = this.createParty({ partyType: 'CUSTOMER', name: 'Demo Corner Store', mobile: '9876501234', whatsappNumber: '919876501234', creditDays: 2 });
    const created = products.map(([sku, name, retail, wholesale, gst, reorder]) => this.createProduct({ sku, name, retailPrice: retail, wholesalePrice: wholesale, gstBps: gst * 100, reorderLevel: reorder, hsnCode: '2105' }));
    this.receivePurchase({ supplierId: supplier.id, billDate: businessToday(), supplierBillNumber: 'DEMO-001', items: created.map((p, index) => ({ productId: p.id, quantity: 30 + index * 5, unitCost: Math.round(p.wholesale_price_paise * .78) / 100, batchNumber: `D${index + 1}0926`, expiryDate: addDays(businessToday(),180) })) });
    return { products: created.length, customer: customer.name };
    });
  }
}

module.exports = { ERPService, AppError };
