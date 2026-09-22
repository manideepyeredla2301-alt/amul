const test=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase}=require('../src/db');
const {AmulSync,DATASETS}=require('../src/services/amul-sync');
const snapshot=(rows=[])=>({datasets:Object.fromEntries(DATASETS.map(n=>[n,n==='products'?rows:[]]))});
test('Amul refresh replaces cache, never POS records, and failed/partial reads preserve cache',async()=>{
 const db=openDatabase(':memory:');let result=snapshot([{PrdId:1,PrdName:'Source item'}]);
 const sync=new AmulSync(db,{enabled:true,read:async()=>result});
 assert.equal(await sync.sync(),true);assert.equal(sync.rows('products').length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,0);
 result={datasets:{products:[]}};assert.equal(await sync.sync(),false);
 assert.equal(sync.rows('products').length,1);assert.equal(sync.status().stale,true);
 result=snapshot();assert.equal(await sync.sync(),true);assert.equal(sync.rows('products').length,0);
 await sync.stop();db.close();
});
test('concurrent refresh requests share one read; disabled sync does not connect',async()=>{
 const db=openDatabase(':memory:');let calls=0,release;
 const sync=new AmulSync(db,{enabled:true,read:()=>{calls++;return new Promise(r=>release=r);}});
 const a=sync.sync(),b=sync.sync();assert.equal(calls,1);release(snapshot());await Promise.all([a,b]);
 await sync.stop();
 const disabled=new AmulSync(db,{enabled:false,read:()=>{throw new Error('Must not connect');}});
 assert.equal(await disabled.sync(),false);db.close();
});
test('full Amul sync ignores stored checkpoint and reports readable failures',async()=>{
 const db=openDatabase(':memory:');let envs=[],step=0;
 const sync=new AmulSync(db,{enabled:true,read:async(stage,env)=>{
   envs.push({...env});step++;
   if(step===4)throw new Error('Amul read failed at invoices: timeout');
   return snapshot();
 }});
 assert.equal(await sync.sync(),true);
 assert.equal(await sync.sync(),true);
 assert.equal(await sync.sync({full:true}),true);
 assert.ok(envs[1].FROSTFLOW_AMUL_SINCE);
 assert.equal(envs[2].FROSTFLOW_AMUL_SINCE,undefined);
 assert.equal(await sync.sync({full:true}),false);
 assert.match(sync.status().error,/Amul read failed at invoices: timeout/);
 await sync.stop();db.close();
});
test('Amul HTTP writes are rejected and local catalogue stays separate',async t=>{
 const {createApplication}=require('../src/http-app');
 const app=createApplication({dbPath:':memory:',amulOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/api/amul/products',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,405);
 assert.equal((await (await fetch(base+'/api/amul/status')).json()).read_only,true);
 assert.deepEqual(await (await fetch(base+'/api/products')).json(),[]);
});
test('streamed staging remains invisible until complete and pages/search are bounded',async()=>{
 const db=openDatabase(':memory:');
 const sync=new AmulSync(db,{enabled:true,read:async stage=>{
   stage('products',Array.from({length:125},(_,i)=>({PrdId:i,name:i===72?'literal%value':'item'})));
   assert.equal(sync.page('products').total,0);
   return {streamed:true};
 }});
 assert.equal(await sync.sync(),true);
 assert.equal(sync.page('products').rows.length,50);
 assert.equal(sync.page('products',{offset:100}).rows.length,25);
 assert.equal(sync.page('products',{query:'%'}).total,1);
 assert.equal(sync.page('products',{query:"' OR 1=1 --"}).total,0);
 await sync.stop();db.close();
});

test('incremental Amul sync keeps masters fresh and replaces changed transaction documents',async()=>{
 const db=openDatabase(':memory:');let step=0,envs=[];
 const sync=new AmulSync(db,{enabled:true,read:async(stage,env)=>{
   envs.push({...env});step++;
   if(step===1) {
     stage('products',[{PrdId:1,PrdName:'First name'}]);
     for(const name of DATASETS) {
       if(name==='products')continue;
       if(name==='invoices')stage(name,[{SalId:10,SalInvNo:'S-10',SalInvDate:'2026-09-05T00:00:00.000',LastModDate:'2026-09-05T10:00:00.000'}]);
       else if(name==='invoice_lines')stage(name,[{SalId:10,SlNo:1,PrdId:1,BaseQty:1}]);
       else stage(name,[]);
     }
     return {streamed:true,metadata:{source_checkpoint:'2026-09-05 12:00:00.000'}};
   }
   stage('products',[{PrdId:1,PrdName:'Updated master'}]);
   for(const name of DATASETS) {
     if(name==='products')continue;
     if(name==='invoices')stage(name,[{SalId:10,SalInvNo:'S-10-EDIT',SalInvDate:'2026-09-05T00:00:00.000',LastModDate:'2026-09-06T10:00:00.000'}]);
     else if(name==='invoice_lines')stage(name,[{SalId:10,SlNo:1,PrdId:1,BaseQty:3},{SalId:10,SlNo:2,PrdId:1,BaseQty:2}]);
     else if(name==='purchases')stage(name,[{PurRcptId:70,PurRcptRefNo:'P-70',InvDate:'2026-09-06T00:00:00.000'}]);
     else if(name==='purchase_lines')stage(name,[{PurRcptId:70,PrdSlNo:1,PrdId:1,RcvdGoodBaseQty:5}]);
     else stage(name,[]);
   }
   return {streamed:true,metadata:{source_checkpoint:'2026-09-06 12:00:00.000'}};
 }});
 assert.equal(await sync.sync(),true);
 assert.equal(await sync.sync(),true);
 assert.equal(envs[0].FROSTFLOW_AMUL_SINCE,undefined);
 assert.equal(envs[1].FROSTFLOW_AMUL_SINCE,'2026-09-05 12:00:00.000');
 assert.deepEqual(sync.rows('products'),[{PrdId:1,PrdName:'Updated master'}]);
 assert.deepEqual(sync.rows('invoices').map(r=>r.SalInvNo),['S-10-EDIT']);
 assert.equal(sync.rows('invoice_lines').length,2);
 assert.equal(sync.rows('purchases').length,1);
 assert.equal(sync.status().source_checkpoint,'2026-09-06 12:00:00.000');
 await sync.stop();db.close();
});

test('Amul invoice tracking is local and feeds retailer account transactions',async()=>{
 const db=openDatabase(':memory:');
 const sync=new AmulSync(db,{enabled:true,read:async stage=>{
   for(const name of DATASETS) {
     if(name==='customers')stage(name,[{RtrId:7,RtrCode:'RET7',RtrName:'Retailer Seven'}]);
     else if(name==='routes')stage(name,[{RMId:3,RMName:'Route 3'}]);
     else if(name==='invoices')stage(name,[{SalId:88,SalInvNo:'AMUL88',SalInvDate:'2026-09-05T00:00:00.000',SalDlvDate:'2026-09-05T00:00:00.000',RtrId:7,RMId:3,SalNetAmt:'100.00',SalPayAmt:'0.00'}]);
     else stage(name,[]);
   }
   return {streamed:true,metadata:{source_checkpoint:'2026-09-05 12:00:00.000'}};
 }});
 assert.equal(await sync.sync(),true);
 assert.equal(sync.amulInvoices().rows[0].payment_status,'PENDING');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM amul_sales_invoices').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM amul_sales_invoice_lines').get().n,0);
 sync.updateInvoiceTracking(88,{paymentStatus:'PARTIAL',paidAmount:'40.00',paymentDate:'2026-09-06',notes:'UPI pending balance'});
 const invoice=sync.amulInvoices().rows[0];
 assert.equal(invoice.payment_status,'PARTIAL');
 assert.equal(invoice.paid_paise,4000);
 assert.equal(invoice.outstanding_paise,6000);
 const account=sync.retailerAccount(7);
 assert.deepEqual(account.transactions.map(r=>[r.type,r.reference,r.debit_paise,r.credit_paise,r.balance_paise]),[
   ['INVOICE','AMUL88',10000,0,10000],
   ['PAYMENT','AMUL88',0,4000,6000],
 ]);
 await sync.stop();db.close();
});

