const test=require('node:test'),assert=require('node:assert/strict');
const {createApplication}=require('../server');
const {DATASETS}=require('../src/services/amul-sync');
test('mixed POS checkout is atomic, validates MRP and payment, and retries without duplicates',async t=>{
 const app=createApplication({dbPath:':memory:',amulOptions:{enabled:false}});t.after(()=>app.close());
 const p=app.erp.createProduct({sku:'POS-LOCAL',name:'Local cup',mrpPrice:40,gstBps:1800});const s=app.erp.createParty({name:'Supplier',partyType:'SUPPLIER'});app.erp.receivePurchase({supplierId:s.id,items:[{productId:p.id,quantity:10,unitCost:20,batchNumber:'B'}]});
 const datasets=Object.fromEntries(DATASETS.map(k=>[k,[]]));datasets.products=[{PrdId:1,PrdName:'Amul cup'}];datasets.batches=[{PrdId:1,PrdBatId:10}];datasets.stock=[{PrdId:1,PrdBatID:10,LcnId:1,PrdBatLcnSih:10}];
 app.amul.enabled=true;app.amul.read=async()=>({datasets});await app.amul.sync();app.db.prepare('UPDATE amul_products_local SET mrp_paise=5000').run();
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port+'/api/pos/checkout';
 const body={items:[{source:'LOCAL',productId:String(p.id),quantity:2,unitPricePaise:4000},{source:'AMUL',productId:'1',quantity:1,unitPricePaise:5000}],method:'CASH',amount:130};
 const post=(b,key)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Idempotency-Key':key},body:JSON.stringify(b)});
 assert.equal((await post({...body,amount:129},'bad-payment-123')).status,400);assert.equal(app.erp.invoices().length,0);
 const fail=app.amul.createAmulPosSale;app.amul.createAmulPosSale=()=>{throw new Error('Simulated stock conflict');};assert.equal((await post(body,'failure-test-123')).status,500);assert.equal(app.erp.invoices().length,0);assert.equal(app.erp.listProducts()[0].stock_qty,10);app.amul.createAmulPosSale=fail;
 const a=await post(body,'success-test-123');assert.equal(a.status,201);const receipt=await a.json();assert.equal(receipt.total_paise,13000);assert.equal(receipt.items.length,2);assert.equal(app.erp.listProducts()[0].stock_qty,8);
 assert.deepEqual(await (await post(body,'success-test-123')).json(),receipt);assert.equal(app.erp.invoices().length,1);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM amul_pos_sales').get().n,1);
 assert.equal((await post({...body,items:[{...body.items[0],quantity:1.5}]},'fraction-test-123')).status,400);
 assert.equal((await post({...body,items:[{...body.items[0],unitPricePaise:1}]},'price-test-123')).status,409);
});
