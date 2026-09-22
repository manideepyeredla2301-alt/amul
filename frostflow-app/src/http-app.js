const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createHash,timingSafeEqual} = require('node:crypto');
const {openDatabase,inTransaction,DB_PATH} = require('./db');
const {ERPService,AppError} = require('./services/erp-service');
const {ExcelService} = require('./services/excel-service');
const {AmulSync,DATASETS} = require('./services/amul-sync');
const {WhatsAppService} = require('./services/whatsapp');
const {CatalogueAdmin} = require('./services/catalogue-admin');
const PUBLIC_DIR=path.join(__dirname,'..','public');
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const CONFIG_KEYS=['company_name','company_gstin','company_state_code','company_address','company_phone','default_credit_days'];

function createApplication({
  dbPath=DB_PATH,
  amulOptions={},
  publicOrigin=process.env.FROSTFLOW_PUBLIC_ORIGIN || '',
  onlineUser=process.env.FROSTFLOW_ONLINE_USER || '',
  onlinePassword=process.env.FROSTFLOW_ONLINE_PASSWORD || '',
}={}) {
  let publicUrl=null;
  if(publicOrigin) {
    try { publicUrl=new URL(publicOrigin); } catch { throw new Error('FROSTFLOW_PUBLIC_ORIGIN must be a valid HTTPS origin.'); }
    if(publicUrl.protocol!=='https:' || publicUrl.pathname!=='/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password)
      throw new Error('FROSTFLOW_PUBLIC_ORIGIN must be an HTTPS origin without a path, query, or credentials.');
    if(!onlineUser || !onlinePassword)throw new Error('Online access requires FROSTFLOW_ONLINE_USER and FROSTFLOW_ONLINE_PASSWORD.');
    if(String(onlineUser).includes(':'))throw new Error('FROSTFLOW_ONLINE_USER cannot contain a colon.');
    if(String(onlinePassword).length<16)throw new Error('FROSTFLOW_ONLINE_PASSWORD must contain at least 16 characters.');
  }
  const onlineAuthorization=publicUrl?'Basic '+Buffer.from(`${onlineUser}:${onlinePassword}`).toString('base64'):'';
  const authorized=req=>{
    if(!onlineAuthorization)return true;
    const actual=createHash('sha256').update(String(req.headers.authorization || '')).digest();
    const expected=createHash('sha256').update(onlineAuthorization).digest();
    return timingSafeEqual(actual,expected);
  };
  const db=openDatabase(dbPath);
  const erp=new ERPService(db); const excel=new ExcelService(erp); const clients=new Set();
  const amul=new AmulSync(db,{...amulOptions,onChange:()=>{for(const res of clients)res.write('event: amul\ndata: {}\n\n');}});
  amul.start();
  const whatsapp=new WhatsAppService(db,erp);
  const inbox=new (require('./services/whatsapp-inbox').WhatsAppInbox)(db,whatsapp);
  const catalogue=new CatalogueAdmin(db,erp);
  const wholesaleCustomers=new (require('./services/wholesale-customers').WholesaleCustomers)(db,erp);
  const pos=new (require('./services/pos-checkout').PosCheckout)(db,erp,amul,catalogue);
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency_requests (request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
  function reply(res,status,body) {res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
  function broadcast() { const data=`event: change\ndata: ${JSON.stringify({revision:excel.revision()})}\n\n`; for(const res of clients) res.write(data); }
  function config() {return Object.fromEntries(CONFIG_KEYS.map(key=>[key,erp.setting(key) || '']));}
  function saveConfig(body) {
    return inTransaction(db,()=>{
      const values={...config(),...Object.fromEntries(Object.entries(body).filter(([k])=>CONFIG_KEYS.includes(k)))};
      if(!String(values.company_name).trim()) throw new AppError('Business name is required.');
      if(!/^\d{2}$/.test(values.company_state_code)) throw new AppError('State code must contain two digits.');
      if(!/^\d{1,3}$/.test(String(values.default_credit_days))) throw new AppError('Credit days must be a whole number from 0 to 999.');
      if(values.company_gstin && !/^[0-9A-Z]{15}$/.test(values.company_gstin)) throw new AppError('GSTIN must contain 15 uppercase letters and digits.');
      for(const [key,value] of Object.entries(values)) {
        if(String(value).length>500) throw new AppError(`${key} is too long.`);
        db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').run(key,String(value));
      }
      erp.audit('UPDATE','SETTINGS',null,{fields:Object.keys(body)}); return config();
    });
  }
  function mutate(req,pathname,body,work) {
    const key=req.headers['x-idempotency-key'];
    if(!key) return work();
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new AppError('Invalid request key.');
    const fingerprint=createHash('sha256').update(`${req.method}:${pathname}:${JSON.stringify(body)}`).digest('hex');
    return inTransaction(db,()=>{
      const prior=db.prepare('SELECT * FROM idempotency_requests WHERE request_key=?').get(key);
      if(prior) { if(prior.request_hash!==fingerprint) throw new AppError('This request key has already been used with different data.',409,'IDEMPOTENCY_CONFLICT'); return JSON.parse(prior.response_json); }
      const result=work();
      db.prepare('INSERT INTO idempotency_requests(request_key,request_hash,response_json) VALUES (?,?,?)').run(key,fingerprint,JSON.stringify(result));return result;
    });
  }
  async function readJson(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('Requests must use application/json.',415);
    let length=0;const chunks=[];
    for await(const chunk of req) {length+=chunk.length;if(length>7_500_000)throw new AppError('Request too large. Import a file under 5 MB.',413);chunks.push(chunk);}
    try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');if(!value || Array.isArray(value) || typeof value!=='object')throw new Error();return value;}catch{throw new AppError('Expected a JSON object.');}
  }
  async function download(res,promise,filename) {
    const content=await promise;res.writeHead(200,{...headers,'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${filename}"`,'Content-Length':content.length});res.end(content);
  }
  async function api(req,res,url) {
    const pathname=url.pathname;
    if(pathname==='/api/whatsapp/preview' && req.method==='POST')return reply(res,200,whatsapp.preview(await readJson(req)));
    if(pathname==='/api/whatsapp/inbox' && req.method==='GET')return reply(res,200,url.searchParams.has('phone')?inbox.thread(url.searchParams.get('phone')):inbox.list());
    if(pathname==='/api/whatsapp/reply' && req.method==='POST')return reply(res,200,await inbox.send(await readJson(req)));
    if(pathname==='/api/whatsapp/catalog' && req.method==='GET')return reply(res,200,{items:inbox.catalog().items.map(p=>({product_id:p.product_id,sku:p.sku,product_name:p.product_name,category:require('./services/whatsapp-inbox').category(p.product_name)}))});
    if(pathname==='/api/whatsapp/catalog' && req.method==='PATCH')return reply(res,200,inbox.saveCatalog(await readJson(req)));
    if(pathname==='/api/whatsapp/orders' && req.method==='GET')return reply(res,200,db.prepare('SELECT * FROM whatsapp_order_requests ORDER BY received_at DESC LIMIT 200').all());
    if(pathname==='/api/inventory/amul-search' && req.method==='GET')return reply(res,200,{rows:db.prepare(`SELECT i.product_id,i.batch_id,i.location_id,i.product_name,i.batch_code,i.expiry_date,i.stock_qty,i.unsaleable_qty,i.mrp_paise,i.selling_price_paise,p.sku,p.barcode FROM amul_inventory_local i LEFT JOIN amul_products_local p ON p.product_id=i.product_id ORDER BY i.product_name,i.batch_code,i.location_id`).all()});
    if(pathname==='/api/wholesale/customers' && req.method==='GET')return reply(res,200,wholesaleCustomers.rows());
    const unitMatch=pathname.match(/^\/api\/product-units\/(LOCAL|AMUL)\/([^/]+)$/);
    if(unitMatch && req.method==='GET')return reply(res,200,erp.units.list(unitMatch[1],decodeURIComponent(unitMatch[2])));
    if(unitMatch && req.method==='PATCH'){const result=erp.units.save(unitMatch[1],decodeURIComponent(unitMatch[2]),await readJson(req));broadcast();return reply(res,200,result);}
    if(pathname==='/api/pos/catalogue' && req.method==='GET')return reply(res,200,catalogue.rows());
    if(pathname==='/api/routes' && req.method==='GET')return reply(res,200,catalogue.routes());
    if(pathname==='/api/pos/catalogue' && req.method==='PATCH') {const result=catalogue.save(await readJson(req));broadcast();return reply(res,200,result);}
    if(pathname==='/api/whatsapp/config' && req.method==='GET')return reply(res,200,whatsapp.config());
    if(pathname==='/api/whatsapp/config' && req.method==='PATCH') {
      try{return reply(res,200,whatsapp.save(await readJson(req)));}catch(error){throw new AppError(error.message);}
    }
    if(pathname==='/api/whatsapp/history' && req.method==='GET')return reply(res,200,whatsapp.history());
    if(pathname==='/api/whatsapp/send-status' && req.method==='GET')return reply(res,200,whatsapp.status());
    if(pathname==='/api/whatsapp/send' && req.method==='POST')return reply(res,202,whatsapp.start(await readJson(req)));
    if(pathname==='/api/amul/status' && req.method==='GET')return reply(res,200,amul.status());
    if(pathname==='/api/amul/invoice-view' && req.method==='GET')return reply(res,200,{source:'AMUL',read_only:true,status:amul.status(),...amul.amulInvoices({offset:url.searchParams.get('offset'),query:url.searchParams.get('q') || ''})});
    const localAmulTables={products:'amul_products_local',inventory:'amul_inventory_local',retailers:'amul_retailers',routes:'amul_routes',purchases:'amul_purchase_bills',purchase_lines:'amul_purchase_lines'};
    let amulLocal=pathname.match(/^\/api\/amul-local\/([a-z_]+)$/);
    const exactLocal=pathname.match(/^\/api\/amul-local\/(products|retailers)\/([^/]+)$/);
    if(exactLocal && req.method==='GET') {
      const table=localAmulTables[exactLocal[1]],key=exactLocal[1]==='products'?'product_id':'retailer_id';
      const row=db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(decodeURIComponent(exactLocal[2]));
      if(!row)throw new AppError('Record not found.',404);
      return reply(res,200,row);
    }
    if(amulLocal && req.method==='GET') {
      const table=localAmulTables[amulLocal[1]];
      if(!table)return reply(res,404,{error:'Unknown Amul local table.'});
      return reply(res,200,{source:'AMUL_LOCAL',read_only:true,status:amul.status(),...amul.pageLocal(table,{offset:url.searchParams.get('offset'),query:url.searchParams.get('q') || ''})});
    }
    let amulMatch=pathname.match(/^\/api\/amul\/retailers\/([^/]+)\/account$/);
    const amulBill=pathname.match(/^\/api\/amul\/invoices\/([^/]+)\/bill$/);
    if(amulBill && req.method==='GET')return reply(res,200,amul.billDetail(decodeURIComponent(amulBill[1])));
    if(amulMatch && req.method==='GET')return reply(res,200,amul.retailerAccount(decodeURIComponent(amulMatch[1])));
    amulMatch=pathname.match(/^\/api\/amul\/invoices\/([^/]+)\/tracking$/);
    if(amulMatch && req.method==='PATCH')return reply(res,200,amul.updateInvoiceTracking(decodeURIComponent(amulMatch[1]),await readJson(req)));
    amulMatch=pathname.match(/^\/api\/amul\/invoices\/([^/]+)$/);
    if(amulMatch && req.method==='GET')return reply(res,200,amul.invoiceDetail(decodeURIComponent(amulMatch[1])));
    if(amulMatch && req.method==='PATCH')return reply(res,200,amul.editInvoice(decodeURIComponent(amulMatch[1]),await readJson(req)));
    if(amulMatch && req.method==='DELETE')return reply(res,200,amul.deleteInvoice(decodeURIComponent(amulMatch[1])));
    amulMatch=pathname.match(/^\/api\/amul\/retailers\/([^/]+)$/);
    if(amulMatch && req.method==='PATCH')return reply(res,200,amul.updateRetailer(decodeURIComponent(amulMatch[1]),await readJson(req)));
    if(amulMatch && req.method==='DELETE')return reply(res,200,amul.deleteRetailer(decodeURIComponent(amulMatch[1])));
    if(pathname==='/api/amul/pos-sales' && req.method==='POST')return reply(res,201,amul.createAmulPosSale(await readJson(req)));
    if(pathname==='/api/amul/inventory' && req.method==='PATCH')return reply(res,200,amul.updateInventoryStock(await readJson(req)));
    if(pathname==='/api/amul/inventory' && req.method==='GET') {
      const row=db.prepare('SELECT * FROM amul_inventory_local WHERE product_id=? AND batch_id=? AND location_id=?').get(url.searchParams.get('productId'),url.searchParams.get('batchId'),url.searchParams.get('locationId'));
      if(!row)throw new AppError('Stock row not found.',404);
      return reply(res,200,row);
    }
    if(pathname==='/api/amul/sync' && req.method==='POST') {
      const body=await readJson(req);
      if(!amul.enabled)throw new AppError('Start the app with Amul sync credentials configured.',409);
      void amul.sync({full:!!body.full});return reply(res,202,{accepted:true,mode:body.full?'full':'incremental'});
    }
    if(pathname.startsWith('/api/amul/')) {
      if(req.method!=='GET')return reply(res,405,{error:'Amul data is read-only.'});
      const name=pathname.slice('/api/amul/'.length);
      if(!DATASETS.includes(name))return reply(res,404,{error:'Unknown Amul dataset.'});
      return reply(res,200,{source:'AMUL',read_only:true,status:amul.status(),...amul.page(name,{offset:url.searchParams.get('offset'),query:url.searchParams.get('q') || ''})});
    }
    if(req.method==='GET' && pathname==='/api/events') {
      res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Connection':'keep-alive'});
      res.write(`event: ready\ndata: ${JSON.stringify({revision:excel.revision()})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    if(req.method==='GET') {
      const queries={
        '/api/health':()=>({ok:true,mode:'offline-first',version:'0.2.0',revision:excel.revision()}),
        '/api/bootstrap':()=>({products:erp.listProducts(),customers:erp.listParties('CUSTOMER'),suppliers:erp.listParties('SUPPLIER'),revision:excel.revision()}),
        '/api/config':config,'/api/dashboard':()=>erp.dashboard(),'/api/products':()=>erp.listProducts(),
        '/api/customers':()=>erp.listParties('CUSTOMER'),'/api/suppliers':()=>erp.listParties('SUPPLIER'),
        '/api/inventory':()=>erp.inventory(),'/api/inventory/summary':()=>erp.inventorySummary(),'/api/receivables':()=>erp.receivables(),
        '/api/invoices':()=>erp.invoices(),'/api/orders':()=>erp.orders(),'/api/purchases':()=>erp.purchaseBills(),
        '/api/payments':()=>erp.payments(),'/api/supplier-payments':()=>erp.payments().filter(p=>p.direction==='PAYMENT'),
        '/api/expenses':()=>erp.expenses(),'/api/returns':()=>erp.returns(),'/api/reports':()=>erp.reports(),
        '/api/audit':()=>erp.auditLog(),'/api/reminders':()=>erp.reminderHistory(),'/api/excel/history':()=>excel.history(),
      };
      if(queries[pathname]) return reply(res,200,queries[pathname]());
      let match=pathname.match(/^\/api\/parties\/(\d+)\/ledger$/);
      if(match)return reply(res,200,erp.partyLedger(match[1]));
      match=pathname.match(/^\/api\/invoices\/(\d+)$/);if(match)return reply(res,200,erp.invoiceDetail(match[1]));
      match=pathname.match(/^\/api\/purchases\/(\d+)$/);if(match)return reply(res,200,erp.purchaseDetail(match[1]));
      match=pathname.match(/^\/api\/excel\/templates\/([a-z]+)\.xlsx$/);if(match)return download(res,excel.template(match[1]),`FrostFlow-${match[1]}-template.xlsx`);
      match=pathname.match(/^\/api\/excel\/export\/([a-z]+)\.xlsx$/);if(match)return download(res,excel.export(match[1]),`FrostFlow-${match[1]}-${new Date().toISOString().slice(0,10)}.xlsx`);
      return reply(res,404,{error:'API endpoint not found.'});
    }
    if(!['POST','PATCH'].includes(req.method))return reply(res,405,{error:'Method not allowed.'});
    const body=await readJson(req);
    if(pathname==='/api/excel/preview' && req.method==='POST')return reply(res,200,await excel.preview(body));
    const routes={
      'POST /api/wholesale/invoices':()=>inTransaction(db,()=>erp.createInvoice({...body,channel:'DISTRIBUTION',customerId:wholesaleCustomers.resolve(body.customerId)})),
      'POST /api/products/import-amul':()=>erp.importAmulProducts(),
      'POST /api/inventory/import-amul':()=>erp.importAmulStock(),
      'POST /api/pos/checkout':()=>pos.post(body),
      'POST /api/products':()=>erp.createProduct(body),'POST /api/parties':()=>erp.createParty(body),
      'POST /api/orders':()=>erp.createOrder({...body,customerId:(String(body.customerId||'').includes(':')?wholesaleCustomers.resolve(body.customerId):body.customerId)}),'POST /api/invoices':()=>erp.createInvoice(body),
      'POST /api/purchases':()=>erp.receivePurchase(body),'POST /api/payments':()=>erp.recordReceipt(body),
      'POST /api/supplier-payments':()=>erp.recordSupplierPayment(body),'POST /api/expenses':()=>erp.recordExpense(body),
      'POST /api/inventory/adjustments':()=>erp.adjustStock(body),'POST /api/returns/sales':()=>erp.createSalesReturn(body),
      'POST /api/returns/purchase':()=>erp.createPurchaseReturn(body),'POST /api/reminders':()=>erp.queueReminder(body.invoiceId),
      'POST /api/excel/commit':()=>excel.commit(body.token),'PATCH /api/config':()=>saveConfig(body),
    };
    let action=routes[`${req.method} ${pathname}`];
    let match=pathname.match(/^\/api\/products\/(\d+)$/);if(match && req.method==='PATCH')action=()=>erp.updateProduct(match[1],body);
    match=pathname.match(/^\/api\/parties\/(\d+)$/);if(match && req.method==='PATCH')action=()=>erp.updateParty(match[1],body);
    match=pathname.match(/^\/api\/invoices\/(\d+)$/);if(match && req.method==='PATCH')action=()=>erp.editInvoice(match[1],body);
    match=pathname.match(/^\/api\/orders\/(\d+)\/deliver$/);if(match && req.method==='POST')action=()=>erp.deliverOrder(match[1],body.deliveryDate);
    if(pathname==='/api/backups' && req.method==='POST') {const result=erp.createBackup();broadcast();return reply(res,201,result);}
    if(pathname==='/api/demo-data' && req.method==='POST') action=()=>erp.seedDemo();
    if(!action)return reply(res,404,{error:'API endpoint not found.'});
    const result=pathname==='/api/pos/checkout'?inTransaction(db,()=>mutate(req,pathname,body,action)):mutate(req,pathname,body,action);broadcast();reply(res,req.method==='PATCH'?200:201,result);
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const port=server.address()?.port;
      const localHosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      const host=String(req.headers.host || '');
      const isLocal=localHosts.includes(host);
      const isPublic=!!publicUrl && host===publicUrl.host;
      if(!isLocal && !isPublic)throw new AppError('This application does not accept requests for this host.',403);
      if(isPublic && !authorized(req)) {
        res.writeHead(401,{...headers,'Content-Type':'application/json; charset=utf-8','WWW-Authenticate':'Basic realm="FrostFlow ERP", charset="UTF-8"'});
        return res.end(JSON.stringify({error:'Authentication required.'}));
      }
      const origin=req.headers.origin;
      const allowedOrigins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`,...(publicUrl?[publicUrl.origin]:[])];
      if(origin && !allowedOrigins.includes(origin))throw new AppError('Cross-site requests are not allowed.',403);
      const url=new URL(req.url,`http://127.0.0.1:${port}`);
      if(url.pathname.startsWith('/api/'))return await api(req,res,url);
      if(req.method!=='GET')return reply(res,405,{error:'Method not allowed.'});
      const filename=path.resolve(PUBLIC_DIR,`.${decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)}`);
      if(!filename.startsWith(PUBLIC_DIR+path.sep))throw new AppError('Forbidden',403);
      if(!MIME[path.extname(filename)])return reply(res,404,{error:'File not found.'});
      let content;try{content=await fs.promises.readFile(filename);}catch(error){return reply(res,error.code==='ENOENT'?404:500,{error:'File not found.'});}
      res.writeHead(200,{...headers,'Content-Type':MIME[path.extname(filename)]});res.end(content);
    }catch(error){
      if(res.headersSent){res.end();return;}
      const validation=error instanceof AppError || error.code==='EXCEL_ERROR';
      if(!validation)console.error('Request failed:',error.message);
      reply(res,error.status || (validation?400:500),{error:validation?error.message:'The operation could not be completed. No partial transaction was saved.',code:error.code || 'INTERNAL_ERROR'});
    }
  });
  const heartbeat=setInterval(()=>{for(const res of clients)res.write(': heartbeat\n\n');},20000);heartbeat.unref();
  const close=async()=>{await whatsapp.stop();await amul.stop();return new Promise(resolve=>{clearInterval(heartbeat);for(const res of clients)res.end();server.close(()=>{db.close();resolve();});});};
  return {server,erp,excel,db,amul,close};
}
module.exports={createApplication};