test('Amul POS sale consumes local synced inventory only',async()=>{
 const db=openDatabase(':memory:');
 const sync=new AmulSync(db,{enabled:false});
 db.prepare("INSERT INTO amul_products_local(product_id,sku,code,product_name,batch_count,stock_qty,mrp_paise,selling_price_paise,active,source_json) VALUES('1','SKU1','C1','Amul Cup',1,5,1500,1250,1,'{}')").run();
 db.prepare("INSERT INTO amul_inventory_local(product_id,batch_id,product_name,batch_code,location_id,stock_qty,mrp_paise,selling_price_paise,source_json) VALUES('1','B1','Amul Cup','BATCH1','L1',5,1500,1250,'{}')").run();
 const sale=sync.createAmulPosSale({productId:'1',quantity:2,unitPrice:'12.50',method:'UPI',saleDate:'2026-09-12',notes:'counter'});
 assert.match(sale.sale_number,/^AMUL-POS-/);
 assert.equal(sale.total_paise,2500);
 assert.equal(db.prepare("SELECT stock_qty FROM amul_products_local WHERE product_id='1'").get().stock_qty,3);
 assert.equal(db.prepare("SELECT stock_qty FROM amul_inventory_local WHERE product_id='1'").get().stock_qty,3);
 assert.equal(db.prepare('SELECT amount_paise FROM amul_pos_sales').get().amount_paise,2500);
 assert.throws(()=>sync.createAmulPosSale({productId:'1',quantity:4,unitPrice:'12.50'}),/Not enough local Amul stock/);
 const mrpSale=sync.createAmulPosSale({productId:'1',quantity:2,method:'CASH'});
 assert.equal(mrpSale.total_paise,3000,'Retail total uses quantity times MRP, without extra tax');
 assert.equal(db.prepare("SELECT stock_qty FROM amul_products_local WHERE product_id='1'").get().stock_qty,1);
 await sync.stop();db.close();
});

