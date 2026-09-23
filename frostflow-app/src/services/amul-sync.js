'use strict';
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {inTransaction} = require('../db');
const DATASETS = ['products','batches','stock','prices','price_definitions','units','customers','routes','customer_routes','customer_addresses','salespeople','suppliers','invoices','invoice_lines','purchases','purchase_lines','receipts','receipt_allocations'];
const MASTER_DATASETS = new Set(['products','batches','stock','prices','price_definitions','units','customers','routes','customer_routes','customer_addresses','salespeople','suppliers','receipts','receipt_allocations']);
const TRANSACTION_DATASETS = new Set(['invoices','invoice_lines','purchases','purchase_lines']);
const SOURCE_IDS = {invoices:'SalId',invoice_lines:'SalId',purchases:'PurRcptId',purchase_lines:'PurRcptId'};
const AMUL_START_DATE = process.env.FROSTFLOW_AMUL_START_DATE || '2026-09-08';
const moneyToPaise = (value) => Math.round(Number(value || 0) * 100);
const ymd = (value) => value ? String(value).slice(0,10) : null;
const addDays = (value,days) => {
  if(!value)return null;
  const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
};
const resolvePowerShell = (env = process.env) => {
  if(env.FROSTFLOW_POWERSHELL || env.FROSTFLOW_PWSH)return env.FROSTFLOW_POWERSHELL || env.FROSTFLOW_PWSH;
  const bundled=path.join(env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe');
  if(bundled && fs.existsSync(bundled))return bundled;
  const windowsPowerShell=path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return fs.existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe';
};

function readAmul(onPage,env = process.env) {
  return new Promise((resolve,reject) => {
    let metadata=null;
    let stderr='';
    const child=spawn(resolvePowerShell(env),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'../../scripts/read-amul.ps1')], {
      windowsHide:true, stdio:['ignore','pipe','pipe'],
      env:{...env,FROSTFLOW_AMUL_SERVER:env.FROSTFLOW_AMUL_SERVER || 'tcp:100.105.240.98,1433',FROSTFLOW_AMUL_DATABASE:env.FROSTFLOW_AMUL_DATABASE || '0002018303_GVR ENTERPRISES',FROSTFLOW_AMUL_START_DATE:env.FROSTFLOW_AMUL_START_DATE || AMUL_START_DATE}
    });
    let pending='',failed=false;const completed=new Set();
    const timer=setTimeout(()=>{failed=true;child.kill();},600000);timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(failed)return;
      try {
        pending+=chunk;
        if(pending.length>8*1024*1024)throw new Error('Oversized page');
        let end;
        while((end=pending.indexOf('\n'))>=0) {
          const line=pending.slice(0,end).trim();pending=pending.slice(end+1);
          if(!line)continue;const page=JSON.parse(line.replace(/^\uFEFF/,''));
          if(page.dataset==='__metadata') {
            if(!Array.isArray(page.rows) || page.rows.length!==1)throw new Error('Invalid metadata');
            metadata=page.rows[0];continue;
          }
          if(!DATASETS.includes(page.dataset) || completed.has(page.dataset) || !Array.isArray(page.rows) || page.rows.length>1000)throw new Error('Invalid page');
          onPage(page.dataset,page.rows);
          if(page.complete===true)completed.add(page.dataset);
        }
      }catch{failed=true;child.kill();}
    });
    child.on('error',()=>{failed=true;});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1200);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(failed || code!==0 || pending.trim() || completed.size!==DATASETS.length || !metadata?.source_checkpoint) {
        const reason=String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
        reject(new Error(reason || 'Amul read failed.'));
      } else resolve({streamed:true,metadata});
    });
  });
}

