const test=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase}=require('../src/db');
const {ERPService}=require('../src/services/erp-service');
const {ExcelService,SCHEMAS}=require('../src/services/excel-service');
const {writeWorkbook,readWorkbook}=require('../src/excel-codec');
const {businessToday,addDays}=require('../src/domain');

function fixture(t) {const db=openDatabase(':memory:');const erp=new ERPService(db);const excel=new ExcelService(erp);t.after(()=>db.close());return{db,erp,excel};}
async function upload(excel,type,rows) {
  const schema=SCHEMAS[type];const buffer=await writeWorkbook([{name:schema.sheet,headers:schema.headers,rows:rows.map(row=>schema.headers.map(h=>row[h]??''))}]);
  return excel.preview({type,filename:type+'.xlsx',base64:buffer.toString('base64')});
}
async function imported(excel,type,rows) {const preview=await upload(excel,type,rows);assert.equal(preview.valid,true,JSON.stringify(preview.errors));return excel.commit(preview.token);}
async function setup(excel) {
  await imported(excel,'products',[{SKU:'BAR',Name:'Chocolate bar','Purchase Price':20,'Wholesale Price':30,'Retail Price':40,'GST Percent':18,Barcode:'0000123'}]);
  await imported(excel,'customers',[{Code:'C001',Name:'Corner Store','State Code':'27','Credit Days':2}]);
  await imported(excel,'suppliers',[{Code:'S001',Name:'Frozen Supplier','State Code':'27'}]);
}

test('Excel purchase → distribution → receipt reconciles stock value, invoice and customer ledger',async t=>{
  const {erp,excel}=fixture(t);await setup(excel);
  await imported(excel,'purchases',[{'Purchase Number':'P100','Supplier Code':'S001','Bill Date':businessToday(),SKU:'BAR',Batch:'B1','Expiry Date':addDays(businessToday(),180),Quantity:10,'Unit Cost':20,'GST Percent':18}]);
  assert.equal(erp.inventorySummary().cost_value_paise,20000);
  await imported(excel,'invoices',[{'Invoice Number':'I100',Channel:'DISTRIBUTION','Customer Code':'C001','Invoice Date':businessToday(),'Delivery Date':businessToday(),SKU:'BAR',Quantity:4,'Unit Price':30,'GST Percent':18}]);
  assert.equal(erp.inventorySummary().stock_units,6);assert.equal(erp.inventorySummary().cost_value_paise,12000);
  assert.equal(erp.inventorySummary().wholesale_value_paise,18000);assert.equal(erp.inventorySummary().retail_value_paise,24000);
  assert.equal(erp.receivables().summary.receivable_paise,14160);
  await imported(excel,'payments',[{'Receipt Number':'R100',Direction:'RECEIPT','Party Code':'C001','Payment Date':businessToday(),Method:'UPI',Amount:100}]);
  assert.equal(erp.receivables().summary.receivable_paise,4160);assert.equal(erp.invoices()[0].outstanding_paise,4160);
  await imported(excel,'payments',[{'Receipt Number':'SP100',Direction:'PAYMENT','Party Code':'S001','Payment Date':businessToday(),Method:'BANK',Amount:236}]);
  assert.equal(erp.purchaseBills()[0].outstanding_paise,0);assert.equal(erp.listParties('SUPPLIER')[0].balance_paise,0);
});

test('preview uses actual posting validation but persists no business changes or audit rows',async t=>{
  const {excel,erp,db}=fixture(t);await setup(excel);const before=excel.revision();
  const preview=await upload(excel,'stock',[{SKU:'BAR',Batch:'COUNT','Expiry Date':addDays(businessToday(),30),Quantity:5,'Unit Cost':20,Reason:'Physical count'}]);
  assert.equal(preview.valid,true,JSON.stringify(preview.errors));assert.equal(preview.totals.stockUnitChange,5);assert.equal(preview.totals.stockValueChangePaise,10000);
  assert.equal(erp.inventorySummary().stock_units,0);assert.equal(excel.revision(),before);assert.equal(db.prepare('SELECT count(*) n FROM inventory_batches').get().n,0);
  excel.commit(preview.token);assert.equal(erp.inventorySummary().stock_units,5);
  assert.throws(()=>excel.commit(preview.token),/expired|committed/);
});

test('bad row invalidates whole import and duplicate rows do not partially update prices',async t=>{
  const {excel,erp}=fixture(t);await setup(excel);
  const preview=await upload(excel,'products',[{SKU:'BAR','Wholesale Price':45},{SKU:'NEW',Name:'New','Retail Price':-1}]);
  assert.equal(preview.valid,false);assert.equal(preview.token,null);assert.equal(erp.listProducts()[0].wholesale_price_paise,3000);assert.equal(erp.listProducts().length,1);
  const repeated=await upload(excel,'products',[{SKU:'BAR','Retail Price':50},{SKU:'BAR','Retail Price':60}]);assert.equal(repeated.valid,false);assert.match(repeated.errors[0].message,/Duplicate/);
});