test('manual Amul local stock edit updates inventory and product total',async()=>{
 const db=openDatabase(':memory:');
 const sync=new AmulSync(db,{enabled:false});
 db.prepare("INSERT INTO amul_products_local(product_id,sku,code,product_name,batch_count,stock_qty,mrp_paise,selling_price_paise,active,source_json) VALUES('1','SKU1','C1','Amul Cup',2,8,1500,1250,1,'{}')").run();
 db.prepare("INSERT INTO amul_inventory_local(product_id,batch_id,product_name,batch_code,location_id,stock_qty,mrp_paise,selling_price_paise,source_json) VALUES('1','B1','Amul Cup','BATCH1','L1',5,1500,1250,'{}')").run();
 db.prepare("INSERT INTO amul_inventory_local(product_id,batch_id,product_name,batch_code,location_id,stock_qty,mrp_paise,selling_price_paise,source_json) VALUES('1','B2','Amul Cup','BATCH2','L1',3,1500,1250,'{}')").run();
 const updated=sync.updateInventoryStock({productId:'1',batchId:'B1',locationId:'L1',stockQty:9,reason:'manual count'});
 assert.equal(updated.stock_qty,9);
 assert.equal(updated.product_stock_qty,12);
 assert.equal(db.prepare("SELECT stock_qty FROM amul_inventory_local WHERE product_id='1' AND batch_id='B1' AND location_id='L1'").get().stock_qty,9);
 assert.equal(db.prepare("SELECT stock_qty FROM amul_products_local WHERE product_id='1'").get().stock_qty,12);
 assert.equal(db.prepare("SELECT reason FROM amul_inventory_overrides WHERE product_id='1' AND batch_id='B1' AND location_id='L1'").get().reason,'manual count');
 assert.throws(()=>sync.updateInventoryStock({productId:'1',batchId:'B1',locationId:'L1',stockQty:-1}),/Stock must be zero or more/);
 await sync.stop();db.close();
});
