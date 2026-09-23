'use strict';
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const crypto=require('node:crypto');

const root=path.resolve(__dirname,'..');
const databasePath=process.env.FROSTFLOW_DB || path.join(root,'data','amul-cloud-cache.sqlite');
const cloudUrl=String(process.env.FROSTFLOW_CLOUD_URL || '').replace(/\/$/,'');
const secret=String(process.env.FROSTFLOW_SYNC_SECRET || '');
const deviceId=String(process.env.FROSTFLOW_DEVICE_ID || 'amul-pc').trim();
const interval=Math.max(60_000,Number(process.env.FROSTFLOW_CLOUD_SYNC_INTERVAL_MS || 300_000));
if(!/^https:\/\//.test(cloudUrl))throw new Error('FROSTFLOW_CLOUD_URL must be an HTTPS URL.');
if(secret.length<32)throw new Error('FROSTFLOW_SYNC_SECRET must contain at least 32 characters.');

function category(name){const n=String(name).toLowerCase();if(/tricone|tricon/.test(n))return'Tricones';if(/stick|kulfi|chocobar|frostik/.test(n))return'Sticks & Kulfi';if(/\b60\s*ml\b/.test(n))return'60 ml Cups';if(/\b100\s*ml\b/.test(n))return'100 ml Cups';if(/cup/.test(n))return'Cups';if(/750\s*ml|combo/.test(n))return'750 ml & Combos';if(/tub|family|bulk|\b[125]\s*l\b/.test(n))return'Tubs & Family Packs';if(/butter|cheese|paneer|milk|ghee|curd|lassi/.test(n))return'Dairy';if(/chocolate|wafer/.test(n))return'Chocolates';if(/snack|fries|patty|samosa|nugget/.test(n))return'Frozen Snacks';return'Other';}
async function request(route,options={}){const response=await fetch(cloudUrl+route,{...options,headers:{authorization:'Bearer '+secret,...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})},signal:AbortSignal.timeout(30_000)});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`${route} failed: ${body.error || response.status}`);return body;}
function hasTable(db,name){return !!db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function ensureInbox(db){db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_order_requests(message_id TEXT PRIMARY KEY,customer_phone TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'REVIEW',received_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS invoice_job_requests(job_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',received_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`);}

function inventoryRows(db){
 const rows=[];
 if(hasTable(db,'amul_products_local'))for(const p of db.prepare('SELECT product_id,sku,product_name,stock_qty,mrp_paise,selling_price_paise,active,synced_at FROM amul_products_local ORDER BY product_id').all())rows.push({product_id:'AMUL:'+p.product_id,sku:p.sku||'',product_name:p.product_name,category:category(p.product_name),unit:'PCS',stock_qty:Number(p.stock_qty||0),mrp_paise:Number(p.mrp_paise||0),selling_price_paise:Number(p.selling_price_paise||0),active:!!p.active,source_updated_at:p.synced_at||''});
 if(hasTable(db,'products'))for(const p of db.prepare(`SELECT p.id,p.sku,p.name,p.category,p.unit,p.mrp_paise,p.retail_price_paise,p.wholesale_price_paise,p.active,p.updated_at,COALESCE(SUM(b.quantity_available),0) stock_qty FROM products p LEFT JOIN inventory_batches b ON b.product_id=p.id GROUP BY p.id ORDER BY p.id`).all())rows.push({product_id:'LOCAL:'+p.id,sku:p.sku||'',product_name:p.name,category:p.category||category(p.name),unit:p.unit||'PCS',stock_qty:Number(p.stock_qty||0),mrp_paise:Number(p.mrp_paise||p.retail_price_paise||0),selling_price_paise:Number(p.wholesale_price_paise||p.retail_price_paise||0),active:!!p.active,source_updated_at:p.updated_at||''});
 return rows;
}

function businessRows(db){
 const data={customers:[],routes:[],distribution_orders:[],invoices:[],payments:[]};
 if(hasTable(db,'parties'))for(const p of db.prepare(`SELECT p.*,COALESCE((SELECT SUM(l.debit_paise-l.credit_paise) FROM party_ledger_entries l WHERE l.party_id=p.id),0) balance_paise FROM parties p WHERE p.party_type IN ('CUSTOMER','BOTH')`).all())data.customers.push({id:'LOCAL:'+p.id,source:'LOCAL',source_id:String(p.id),code:p.code||'',name:p.name,mobile:p.mobile||'',whatsapp_number:p.whatsapp_number||'',gstin:p.gstin||'',address:p.address||'',city:p.city||'',route_id:'',route_name:'',credit_days:p.credit_days||0,credit_limit_paise:p.credit_limit_paise||0,balance_paise:p.balance_paise||0,active:!!p.active,source_updated_at:p.updated_at||p.created_at||''});
 if(hasTable(db,'amul_retailers'))for(const p of db.prepare(`SELECT r.*,COALESCE((SELECT SUM(MAX(0,i.total_paise-i.paid_paise)) FROM amul_sales_invoices i WHERE i.customer_id=r.retailer_id AND i.local_deleted=0),0) balance_paise FROM amul_retailers r WHERE r.local_deleted=0`).all())data.customers.push({id:'AMUL:'+p.retailer_id,source:'AMUL',source_id:String(p.retailer_id),code:p.retailer_code||'',name:p.retailer_name,mobile:p.mobile||'',whatsapp_number:p.mobile||'',gstin:p.gstin||'',address:p.address||'',city:'',route_id:p.route_id||'',route_name:p.route_name||'',credit_days:p.credit_days||0,credit_limit_paise:p.credit_limit_paise||0,balance_paise:p.balance_paise||0,active:!!p.active,source_updated_at:p.synced_at||''});
 if(hasTable(db,'amul_routes'))for(const r of db.prepare('SELECT * FROM amul_routes').all().filter(r=>!r.local_deleted))data.routes.push({id:'AMUL:'+r.route_id,source:'AMUL',source_id:String(r.route_id),code:r.route_code||'',name:r.route_name,active:!!r.active,source_updated_at:r.synced_at||''});
 if(hasTable(db,'sales_orders'))for(const o of db.prepare(`SELECT o.*,p.name customer_name,p.mobile,p.whatsapp_number FROM sales_orders o JOIN parties p ON p.id=o.customer_id ORDER BY o.id`).all()){const lines=db.prepare(`SELECT oi.product_id,p.name product_name,oi.quantity,oi.unit_price_paise,oi.gst_bps FROM sales_order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? ORDER BY oi.id`).all(o.id);data.distribution_orders.push({id:'LOCAL:'+o.id,source:'LOCAL',source_id:String(o.id),order_number:o.order_number,customer_id:'LOCAL:'+o.customer_id,customer_name:o.customer_name,phone:o.whatsapp_number||o.mobile||'',route_name:'',order_date:o.order_date||'',delivery_date:o.delivery_date||'',status:o.status,total_paise:lines.reduce((sum,line)=>sum+Math.round(Number(line.quantity)*Number(line.unit_price_paise)*(1+Number(line.gst_bps||0)/10000)),0),notes:o.notes||'',lines:lines.map(line=>({...line,product_id:'LOCAL:'+line.product_id})),source_updated_at:o.created_at||''});}
 if(hasTable(db,'invoices'))for(const i of db.prepare(`SELECT i.*,p.name customer_name,p.mobile,p.whatsapp_number,COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.invoice_id=i.id),0)+COALESCE((SELECT SUM(a.amount_paise) FROM opening_credit_allocations a WHERE a.invoice_id=i.id),0) allocated_paise,COALESCE((SELECT SUM(r.total_paise) FROM returns r WHERE r.invoice_id=i.id AND r.return_type='SALES_RETURN' AND r.status='POSTED'),0) returned_paise FROM invoices i LEFT JOIN parties p ON p.id=i.customer_id`).all()){const net=Math.max(0,Number(i.total_paise)-Number(i.returned_paise));const paid=Math.min(net,Number(i.allocated_paise));const outstanding=Math.max(0,net-paid);data.invoices.push({id:'LOCAL:'+i.id,source:'LOCAL',source_id:String(i.id),invoice_number:i.invoice_number,invoice_date:i.invoice_date||'',due_date:i.due_date||'',customer_id:i.customer_id?'LOCAL:'+i.customer_id:'',customer_name:i.customer_name||'Walk-in customer',mobile:i.whatsapp_number||i.mobile||'',route_name:'',total_paise:net,paid_paise:paid,outstanding_paise:outstanding,payment_status:outstanding===0?'PAID':paid>0?'PART_PAID':'UNPAID',status:i.status||'POSTED',source_updated_at:i.created_at||''});}
 if(hasTable(db,'amul_sales_invoices'))for(const i of db.prepare('SELECT * FROM amul_sales_invoices WHERE local_deleted=0').all()){const outstanding=Math.max(0,Number(i.total_paise)-Number(i.paid_paise));data.invoices.push({id:'AMUL:'+i.sal_id,source:'AMUL',source_id:String(i.sal_id),invoice_number:i.invoice_number||String(i.sal_id),invoice_date:i.invoice_date||'',due_date:i.due_date||'',customer_id:i.customer_id?'AMUL:'+i.customer_id:'',customer_name:i.customer_name||'Unknown retailer',mobile:i.mobile||'',route_name:i.route_name||'',total_paise:i.total_paise||0,paid_paise:i.paid_paise||0,outstanding_paise:outstanding,payment_status:outstanding===0?'PAID':Number(i.paid_paise)>0?'PART_PAID':'UNPAID',status:'POSTED',source_updated_at:i.updated_at||i.synced_at||''});}
 if(hasTable(db,'payments'))for(const p of db.prepare(`SELECT pay.*,party.name customer_name FROM payments pay LEFT JOIN parties party ON party.id=pay.party_id`).all())data.payments.push({id:'LOCAL:'+p.id,source:'LOCAL',source_id:String(p.id),receipt_number:p.receipt_number||'',payment_date:p.payment_date||'',customer_id:p.party_id?'LOCAL:'+p.party_id:'',customer_name:p.customer_name||'',direction:p.direction,method:p.method||'',amount_paise:p.amount_paise||0,reference_number:p.reference_number||'',source_updated_at:p.created_at||''});
 return data;
}

async function pushInventory(items,snapshotId,capturedAt){for(let offset=0;offset<items.length;offset+=40)await request('/api/sync/snapshot',{method:'POST',body:JSON.stringify({device_id:deviceId,snapshot_id:snapshotId,captured_at:capturedAt,complete:false,items:items.slice(offset,offset+40)})});await request('/api/sync/snapshot',{method:'POST',body:JSON.stringify({device_id:deviceId,snapshot_id:snapshotId,captured_at:capturedAt,complete:true,items:[]})});}
async function pushBusiness(data,snapshotId,capturedAt){for(const [dataset,rows] of Object.entries(data)){for(let offset=0;offset<rows.length;offset+=40)await request('/api/sync/business',{method:'POST',body:JSON.stringify({device_id:deviceId,snapshot_id:snapshotId,captured_at:capturedAt,dataset,complete:false,items:rows.slice(offset,offset+40)})});await request('/api/sync/business',{method:'POST',body:JSON.stringify({device_id:deviceId,snapshot_id:snapshotId,captured_at:capturedAt,dataset,complete:true,items:[]})});}}

async function syncOnce(){
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA busy_timeout=5000;');ensureInbox(db);
 try{
  const products=inventoryRows(db);if(!products.length)throw new Error('No FrostFlow or Amul products were found. Run the local Amul sync or add products first.');
  const snapshotId=crypto.randomUUID(),capturedAt=new Date().toISOString();
  await pushInventory(products,snapshotId,capturedAt);
  const data=businessRows(db);await pushBusiness(data,snapshotId,capturedAt);
  const {orders}=await request('/api/sync/orders');
  const insert=db.prepare('INSERT OR IGNORE INTO whatsapp_order_requests(message_id,customer_phone,payload,status) VALUES(?,?,?,\'REVIEW\')');
  for(const order of orders||[]){const result=insert.run('cloud:'+order.id,order.phone||'',JSON.stringify(order));if(result.changes)await request('/api/sync/orders/'+encodeURIComponent(order.id)+'/ack',{method:'POST'});}
  const {jobs}=await request('/api/sync/invoice-jobs');
  const putJob=db.prepare(`INSERT INTO invoice_job_requests(job_id,order_id,payload,status,updated_at) VALUES(?,?,?,'PENDING',CURRENT_TIMESTAMP)
    ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`);
  for(const job of jobs||[])putJob.run(job.id,job.order_id,job.payload_json);
  const counts=Object.fromEntries(Object.entries(data).map(([name,rows])=>[name,rows.length]));
  console.log(`[${new Date().toISOString()}] Central sync complete: ${products.length} products, ${JSON.stringify(counts)}, ${(orders||[]).length} queued orders, ${(jobs||[]).length} invoice jobs.`);
 }finally{db.close();}
}
async function run(){for(;;){try{await syncOnce();}catch(error){console.error(`[${new Date().toISOString()}] Cloud sync postponed: ${error.message}`);}if(process.argv.includes('--once'))break;await new Promise(resolve=>setTimeout(resolve,interval));}}
if(require.main===module)run().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={syncOnce,category,inventoryRows,businessRows};