class AmulSync {
  constructor(db,{read=readAmul,enabled=process.env.FROSTFLOW_AMUL_ENABLED==='1',intervalMs=300000,onChange=()=>{}}={}) {
    this.db=db; this.read=read; this.enabled=enabled; this.intervalMs=Math.max(30000,intervalMs); this.onChange=onChange;
    this.running=null; this.stopped=false; this.failures=0;
    db.exec(`CREATE TABLE IF NOT EXISTS amul_cache (dataset TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS amul_records (run TEXT NOT NULL,dataset TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run,dataset,ordinal));
      CREATE TABLE IF NOT EXISTS amul_active (id INTEGER PRIMARY KEY CHECK(id=1),run TEXT);
      INSERT OR IGNORE INTO amul_active(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS amul_sync_state (id INTEGER PRIMARY KEY CHECK(id=1),last_success TEXT,last_attempt TEXT,error TEXT,source_checkpoint TEXT,start_date TEXT,sync_mode TEXT);
      INSERT OR IGNORE INTO amul_sync_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS amul_invoice_tracking (
        sal_id TEXT PRIMARY KEY,
        payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(payment_status IN ('PENDING','PARTIAL','PAID')),
        paid_paise INTEGER NOT NULL DEFAULT 0 CHECK(paid_paise >= 0),
        payment_date TEXT,
        notes TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_invoice_edits (
        sal_id TEXT PRIMARY KEY, original_json TEXT NOT NULL, lines_json TEXT NOT NULL,
        reason TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_invoice_stock_adjustments (
        sal_id TEXT NOT NULL, product_id TEXT NOT NULL, batch_id TEXT NOT NULL, location_id TEXT NOT NULL,
        delta REAL NOT NULL, PRIMARY KEY(sal_id,product_id,batch_id,location_id)
      );
      CREATE TABLE IF NOT EXISTS amul_sales_invoices (
        sal_id TEXT PRIMARY KEY,
        invoice_number TEXT,
        invoice_date TEXT,
        delivery_date TEXT,
        due_date TEXT,
        customer_id TEXT,
        customer_code TEXT,
        customer_name TEXT,
        mobile TEXT,
        route_id TEXT,
        route_name TEXT,
        order_ref TEXT,
        total_paise INTEGER NOT NULL DEFAULT 0,
        source_paid_paise INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(payment_status IN ('PENDING','PARTIAL','PAID')),
        paid_paise INTEGER NOT NULL DEFAULT 0 CHECK(paid_paise >= 0),
        payment_date TEXT,
        notes TEXT,
        source_json TEXT NOT NULL DEFAULT '{}',
        local_deleted INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_sales_invoice_lines (
        sal_id TEXT NOT NULL,
        line_no TEXT NOT NULL,
        product_id TEXT,
        batch_id TEXT,
        quantity REAL,
        free_quantity REAL,
        unit_mrp_paise INTEGER NOT NULL DEFAULT 0,
        unit_rate_paise INTEGER NOT NULL DEFAULT 0,
        tax_paise INTEGER NOT NULL DEFAULT 0,
        net_paise INTEGER NOT NULL DEFAULT 0,
        source_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(sal_id,line_no)
      );
      CREATE TABLE IF NOT EXISTS amul_routes (
        route_id TEXT PRIMARY KEY,
        route_code TEXT,
        route_name TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        local_deleted INTEGER NOT NULL DEFAULT 0,
        source_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_retailers (
        retailer_id TEXT PRIMARY KEY,
        retailer_code TEXT,
        retailer_name TEXT,
        route_id TEXT,
        route_name TEXT,
        mobile TEXT,
        gstin TEXT,
        address TEXT,
        credit_days INTEGER NOT NULL DEFAULT 0,
        credit_limit_paise INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        source_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_products_local (
        product_id TEXT PRIMARY KEY,
        sku TEXT,
        code TEXT,
        product_name TEXT,
        barcode TEXT,
        batch_count INTEGER NOT NULL DEFAULT 0,
        stock_qty REAL NOT NULL DEFAULT 0,
        mrp_paise INTEGER NOT NULL DEFAULT 0,
        selling_price_paise INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        source_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_inventory_local (
        product_id TEXT,
        batch_id TEXT,
        product_name TEXT,
        batch_code TEXT,
        location_id TEXT,
        stock_qty REAL NOT NULL DEFAULT 0,
        unsaleable_qty REAL NOT NULL DEFAULT 0,
        free_qty REAL NOT NULL DEFAULT 0,
        mrp_paise INTEGER NOT NULL DEFAULT 0,
        selling_price_paise INTEGER NOT NULL DEFAULT 0,
        expiry_date TEXT,
        source_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(product_id,batch_id,location_id)
      );
      CREATE TABLE IF NOT EXISTS amul_inventory_overrides (
        product_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        stock_qty REAL NOT NULL DEFAULT 0 CHECK(stock_qty >= 0),
        reason TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(product_id,batch_id,location_id)
      );
      CREATE TABLE IF NOT EXISTS amul_purchase_bills (
        purchase_id TEXT PRIMARY KEY,
        bill_number TEXT,
        supplier_id TEXT,
        supplier_name TEXT,
        supplier_bill_number TEXT,
        bill_date TEXT,
        received_date TEXT,
        total_paise INTEGER NOT NULL DEFAULT 0,
        tax_paise INTEGER NOT NULL DEFAULT 0,
        paid_paise INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        payment_status TEXT,
        source_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_purchase_lines (
        purchase_id TEXT,
        line_no TEXT,
        product_id TEXT,
        batch_id TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        mrp_paise INTEGER NOT NULL DEFAULT 0,
        unit_cost_paise INTEGER NOT NULL DEFAULT 0,
        tax_paise INTEGER NOT NULL DEFAULT 0,
        net_paise INTEGER NOT NULL DEFAULT 0,
        source_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(purchase_id,line_no)
      );
      CREATE TABLE IF NOT EXISTS amul_pos_sales (
        id INTEGER PRIMARY KEY,
        sale_number TEXT NOT NULL UNIQUE,
        sale_date TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'CASH',
        amount_paise INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS amul_pos_sale_lines (
        id INTEGER PRIMARY KEY,
        sale_id INTEGER NOT NULL REFERENCES amul_pos_sales(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        product_name TEXT,
        quantity REAL NOT NULL,
        unit_price_paise INTEGER NOT NULL DEFAULT 0,
        line_total_paise INTEGER NOT NULL DEFAULT 0
      );`);
    for(const col of ['source_checkpoint TEXT','start_date TEXT','sync_mode TEXT'])try{db.exec(`ALTER TABLE amul_sync_state ADD COLUMN ${col}`);}catch{}
    for(const [table,col] of [['amul_sales_invoices','local_deleted INTEGER NOT NULL DEFAULT 0'],['amul_retailers','local_deleted INTEGER NOT NULL DEFAULT 0']])try{db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);}catch{}
  }
  status() {
    const saved=this.db.prepare('SELECT last_success,last_attempt,error,source_checkpoint,start_date,sync_mode FROM amul_sync_state WHERE id=1').get();
    return {...saved,enabled:this.enabled,running:!!this.running,read_only:true,interval_seconds:this.intervalMs/1000,
      stale:!saved.last_success || !!saved.error || Date.now()-Date.parse(saved.last_success)>this.intervalMs*2,
      datasets:DATASETS,source:'AMUL',scope:`Sales and purchases from ${saved.start_date || AMUL_START_DATE}`,
      consistency:'Tables are read sequentially; not a single point-in-time SQL snapshot. Incremental sync uses source LastModDate/AuthDate with a two-day overlap.'};
  }
  rows(name) {
    if(!DATASETS.includes(name)) throw new Error('Unknown Amul dataset.');
    const active=this.db.prepare('SELECT run FROM amul_active WHERE id=1').get().run;
    if(active)return this.db.prepare('SELECT payload FROM amul_records WHERE run=? AND dataset=? ORDER BY ordinal').all(active,name).map(r=>JSON.parse(r.payload));
    const row=this.db.prepare('SELECT payload FROM amul_cache WHERE dataset=?').get(name);
    return row ? JSON.parse(row.payload) : [];
  }
  page(name,{offset=0,limit=50,query=''}={}) {
    if(!DATASETS.includes(name))throw new Error('Unknown dataset');
    offset=Math.max(0,Math.floor(Number(offset)||0));limit=Math.min(200,Math.max(1,Math.floor(Number(limit)||50)));
    const active=this.db.prepare('SELECT run FROM amul_active WHERE id=1').get().run;
    const pattern='%'+String(query).slice(0,100).replace(/[\\%_]/g,'\\$&')+'%';
    const where="run=? AND dataset=? AND payload LIKE ? ESCAPE '\\'";
    const args=[active,name,pattern];
    const total=this.db.prepare('SELECT COUNT(*) n FROM amul_records WHERE '+where).get(...args).n;
    const rows=this.db.prepare('SELECT payload FROM amul_records WHERE '+where+' ORDER BY ordinal LIMIT ? OFFSET ?').all(...args,limit,offset).map(r=>JSON.parse(r.payload));
    return {rows,total,offset,limit};
  }
  priceMaps(run) {
    const defs=new Map(this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='price_definitions'").all(run).map(r=>JSON.parse(r.payload)).map(r=>[`${r.BatchSeqId}:${r.SlNo}`,String(r.FieldDesc || r.RefCode || '').toLowerCase()]));
    const prices=new Map();
    for(const row of this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='prices'").all(run).map(r=>JSON.parse(r.payload))) {
      const id=String(row.PriceId), label=defs.get(`${row.BatchSeqId}:${row.SLNo}`) || '';
      const target=prices.get(id) || {json:[],mrp:0,selling:0};
      const paise=moneyToPaise(row.PrdBatDetailValue);
      if(label.includes('mrp'))target.mrp=paise;
      if(label.includes('selling') || label.includes('sell') || label.includes('sel') || label.includes('list'))target.selling=paise;
      target.json.push(row);prices.set(id,target);
    }
    return prices;
  }
  pageLocal(table,{offset=0,limit=50,query=''}={}) {
    offset=Math.max(0,Math.floor(Number(offset)||0));limit=Math.min(200,Math.max(1,Math.floor(Number(limit)||50)));
    const pattern='%'+String(query).slice(0,100).replace(/[\\%_]/g,'\\$&')+'%';
    const hasDeleted=this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='local_deleted');
    const deletedFilter=hasDeleted ? 'local_deleted=0 AND ' : '';
    const total=this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${deletedFilter}(source_json LIKE ? ESCAPE '\\' OR CAST(rowid AS TEXT) LIKE ? ESCAPE '\\')`).get(pattern,pattern).n;
    const rows=this.db.prepare(`SELECT * FROM ${table} WHERE ${deletedFilter}(source_json LIKE ? ESCAPE '\\' OR CAST(rowid AS TEXT) LIKE ? ESCAPE '\\') ORDER BY ${['amul_products_local','amul_inventory_local'].includes(table) ? 'stock_qty>0 DESC, stock_qty DESC,' : ''} rowid DESC LIMIT ? OFFSET ?`).all(pattern,pattern,limit,offset);
    return {rows,total,offset,limit};
  }
  materializeLocal(run) {
    this.materializeMasters(run);
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amul_product_overrides'").get()) {
      for(const p of this.db.prepare('SELECT * FROM amul_product_overrides').all()) this.db.prepare('UPDATE amul_products_local SET product_name=?,mrp_paise=?,selling_price_paise=?,active=? WHERE product_id=?').run(p.name,p.mrp_paise,p.selling_price_paise,p.active,p.product_id);
    }
    this.applyLocalInventoryOverrides();
    this.applyLocalPosConsumption();
    this.materializePurchases(run);
    this.materializeLocalSales(run);
    this.applyInvoiceEdits();
    this.applyInvoiceStockAdjustments();
  }
  materializeMasters(run) {
    const routes=this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='routes'").all(run).map(r=>JSON.parse(r.payload));
    const routeMap=new Map(routes.map(r=>[String(r.RMId),r]));
    this.db.prepare('DELETE FROM amul_routes').run();
    const putRoute=this.db.prepare('INSERT INTO amul_routes(route_id,route_code,route_name,active,source_json) VALUES(?,?,?,?,?)');
    for(const r of routes)putRoute.run(String(r.RMId),r.RMCode || '',r.RMName || '',r.RMstatus===0 || r.Deleted ? 0 : 1,JSON.stringify(r));

    const retailers=this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='customers'").all(run).map(r=>JSON.parse(r.payload));
    const oldRetailers=new Map(this.db.prepare('SELECT retailer_id,retailer_name,mobile,gstin,address,credit_days,credit_limit_paise,local_deleted FROM amul_retailers').all().map(r=>[String(r.retailer_id),r]));
    this.db.prepare('DELETE FROM amul_retailers').run();
    const putRetailer=this.db.prepare('INSERT INTO amul_retailers(retailer_id,retailer_code,retailer_name,route_id,route_name,mobile,gstin,address,credit_days,credit_limit_paise,active,local_deleted,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const r of retailers) {
      const route=routeMap.get(String(r.RMId)) || {};
      const old=oldRetailers.get(String(r.RtrId));
      putRetailer.run(String(r.RtrId),r.RtrCode || '',old?.retailer_name || r.RtrName || '',String(r.RMId || ''),route.RMName || '',old?.mobile || r.RtrPhoneNo || r.RtrResPhone1 || '',old?.gstin || r.RtrTINNo || '',
        old?.address || [r.RtrAdd1,r.RtrAdd2,r.RtrAdd3,r.RtrPinNo].filter(Boolean).join(', '),old?.credit_days ?? Number(r.RtrCrDays || 0),old?.credit_limit_paise ?? moneyToPaise(r.RtrCrLimit),r.RtrStatus===0 || r.Deleted ? 0 : 1,old?.local_deleted || 0,JSON.stringify(r));
    }

    const products=this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='products'").all(run).map(r=>JSON.parse(r.payload));
    const productMap=new Map(products.map(p=>[String(p.PrdId),p]));
    const batches=this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='batches'").all(run).map(r=>JSON.parse(r.payload));
    const batchMap=new Map(batches.map(b=>[String(b.PrdBatId),b]));
    const priceMap=this.priceMaps(run);
    const productTotals=new Map();
    this.db.prepare('DELETE FROM amul_inventory_local').run();
    const putStock=this.db.prepare('INSERT INTO amul_inventory_local(product_id,batch_id,product_name,batch_code,location_id,stock_qty,unsaleable_qty,free_qty,mrp_paise,selling_price_paise,expiry_date,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const s of this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='stock'").all(run).map(r=>JSON.parse(r.payload))) {
      const batch=batchMap.get(String(s.PrdBatID)) || {};
      const product=productMap.get(String(batch.PrdId || s.PrdId)) || {};
      const price=priceMap.get(String(batch.DefaultPriceId)) || {mrp:0,selling:0,json:[]};
      const qty=Number(s.PrdBatLcnSih || 0), unsaleable=Number(s.PrdBatLcnUih || 0), free=Number(s.PrdBatLcnFre || 0);
      putStock.run(String(product.PrdId || batch.PrdId || s.PrdId || ''),String(s.PrdBatID),product.PrdName || '',batch.PrdBatCode || '',String(s.LcnId || ''),qty,unsaleable,free,price.mrp,price.selling,ymd(batch.ExpDate),JSON.stringify({...s,batch,price:price.json}));
      const total=productTotals.get(String(product.PrdId || batch.PrdId || s.PrdId || '')) || {stock:0,batches:new Set(),mrp:0,selling:0};
      total.stock+=qty; total.batches.add(String(s.PrdBatID)); total.mrp ||= price.mrp; total.selling ||= price.selling; productTotals.set(String(product.PrdId || batch.PrdId || s.PrdId || ''),total);
    }
    this.db.prepare('DELETE FROM amul_products_local').run();
    const putProduct=this.db.prepare('INSERT INTO amul_products_local(product_id,sku,code,product_name,barcode,batch_count,stock_qty,mrp_paise,selling_price_paise,active,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for(const p of products) {
      const total=productTotals.get(String(p.PrdId)) || {stock:0,batches:new Set(),mrp:0,selling:0};
      putProduct.run(String(p.PrdId),p.PrdDCode || '',p.PrdCCode || '',p.PrdName || '',p.EANCode || '',total.batches.size,total.stock,total.mrp,total.selling,p.PrdStatus===0 ? 0 : 1,JSON.stringify(p));
    }
  }
  decrementAmulStock(productId,quantity,{strict=true}={}) {
    let remaining=Number(quantity);
    const rows=this.db.prepare(`SELECT rowid,* FROM amul_inventory_local WHERE product_id=? AND stock_qty>0 ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, batch_id`).all(String(productId));
    for(const row of rows) {
      if(remaining<=0)break;
      const take=Math.min(Number(row.stock_qty),remaining);
      this.db.prepare('UPDATE amul_inventory_local SET stock_qty=stock_qty-? WHERE rowid=?').run(take,row.rowid);
      remaining-=take;
    }
    if(remaining>0 && strict)throw new Error('Not enough local Amul stock.');
    this.db.prepare('UPDATE amul_products_local SET stock_qty=MAX(0,stock_qty-?) WHERE product_id=?').run(Number(quantity),String(productId));
  }
  recomputeAmulProductStock(productId) {
    const total=this.db.prepare('SELECT COALESCE(SUM(stock_qty),0) qty FROM amul_inventory_local WHERE product_id=?').get(String(productId)).qty;
    this.db.prepare('UPDATE amul_products_local SET stock_qty=? WHERE product_id=?').run(total,String(productId));
    return total;
  }
  applyLocalInventoryOverrides() {
    const rows=this.db.prepare('SELECT * FROM amul_inventory_overrides').all();
    const touched=new Set();
    for(const row of rows) {
      const result=this.db.prepare('UPDATE amul_inventory_local SET stock_qty=? WHERE product_id=? AND batch_id=? AND location_id=?').run(Number(row.stock_qty),String(row.product_id),String(row.batch_id),String(row.location_id));
      if(result.changes)touched.add(String(row.product_id));
    }
    for(const productId of touched)this.recomputeAmulProductStock(productId);
  }
  updateInventoryStock(input={}) {
    const productId=String(input.productId || '');
    const batchId=String(input.batchId || '');
    const locationId=String(input.locationId || '');
    if(!productId || !batchId || !locationId)throw new Error('Product, batch and location are required.');
    const stockQty=Number(input.stockQty);
    if(!Number.isFinite(stockQty) || stockQty<0)throw new Error('Stock must be zero or more.');
    const existing=this.db.prepare('SELECT * FROM amul_inventory_local WHERE product_id=? AND batch_id=? AND location_id=?').get(productId,batchId,locationId);
    if(!existing)throw new Error('Amul inventory row not found.');
    const reason=String(input.reason || '').slice(0,500);
    return inTransaction(this.db,()=>{
      this.db.prepare('INSERT INTO amul_inventory_overrides(product_id,batch_id,location_id,stock_qty,reason,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,batch_id,location_id) DO UPDATE SET stock_qty=excluded.stock_qty,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP').run(productId,batchId,locationId,stockQty,reason);
      this.db.prepare('UPDATE amul_inventory_local SET stock_qty=? WHERE product_id=? AND batch_id=? AND location_id=?').run(stockQty,productId,batchId,locationId);
      const productStock=this.recomputeAmulProductStock(productId);
      return {...existing,stock_qty:stockQty,product_stock_qty:productStock,local_override:true};
    });
  }
  applyLocalPosConsumption() {
    const consumed=this.db.prepare('SELECT product_id,COALESCE(SUM(quantity),0) qty FROM amul_pos_sale_lines GROUP BY product_id').all();
    for(const row of consumed)if(row.qty>0)this.decrementAmulStock(row.product_id,row.qty,{strict:false});
  }
  createAmulPosSale(input={}) {
    const product=this.db.prepare('SELECT * FROM amul_products_local WHERE product_id=? AND active=1').get(String(input.productId || ''));
    if(!product)throw new Error('Amul product not found.');
    const quantity=Number(input.quantity || 0);
    if(!Number.isSafeInteger(quantity)||quantity<=0)throw new Error('Quantity must be a positive whole number.');
    if(Number(product.stock_qty)<quantity)throw new Error('Not enough local Amul stock.');
    const unitPrice=moneyToPaise(input.unitPrice ?? (product.mrp_paise || product.selling_price_paise)/100);
    if(unitPrice<=0)throw new Error('Selling price is required.');
    const total=quantity*unitPrice;
    const saleDate=ymd(input.saleDate) || new Date().toISOString().slice(0,10);
    const method=String(input.method || 'CASH').toUpperCase().slice(0,20);
    const notes=String(input.notes || '').slice(0,500);
    return inTransaction(this.db,()=>{
      const number='AMUL-POS-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8).toUpperCase();
      const saleId=Number(this.db.prepare('INSERT INTO amul_pos_sales(sale_number,sale_date,method,amount_paise,notes) VALUES(?,?,?,?,?)').run(number,saleDate,method,total,notes).lastInsertRowid);
      this.db.prepare('INSERT INTO amul_pos_sale_lines(sale_id,product_id,product_name,quantity,unit_price_paise,line_total_paise) VALUES(?,?,?,?,?,?)').run(saleId,String(product.product_id),product.product_name,quantity,unitPrice,total);
      this.decrementAmulStock(product.product_id,quantity);
      return {id:saleId,sale_number:number,total_paise:total};
    });
  }
  materializePurchases(run) {
    const suppliers=new Map(this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='suppliers'").all(run).map(r=>JSON.parse(r.payload)).map(r=>[String(r.SpmId),r]));
    const products=new Map(this.db.prepare('SELECT product_id,product_name FROM amul_products_local').all().map(r=>[String(r.product_id),r]));
    this.db.prepare('DELETE FROM amul_purchase_bills').run();
    const put=this.db.prepare('INSERT INTO amul_purchase_bills(purchase_id,bill_number,supplier_id,supplier_name,supplier_bill_number,bill_date,received_date,total_paise,tax_paise,paid_paise,status,payment_status,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const p of this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='purchases'").all(run).map(r=>JSON.parse(r.payload))) {
      const s=suppliers.get(String(p.SpmId)) || {};
      put.run(String(p.PurRcptId),p.PurRcptRefNo || '',String(p.SpmId || ''),s.SpmName || '',p.CmpInvNo || '',ymd(p.InvDate),ymd(p.GoodsRcvdDate),moneyToPaise(p.NetAmount),moneyToPaise(p.TaxAmount),moneyToPaise(p.PaidAmount),String(p.Status ?? ''),String(p.PaidStatus ?? ''),JSON.stringify(p));
    }
    this.db.prepare('DELETE FROM amul_purchase_lines').run();
    const putLine=this.db.prepare('INSERT INTO amul_purchase_lines(purchase_id,line_no,product_id,batch_id,quantity,mrp_paise,unit_cost_paise,tax_paise,net_paise,source_json) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for(const line of this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='purchase_lines'").all(run).map(r=>JSON.parse(r.payload))) {
      products.get(String(line.PrdId));
      putLine.run(String(line.PurRcptId),String(line.PrdSlNo),String(line.PrdId || ''),String(line.PrdBatId || ''),Number(line.RcvdGoodBaseQty || line.InvBaseQty || 0),moneyToPaise(line.PrdUnitMRP),moneyToPaise(line.PrdUnitNetRate || line.PrdUnitLSP),moneyToPaise(line.PrdTaxAmount),moneyToPaise(line.PrdNetAmount),JSON.stringify(line));
    }
  }
  materializeLocalSales(run) {
    const invoices=this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='invoices' ORDER BY ordinal").all(run).map(r=>JSON.parse(r.payload));
    const lines=this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='invoice_lines' ORDER BY ordinal").all(run).map(r=>JSON.parse(r.payload));
    const customers=new Map(this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='customers' ORDER BY ordinal").all(run).map(r=>JSON.parse(r.payload)).map(r=>[String(r.RtrId),r]));
    const routes=new Map(this.db.prepare("SELECT payload FROM amul_records WHERE run=? AND dataset='routes' ORDER BY ordinal").all(run).map(r=>JSON.parse(r.payload)).map(r=>[String(r.RMId),r]));
    const oldTracking=new Map(this.db.prepare('SELECT * FROM amul_invoice_tracking').all().map(r=>[String(r.sal_id),r]));
    const oldInvoices=new Map(this.db.prepare('SELECT sal_id,invoice_number,customer_name,mobile,order_ref,payment_status,paid_paise,payment_date,notes,local_deleted FROM amul_sales_invoices').all().map(r=>[String(r.sal_id),r]));
    const seen=new Set();
    const insert=this.db.prepare(`INSERT INTO amul_sales_invoices
      (sal_id,invoice_number,invoice_date,delivery_date,due_date,customer_id,customer_code,customer_name,mobile,route_id,route_name,order_ref,total_paise,source_paid_paise,payment_status,paid_paise,payment_date,notes,source_json,local_deleted,synced_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(sal_id) DO UPDATE SET invoice_number=excluded.invoice_number,invoice_date=excluded.invoice_date,delivery_date=excluded.delivery_date,due_date=excluded.due_date,
        customer_id=excluded.customer_id,customer_code=excluded.customer_code,customer_name=excluded.customer_name,mobile=excluded.mobile,route_id=excluded.route_id,route_name=excluded.route_name,
        order_ref=excluded.order_ref,total_paise=excluded.total_paise,source_paid_paise=excluded.source_paid_paise,source_json=excluded.source_json,synced_at=CURRENT_TIMESTAMP`);
    for(const inv of invoices) {
      const salId=String(inv.SalId);seen.add(salId);
      const customer=customers.get(String(inv.RtrId)) || {};
      const route=routes.get(String(inv.RMId || inv.DlvRMId)) || {};
      const total=moneyToPaise(inv.SalNetAmt);
      const sourcePaid=Math.min(total,moneyToPaise(inv.SalPayAmt));
      const old=oldTracking.get(salId) || oldInvoices.get(salId);
      const paid=old ? Math.min(total,old.paid_paise) : sourcePaid;
      const status=old?.payment_status || (paid>=total ? 'PAID' : paid>0 ? 'PARTIAL' : 'PENDING');
      insert.run(salId,old?.invoice_number || inv.SalInvNo,ymd(inv.SalInvDate),ymd(inv.SalDlvDate),addDays(ymd(inv.SalDlvDate || inv.SalInvDate),2),String(inv.RtrId || ''),
        customer.RtrCode || '',old?.customer_name || customer.RtrName || `Retailer ${inv.RtrId}`,old?.mobile || customer.RtrPhoneNo || customer.RtrResPhone1 || '',String(inv.RMId || inv.DlvRMId || ''),
        route.RMName || '',old?.order_ref || inv.SalInvNo || salId,total,sourcePaid,status,paid,old?.payment_date || null,old?.notes || '',JSON.stringify(inv),old?.local_deleted || 0);
    }
    for(const row of this.db.prepare('SELECT sal_id FROM amul_sales_invoices').all())if(!seen.has(String(row.sal_id)))this.db.prepare('DELETE FROM amul_sales_invoices WHERE sal_id=?').run(row.sal_id);
    this.db.prepare('DELETE FROM amul_sales_invoice_lines').run();
    const putLine=this.db.prepare(`INSERT INTO amul_sales_invoice_lines
      (sal_id,line_no,product_id,batch_id,quantity,free_quantity,unit_mrp_paise,unit_rate_paise,tax_paise,net_paise,source_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for(const line of lines)if(seen.has(String(line.SalId)))putLine.run(String(line.SalId),String(line.SlNo),String(line.PrdId || ''),String(line.PrdBatId || ''),
      Number(line.BaseQty || 0),Number(line.SalSchFreeQty || 0)+Number(line.SalManFreeQty || 0),moneyToPaise(line.PrdUnitMRP),moneyToPaise(line.PrdUnitSelRate),moneyToPaise(line.PrdTaxAmount),moneyToPaise(line.PrdNetAmount),JSON.stringify(line));
  }
  invoiceDetail(id) {
    const invoice=this.db.prepare('SELECT * FROM amul_sales_invoices WHERE sal_id=? AND local_deleted=0').get(String(id));
    if(!invoice) throw new Error('Invoice not found.');
    const items=this.db.prepare('SELECT l.*,p.product_name FROM amul_sales_invoice_lines l LEFT JOIN amul_products_local p ON p.product_id=l.product_id WHERE l.sal_id=? ORDER BY CAST(line_no AS INTEGER)').all(String(id));
    const batches=this.db.prepare('SELECT product_id,batch_id,product_name,batch_code,SUM(stock_qty) stock_qty,MAX(selling_price_paise) selling_price_paise FROM amul_inventory_local GROUP BY product_id,batch_id HAVING SUM(stock_qty)>0 OR batch_id IN (SELECT batch_id FROM amul_sales_invoice_lines WHERE sal_id=?) ORDER BY product_name,batch_code').all(String(id));
    return {invoice,items,batches};
  }
  billDetail(id) {
    const detail=this.invoiceDetail(id);
    const edit=this.db.prepare('SELECT original_json FROM amul_invoice_edits WHERE sal_id=?').get(String(id));
    const original=edit?JSON.parse(edit.original_json):detail;
    const header=JSON.parse(detail.invoice.source_json || '{}');
    const items=original.items.map(l=>{
      const raw=JSON.parse(l.source_json || '{}');
      const quantity=Number(raw.BaseQty ?? l.quantity),unitRate=Number(raw.PrdUnitSelRate ?? l.unit_rate_paise/100);
      const tax=moneyToPaise(raw.PrdTaxAmount ?? l.tax_paise/100),net=moneyToPaise(raw.PrdNetAmount ?? l.net_paise/100);
      const taxable=net-tax;
      const gross=moneyToPaise(quantity*unitRate);
      const purchase=this.db.prepare(`SELECT p.*,b.bill_number,b.bill_date FROM amul_purchase_lines p JOIN amul_purchase_bills b ON b.purchase_id=p.purchase_id WHERE p.product_id=? AND p.batch_id=? AND b.bill_date<=? ORDER BY b.bill_date DESC LIMIT 1`).get(l.product_id,l.batch_id,detail.invoice.invoice_date);
      return {...l,product_name:l.product_name || this.db.prepare('SELECT product_name FROM amul_products_local WHERE product_id=?').get(l.product_id)?.product_name,
        quantity,unit_rate_rupees:unitRate,unit_mrp_paise:moneyToPaise(raw.PrdUnitMRP ?? l.unit_mrp_paise/100),gross_paise:gross,
        taxable_paise:taxable,tax_paise:tax,net_paise:net,discount_or_adjustment_paise:gross-taxable,
        effective_tax_percent:taxable>0?Math.round(tax/taxable*10000)/100:null,
        purchase_reference:purchase || null};
    });
    const total=moneyToPaise(header.SalNetAmt ?? original.invoice.total_paise/100);
    return {invoice:detail.invoice,source_gstin:header.GSTIN || '',items,locally_corrected:!!edit,
      source_total_paise:total,source_tax_paise:header.SalTaxAmount==null?items.reduce((s,l)=>s+l.tax_paise,0):moneyToPaise(header.SalTaxAmount),
      header_adjustment_paise:total-items.reduce((s,l)=>s+l.net_paise,0),
      gst_components_available:false};
  }
  applyInvoiceStockAdjustments() {
    for(const r of this.db.prepare('SELECT * FROM amul_invoice_stock_adjustments').all()) {
      const row=this.db.prepare('SELECT rowid,stock_qty FROM amul_inventory_local WHERE product_id=? AND batch_id=? AND location_id=?').get(r.product_id,r.batch_id,r.location_id);
      if(!row || row.stock_qty+r.delta<0) throw new Error('An invoice stock correction conflicts with synced inventory. Review local invoice corrections.');
      this.db.prepare('UPDATE amul_inventory_local SET stock_qty=stock_qty+? WHERE rowid=?').run(r.delta,row.rowid);
      this.recomputeAmulProductStock(r.product_id);
    }
  }
  applyInvoiceEdits() {
    for(const edit of this.db.prepare('SELECT * FROM amul_invoice_edits').all()) {
      const lines=JSON.parse(edit.lines_json);
      this.db.prepare('DELETE FROM amul_sales_invoice_lines WHERE sal_id=?').run(edit.sal_id);
      const insert=this.db.prepare('INSERT INTO amul_sales_invoice_lines(sal_id,line_no,product_id,batch_id,quantity,free_quantity,unit_rate_paise,unit_mrp_paise,tax_paise,net_paise,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      lines.forEach((l,i)=>insert.run(edit.sal_id,String(i+1),l.product_id,l.batch_id,l.quantity,l.free_quantity || 0,l.unit_rate_paise,l.unit_mrp_paise || 0,l.tax_paise,l.net_paise,JSON.stringify(l)));
      const original=JSON.parse(edit.original_json);
      const headerAdjustment=original.invoice.total_paise-original.items.reduce((s,l)=>s+l.net_paise,0);
      const total=lines.reduce((s,l)=>s+l.net_paise,0)+headerAdjustment;
      this.db.prepare("UPDATE amul_sales_invoices SET total_paise=?,payment_status=CASE WHEN paid_paise>=? THEN 'PAID' WHEN paid_paise>0 THEN 'PARTIAL' ELSE 'PENDING' END WHERE sal_id=?").run(total,total,edit.sal_id);
    }
  }
  editInvoice(id,input) {
    return inTransaction(this.db,()=>{
      const before=this.invoiceDetail(id);
      if(!String(input.reason || '').trim()) throw new Error('Enter a reason for this correction.');
      if(!Array.isArray(input.items) || !input.items.length || input.items.length>200) throw new Error('Enter 1 to 200 invoice items.');
      const lines=input.items.map(l=>{
        const product=this.db.prepare('SELECT * FROM amul_products_local WHERE product_id=?').get(String(l.productId));
        const pack=l.unitCode?new (require('./product-units').ProductUnits)(this.db).normalize('AMUL',l.productId,l,product?.selling_price_paise/100):null;
        const quantity=pack?pack.quantity:Number(l.quantity), rate=pack?pack.baseRate:Number(l.unitPrice), tax=Number(l.taxAmount);
        if(!product || !Number.isSafeInteger(quantity) || quantity<=0 || !Number.isFinite(rate) || rate<0 || !Number.isFinite(tax) || tax<0) throw new Error('Each item needs a valid product, whole quantity, price and tax amount.');
        const adjustment=Number(l.adjustment || 0);
        const unit_rate_paise=Math.round(rate*100),tax_paise=Math.round(tax*100), net_paise=(pack?pack.amount:require('./product-units').linePaise(l.quantity,l.unitPrice))+tax_paise+Math.round(adjustment*100);
        if(!Number.isFinite(adjustment) || !Number.isSafeInteger(net_paise) || net_paise<0) throw new Error('Invalid line total or adjustment.');
        return {product_id:String(l.productId),batch_id:String(l.batchId || ''),quantity,free_quantity:Number(l.freeQuantity || 0),unit_rate_paise,tax_paise,net_paise,unit_mrp_paise:product.mrp_paise,unit_details:pack?.unit || {}};
      });
      if(lines.some(l=>!Number.isSafeInteger(l.free_quantity) || l.free_quantity<0)) throw new Error('Free quantity must be a whole number.');
      const total=lines.reduce((s,l)=>s+l.net_paise,0)+before.invoice.total_paise-before.items.reduce((s,l)=>s+l.net_paise,0);
      if(!Number.isSafeInteger(total) || total<before.invoice.paid_paise) throw new Error('Total cannot be below payments already recorded. Correct the payment first.');
      const quantities=new Map();
      for(const [items,sign] of [[before.items,1],[lines,-1]]) for(const l of items) {
        const key=JSON.stringify([l.product_id,l.batch_id]);
        quantities.set(key,(quantities.get(key)||0)+sign*(l.quantity+(l.free_quantity||0)));
      }
      for(const [key,delta] of quantities) {
        if(!delta) continue;
        const [productId,batchId]=JSON.parse(key);
        const stock=this.db.prepare('SELECT rowid,* FROM amul_inventory_local WHERE product_id=? AND batch_id=? ORDER BY stock_qty DESC').all(productId,batchId);
        if(!stock.length) throw new Error('Select an existing stock batch for each changed item.');
        let remaining=Math.abs(delta);
        for(const row of stock) {
          const amount=delta>0?remaining:Math.min(row.stock_qty,remaining);
          if(!amount) continue;
          const change=delta>0?amount:-amount;
          this.db.prepare('UPDATE amul_inventory_local SET stock_qty=stock_qty+? WHERE rowid=?').run(change,row.rowid);
          this.db.prepare('INSERT INTO amul_invoice_stock_adjustments VALUES(?,?,?,?,?) ON CONFLICT(sal_id,product_id,batch_id,location_id) DO UPDATE SET delta=delta+excluded.delta').run(String(id),productId,batchId,row.location_id,change);
          remaining-=amount;
          if(!remaining) break;
        }
        if(remaining) throw new Error('Insufficient stock for the increased invoice quantity.');
        this.recomputeAmulProductStock(productId);
      }
      this.db.prepare('INSERT INTO amul_invoice_edits(sal_id,original_json,lines_json,reason) VALUES(?,?,?,?) ON CONFLICT(sal_id) DO UPDATE SET lines_json=excluded.lines_json,reason=excluded.reason,updated_at=CURRENT_TIMESTAMP').run(String(id),JSON.stringify(before),JSON.stringify(lines),String(input.reason).trim());
      this.applyInvoiceEdits();
      this.db.prepare("INSERT INTO audit_log(actor,action,entity_type,entity_id,metadata_json) VALUES('Owner','UPDATE','AMUL_INVOICE',NULL,?)").run(JSON.stringify({salId:String(id),reason:input.reason,before,after:lines}));
      this.onChange();
      return this.invoiceDetail(id);
    });
  }
  amulInvoices({offset=0,limit=50,query=''}={}) {
    const today=new Date().toISOString().slice(0,10);
    const rows=this.db.prepare('SELECT * FROM amul_sales_invoices WHERE local_deleted=0 ORDER BY invoice_date DESC,sal_id DESC').all().map(row=>({...row,outstanding_paise:Math.max(0,row.total_paise-row.paid_paise),
      days_overdue:row.due_date && row.total_paise>row.paid_paise ? Math.max(0,Math.floor((Date.parse(today)-Date.parse(row.due_date))/86400000)) : 0}));
    const q=String(query || '').toLowerCase().trim();
    const filtered=q ? rows.filter(r=>Object.values(r).some(v=>String(v ?? '').toLowerCase().includes(q))) : rows;
    offset=Math.max(0,Math.floor(Number(offset)||0));limit=Math.min(200,Math.max(1,Math.floor(Number(limit)||50)));
    return {rows:filtered.slice(offset,offset+limit),total:filtered.length,offset,limit};
  }
  updateInvoiceTracking(salId,input={}) {
    const invoice=this.db.prepare('SELECT * FROM amul_sales_invoices WHERE sal_id=?').get(String(salId));
    if(!invoice)throw new Error('Amul invoice not found.');
    const status=String(input.paymentStatus || '').toUpperCase();
    if(!['PENDING','PARTIAL','PAID'].includes(status))throw new Error('Choose Pending, Partial or Paid.');
    const total=invoice.total_paise;
    const paid=status==='PAID' ? total : status==='PENDING' ? 0 : moneyToPaise(input.paidAmount);
    if(status==='PARTIAL' && (paid<=0 || paid>=total))throw new Error('Partial payment amount must be more than zero and less than invoice total.');
    if(paid>total)throw new Error('Paid amount cannot exceed invoice total.');
    const date=input.paymentDate ? ymd(input.paymentDate) : null;
    const notes=String(input.notes || '').slice(0,500);
    this.db.prepare(`INSERT INTO amul_invoice_tracking(sal_id,payment_status,paid_paise,payment_date,notes,updated_at)
      VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(sal_id) DO UPDATE SET payment_status=excluded.payment_status,paid_paise=excluded.paid_paise,payment_date=excluded.payment_date,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`)
      .run(String(salId),status,paid,date,notes);
    const invoiceNumber=String(input.invoiceNumber || invoice.invoice_number || '').slice(0,100);
    const orderRef=String(input.orderRef || invoice.order_ref || '').slice(0,100);
    const customerName=String(input.customerName || invoice.customer_name || '').slice(0,200);
    const mobile=String(input.mobile || invoice.mobile || '').slice(0,50);
    this.db.prepare('UPDATE amul_sales_invoices SET invoice_number=?,order_ref=?,customer_name=?,mobile=?,payment_status=?,paid_paise=?,payment_date=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE sal_id=?').run(invoiceNumber,orderRef,customerName,mobile,status,paid,date,notes,String(salId));
    return this.amulInvoices({query:String(invoice.invoice_number || salId),limit:1}).rows[0];
  }
  deleteInvoice(salId) {
    const row=this.db.prepare('UPDATE amul_sales_invoices SET local_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE sal_id=?').run(String(salId));
    if(!row.changes)throw new Error('Amul invoice not found.');
    return {deleted:true};
  }
  updateRetailer(retailerId,input={}) {
    const existing=this.db.prepare('SELECT * FROM amul_retailers WHERE retailer_id=? AND local_deleted=0').get(String(retailerId));
    if(!existing)throw new Error('Retailer not found.');
    const values={
      name:String(input.name || existing.retailer_name || '').slice(0,200),
      mobile:String(input.mobile || existing.mobile || '').slice(0,50),
      gstin:String(input.gstin || existing.gstin || '').slice(0,30),
      address:String(input.address || existing.address || '').slice(0,500),
      creditDays:Math.max(0,Math.floor(Number(input.creditDays ?? existing.credit_days) || 0)),
      creditLimit:moneyToPaise(input.creditLimit ?? existing.credit_limit_paise/100)
    };
    this.db.prepare('UPDATE amul_retailers SET retailer_name=?,mobile=?,gstin=?,address=?,credit_days=?,credit_limit_paise=? WHERE retailer_id=?').run(values.name,values.mobile,values.gstin,values.address,values.creditDays,values.creditLimit,String(retailerId));
    this.db.prepare('UPDATE amul_sales_invoices SET customer_name=?,mobile=? WHERE customer_id=?').run(values.name,values.mobile,String(retailerId));
    return this.db.prepare('SELECT * FROM amul_retailers WHERE retailer_id=?').get(String(retailerId));
  }
  deleteRetailer(retailerId) {
    const row=this.db.prepare('UPDATE amul_retailers SET local_deleted=1 WHERE retailer_id=?').run(String(retailerId));
    if(!row.changes)throw new Error('Retailer not found.');
    this.db.prepare('UPDATE amul_sales_invoices SET local_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE customer_id=?').run(String(retailerId));
    return {deleted:true};
  }
  retailerAccount(retailerId) {
    const customer=this.db.prepare('SELECT customer_id id,customer_code code,customer_name name,mobile,route_id FROM amul_sales_invoices WHERE customer_id=? LIMIT 1').get(String(retailerId));
    if(!customer)throw new Error('Retailer not found.');
    const rows=this.db.prepare('SELECT * FROM amul_sales_invoices WHERE customer_id=? ORDER BY invoice_date,sal_id').all(String(retailerId));
    let balance=0;
    const transactions=[];
    for(const row of rows) {
      balance+=row.total_paise;
      transactions.push({...row,type:'INVOICE',debit_paise:row.total_paise,credit_paise:0,balance_paise:balance,reference:row.order_ref});
      if(row.paid_paise>0) {
        balance-=row.paid_paise;
        transactions.push({...row,type:'PAYMENT',debit_paise:0,credit_paise:row.paid_paise,balance_paise:balance,reference:row.order_ref,date:row.payment_date || row.invoice_date});
      }
    }
    return {customer:{id:String(customer.id),code:customer.code,name:customer.name,mobile:customer.mobile,route_id:String(customer.route_id || '')},transactions,balance_paise:balance};
  }
  sync({full=false}={}) {
    if(this.running) return this.running;
    if(!this.enabled || this.stopped) return Promise.resolve(false);
    this.db.prepare('UPDATE amul_sync_state SET last_attempt=? WHERE id=1').run(new Date().toISOString());
    this.running=(async()=>{
      const run=randomUUID(),counts={};
      const saved=this.db.prepare('SELECT run FROM amul_active WHERE id=1').get();
      const state=this.db.prepare('SELECT source_checkpoint,start_date FROM amul_sync_state WHERE id=1').get();
      const startDate=process.env.FROSTFLOW_AMUL_START_DATE || AMUL_START_DATE;
      const incremental=!full && !!(saved.run && state.source_checkpoint && state.start_date===startDate);
      const copyPrevious=()=>{
        if(!incremental || !saved.run)return;
        const put=this.db.prepare('INSERT INTO amul_records(run,dataset,ordinal,payload) SELECT ?,dataset,ordinal,payload FROM amul_records WHERE run=? AND dataset IN (?,?,?,?)');
        put.run(run,saved.run,'invoices','invoice_lines','purchases','purchase_lines');
      };
      const transactionParents={invoices:new Set(),purchases:new Set()};
      const pendingTransactions={invoices:[],invoice_lines:[],purchases:[],purchase_lines:[]};
      try {
        copyPrevious();
        const stage=(name,rows)=>{
          if(!DATASETS.includes(name) || !Array.isArray(rows) || rows.some(r=>!r || typeof r!=='object' || Array.isArray(r)))throw new Error('Invalid snapshot');
          if(incremental && TRANSACTION_DATASETS.has(name)) {
            for(const row of rows) {
              if(name==='invoices')transactionParents.invoices.add(String(row.SalId));
              if(name==='invoice_lines')transactionParents.invoices.add(String(row.SalId));
              if(name==='purchases')transactionParents.purchases.add(String(row.PurRcptId));
              if(name==='purchase_lines')transactionParents.purchases.add(String(row.PurRcptId));
              pendingTransactions[name].push(row);
              counts[name]=(counts[name]||0)+1;
            }
            return;
          }
          inTransaction(this.db,()=>{
            if(!counts[name] && MASTER_DATASETS.has(name))this.db.prepare('DELETE FROM amul_records WHERE run=? AND dataset=?').run(run,name);
            const put=this.db.prepare('INSERT INTO amul_records VALUES(?,?,?,?)');
            for(const row of rows) {
              if(name==='invoices')transactionParents.invoices.add(String(row.SalId));
              if(name==='purchases')transactionParents.purchases.add(String(row.PurRcptId));
              put.run(run,name,counts[name]=(counts[name]||0)+1,JSON.stringify(row));
            }
          });
        };
        const env={...process.env,FROSTFLOW_AMUL_START_DATE:startDate};
        if(incremental)env.FROSTFLOW_AMUL_SINCE=state.source_checkpoint;
        const result=await this.read(stage,env);
        if(!result?.streamed) {
          for(const name of DATASETS){if(!Array.isArray(result?.datasets?.[name]))throw new Error('Incomplete snapshot');stage(name,result.datasets[name]);}
          result.metadata ||= {source_checkpoint:new Date().toISOString(),start_date:startDate};
        }
        result.metadata ||= {source_checkpoint:new Date().toISOString(),start_date:startDate};
        inTransaction(this.db,()=>{
          if(incremental) {
            const removeIds=(dataset,ids)=>{
              const idField=SOURCE_IDS[dataset];
              const del=this.db.prepare(`DELETE FROM amul_records WHERE run=? AND dataset=? AND CAST(json_extract(payload,'$.${idField}') AS TEXT)=?`);
              for(const id of ids)del.run(run,dataset,id);
            };
            removeIds('invoices',transactionParents.invoices);
            removeIds('invoice_lines',transactionParents.invoices);
            removeIds('purchases',transactionParents.purchases);
            removeIds('purchase_lines',transactionParents.purchases);
            const put=this.db.prepare('INSERT INTO amul_records VALUES(?,?,?,?)');
            for(const name of Object.keys(pendingTransactions)) {
              let ordinal=this.db.prepare('SELECT COALESCE(MAX(ordinal),0) n FROM amul_records WHERE run=? AND dataset=?').get(run,name).n;
              for(const row of pendingTransactions[name])put.run(run,name,++ordinal,JSON.stringify(row));
            }
            const rows=this.db.prepare(`SELECT rowid,dataset FROM amul_records WHERE run=? AND dataset IN ('invoices','invoice_lines','purchases','purchase_lines') ORDER BY dataset,rowid`).all(run);
            const reseq=this.db.prepare('UPDATE amul_records SET ordinal=? WHERE rowid=?');
            const perDataset={};
            for(const row of rows)reseq.run(perDataset[row.dataset]=(perDataset[row.dataset]||0)+1,row.rowid);
          }
          this.db.prepare('UPDATE amul_active SET run=? WHERE id=1').run(run);
          this.materializeLocal(run);
          this.db.prepare('UPDATE amul_sync_state SET last_success=?,error=NULL,source_checkpoint=?,start_date=?,sync_mode=? WHERE id=1').run(new Date().toISOString(),result.metadata.source_checkpoint,startDate,incremental?'incremental':'full-from-start-date');
        });
        this.failures=0; return true;
      } catch (error) {
        this.failures++;
        const detail=String(error?.message || '').slice(0,900);
        this.db.prepare('UPDATE amul_sync_state SET error=? WHERE id=1').run(detail ? `Sync failed. Previous data retained. ${detail}` : 'Sync failed. Previous data retained. Check connection, permissions, schema, or data limits.');
        return false;
      } finally {
        const active=this.db.prepare('SELECT run FROM amul_active WHERE id=1').get().run;
        // Cleanup in small batches so local POS requests can run between chunks.
        while(this.db.prepare('DELETE FROM amul_records WHERE rowid IN (SELECT rowid FROM amul_records WHERE run IS NOT ? LIMIT 1000)').run(active).changes)await new Promise(r=>setImmediate(r));
        this.running=null; this.onChange();
      }
    })();
    return this.running;
  }
  start() {
    if(!this.enabled || this.timer || this.stopped) return;
    const tick=async()=>{await this.sync();if(!this.stopped){this.timer=setTimeout(tick,Math.min(this.intervalMs*2**Math.min(this.failures,3),3600000));this.timer.unref();}};
    this.timer=setTimeout(tick,0);this.timer.unref();
  }
  async stop() {this.stopped=true;clearTimeout(this.timer);await this.running;}
}
module.exports={AmulSync,DATASETS,readAmul};
