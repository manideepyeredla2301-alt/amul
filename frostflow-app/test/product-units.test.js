const test=require('node:test'),assert=require('node:assert/strict');
const {openDatabase}=require('../src/db');
const {ERPService}=require('../src/services/erp-service');
const {linePaise}=require('../src/services/product-units');
test('keyword search matches partial words and unordered words',()=>{const vm=require('node:vm'),fs=require('node:fs');const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../public/invoice-grid.js'),'utf8'),ctx);assert.equal(ctx.productKeywordMatch('Amul Butterscotch 500 ml','butt'),true);assert.equal(ctx.productKeywordMatch('Amul Butterscotch 500 ml','500 butt'),true);assert.equal(ctx.productKeywordMatch('Vanilla 500 ml','butt'),false);});
test('Amul packs use synced ratios without guessing unit labels and survive resync',async()=>{
 const {AmulSync,DATASETS}=require('../src/services/amul-sync');const db=openDatabase(':memory:'),erp=new ERPService(db);
 const datasets=Object.fromEntries(DATASETS.map(k=>[k,[]]));datasets.products=[{PrdId:1,PrdName:'Butterscotch',UomGroupId:7}];datasets.units=[{UomGroupId:7,UomId:5,BaseUom:'Y',ConversionFactor:1},{UomGroupId:7,UomId:4,BaseUom:'N',ConversionFactor:12}];datasets.batches=[{PrdId:1,PrdBatId:10}];datasets.stock=[{PrdId:1,PrdBatID:10,LcnId:1,PrdBatLcnSih:50}];datasets.invoices=[{SalId:1,SalInvNo:'B1',SalInvDate:'2026-09-09',SalNetAmt:10,RtrId:1}];datasets.invoice_lines=[{SalId:1,SlNo:1,PrdId:1,PrdBatId:10,BaseQty:1,PrdUnitSelRate:10,PrdNetAmount:10}];
 const sync=new AmulSync(db,{enabled:true,read:async()=>({datasets})});assert.equal(await sync.sync(),true);
 const amulUnits=erp.units.list('AMUL',1);assert.equal(amulUnits[0].label,'PC');assert.equal(amulUnits[1].label,'BOX');assert.equal(amulUnits[1].factor,12);
 sync.editInvoice('1',{reason:'Two packs',items:[{productId:1,batchId:10,unitCode:'UOM:4',quantity:2,unitPrice:120,taxAmount:12,freeQuantity:1}]});
 assert.equal(sync.invoiceDetail('1').items[0].quantity,24);assert.equal(sync.invoiceDetail('1').invoice.total_paise,25200);assert.equal(db.prepare('SELECT stock_qty FROM amul_products_local').get().stock_qty,26);
 await sync.sync({full:true});assert.equal(JSON.parse(sync.invoiceDetail('1').items[0].source_json).unit_details.factor,12);assert.equal(db.prepare('SELECT stock_qty FROM amul_products_local').get().stock_qty,26);db.close();
});
test('pack edits consume base stock, preserve pack rate and reject fractional consumption atomically',()=>{
 const db=openDatabase(':memory:'),erp=new ERPService(db);
 const p=erp.createProduct({sku:'BUTT',name:'Butterscotch',wholesalePrice:10,retailPrice:12,gstBps:500});
 erp.units.save('LOCAL',p.id,{reason:'Verified packaging',units:[{code:'BASE',label:'PC',factor:1},{code:'BOX',label:'BOX',factor:12},{code:'CRT',label:'CRT',factor:48}]});
 const supplier=erp.createParty({partyType:'SUPPLIER',name:'Supplier'}),customer=erp.createParty({name:'Customer'});
 erp.receivePurchase({supplierId:supplier.id,items:[{productId:p.id,quantity:100,unitCost:5,batchNumber:'B'}]});
 const sale=erp.createInvoice({channel:'DISTRIBUTION',customerId:customer.id,items:[{productId:p.id,quantity:1,unitPrice:10}]});
 erp.editInvoice(sale.id,{reason:'Two boxes',items:[{productId:p.id,unitCode:'BOX',unitFactor:12,quantity:2,unitPrice:120}]});
 const d=erp.invoiceDetail(sale.id);assert.equal(d.items[0].quantity,24);assert.equal(d.invoice.total_paise,25200);assert.equal(JSON.parse(d.items[0].unit_details).code,'BOX');assert.equal(erp.listProducts()[0].stock_qty,76);
 assert.throws(()=>erp.editInvoice(sale.id,{reason:'Invalid',items:[{productId:p.id,unitCode:'BOX',quantity:0.1,unitPrice:120}]}),/whole number/);
 assert.equal(erp.listProducts()[0].stock_qty,76);
 assert.throws(()=>erp.units.normalize('LOCAL',p.id,{unitCode:'BOX',unitFactor:24,quantity:1,unitPrice:120}),/changed/);
 assert.equal(erp.units.normalize('LOCAL',p.id,{unitCode:'BOX',quantity:0.5,unitPrice:120}).quantity,6);
 assert.equal(linePaise(32,'8.095238'),25905);db.close();
});