test('a preview becomes stale when another operation changes business data; repeated files cannot repost',async t=>{
  const {excel,erp}=fixture(t);await setup(excel);
  const rows=[{SKU:'BAR','Retail Price':55}];const p=await upload(excel,'products',rows);
  erp.updateProduct(erp.listProducts()[0].id,{wholesalePrice:32});
  assert.throws(()=>excel.commit(p.token),/changed after this preview/);assert.equal(erp.listProducts()[0].retail_price_paise,4000);
  const newer=await upload(excel,'products',rows);excel.commit(newer.token);
  await assert.rejects(()=>upload(excel,'products',rows),/already been imported/);
});

test('stock import replaces listed batches only and never rewrites cost through price master',async t=>{
  const {excel,erp}=fixture(t);await setup(excel);
  await imported(excel,'stock',[{SKU:'BAR',Batch:'A',Quantity:7,'Unit Cost':20,Reason:'Opening count'},{SKU:'BAR',Batch:'B',Quantity:3,'Unit Cost':21,Reason:'Opening count'}]);
  await imported(excel,'products',[{SKU:'BAR','Purchase Price':27,'Wholesale Price':35,'Retail Price':45}]);
  assert.equal(erp.inventorySummary().cost_value_paise,20300);
  await imported(excel,'stock',[{SKU:'BAR',Batch:'A',Quantity:2,'Unit Cost':20,Reason:'Recount'}]);assert.equal(erp.inventorySummary().stock_units,5);assert.equal(erp.inventorySummary().cost_value_paise,10300);
  const bad=await upload(excel,'stock',[{SKU:'BAR',Batch:'A',Quantity:2,'Unit Cost':99,Reason:'Cannot silently revalue'}]);assert.equal(bad.valid,false);
});

test('exports preserve numeric amounts and text identifiers and include data past the old 200 row boundary',async t=>{
  const {excel,erp}=fixture(t);await setup(excel);
  for(let i=0;i<205;i++)erp.createParty({partyType:'CUSTOMER',name:'Customer '+i,code:'EX'+i});
  const sheets=await readWorkbook(await excel.export('products'),'Products.xlsx');const row=sheets[0].rows[1];
  assert.equal(row[2],'0000123');assert.equal(typeof row[7],'number');assert.equal(row[7],18);assert.equal(typeof row[8],'number');
  const contacts=await readWorkbook(await excel.export('customers'),'Customers.xlsx');assert.equal(contacts[0].rows.length,207);
  const report=await readWorkbook(await excel.export('inventory'),'Inventory.xlsx');assert.equal(typeof report[0].rows[1][1],'number');
});

test('opening customer receivables import is one-time and cannot overwrite a posted ledger',async t=>{
  const {excel,erp}=fixture(t);
  await imported(excel,'customers',[{Code:'OPEN',Name:'Opening customer','Opening Balance':1234.56,'Opening Date':businessToday(),'State Code':'07'}]);
  assert.equal(erp.receivables().summary.receivable_paise,123456);assert.equal(erp.receivables().customers[0].opening_unaged_paise,123456);
  const p=await upload(excel,'customers',[{Code:'OPEN','Opening Balance':50,'Opening Date':businessToday()}]);assert.equal(p.valid,false);assert.equal(erp.listParties('CUSTOMER')[0].balance_paise,123456);
});

test('column mistakes, malformed formula XLSX and inconsistent document headers fail clearly',async t=>{
  const {excel}=fixture(t);await setup(excel);
  await assert.rejects(()=>excel.preview({type:'products',filename:'bad.csv',base64:Buffer.from('SKU,,Retail Price\nBAR,lost value,30').toString('base64')}),/blank column heading/);
  await assert.rejects(()=>excel.preview({type:'products',filename:'bad.csv',base64:Buffer.from('SKU,SKU\nBAR,BAR').toString('base64')}),/Duplicate columns/);
  const p=await upload(excel,'purchases',[{'Purchase Number':'P1','Supplier Code':'S001','Bill Date':businessToday(),SKU:'BAR',Batch:'A',Quantity:2,'Unit Cost':20},{'Purchase Number':'P1','Supplier Code':'DIFFERENT','Bill Date':businessToday(),SKU:'BAR',Batch:'B',Quantity:2,'Unit Cost':20}]);
  assert.equal(p.valid,false);assert.match(p.errors[0].message,/differs within/);
});
