import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.CAFE_TEST_BASE_URL || 'http://localhost:8790';
const ownerPassword = process.env.CAFE_TEST_PASSWORD;
if (!ownerPassword) throw new Error('Set CAFE_TEST_PASSWORD for an isolated local database');

let ownerCookie = '';
let cashierCookie = '';
const results = [];

async function api(path, {method='GET', body, cookie='', raw=false}={}) {
  const headers = cookie ? {Cookie:cookie} : {};
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type']='application/json';
  const response = await fetch(new URL(path,base), {
    method,headers,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body),
  });
  const data = raw ? await response.arrayBuffer() :
    (response.headers.get('content-type')||'').includes('application/json') ? await response.json() : await response.text();
  return {response,data};
}

async function ok(path,options={},expected=200) {
  const result=await api(path,options);
  assert.equal(result.response.status,expected,`${options.method||'GET'} ${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function check(label,fn) {
  await fn();
  results.push(label);
  console.log(`PASS ${String(results.length).padStart(2)} ${label}`);
}

function qrOrder(items, extra={}) {
  return {request_id:randomUUID(),qr_code_id:'table-7',service_type:'DINE_IN',customer_name:'Local QA',
    table_number:'7',items,...extra};
}
function posOrder(items,extra={}) {
  return {request_id:randomUUID(),service_type:'COUNTER',customer_name:'Local QA',items,...extra};
}
const line=(item_id,quantity=1,options={})=>({item_id,quantity,options});

const menu=await check('Seeded customer menu and all 68 products',async()=>{
  const data=await ok('/api/cafe/menu');
  assert.ok(data.categories.reduce((n,c)=>n+c.items.length,0)>=68);
  assert.equal(data.categories.find(c=>c.id==='burgers').items.find(x=>x.id==='classic-veg-burger').price_paise,9000);
  assert.equal(data.categories.find(c=>c.id==='burgers').items.find(x=>x.id==='classic-chicken-burger').price_paise,12000);
  assert.ok(data.categories.every(c=>c.items.every(p=>!Object.hasOwn(p,'cost_paise'))));
});

await check('Owner login and protected admin API',async()=>{
  const result=await api('/api/cafe/staff/login',{method:'POST',body:{username:'rachana',password:ownerPassword}});
  assert.equal(result.response.status,200,JSON.stringify(result.data));
  ownerCookie=result.response.headers.get('set-cookie')?.split(';')[0]||'';
  assert.ok(ownerCookie);
  assert.equal((await ok('/api/cafe/staff/session',{cookie:ownerCookie})).role,'OWNER');
  const denied=await api('/api/cafe/admin/products');
  assert.equal(denied.response.status,401);
});

await check('POS customer phone is private and printed on the bill',async()=>{
  const order=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line('classic-veg-burger')],{customer_name:'Phone QA',customer_phone:'98765 43210'})},201);
  const detail=await ok(`/api/cafe/pos/orders/${order.id}`,{cookie:ownerCookie});
  assert.equal(detail.order.customer_phone,'+919876543210');
  const history=await ok('/api/cafe/pos/orders',{cookie:ownerCookie});
  assert.equal(history.orders.find(entry=>entry.id===order.id).customer_phone,'+919876543210');
  const receipt=await api(`/api/cafe/pos/orders/${order.id}/receipt`,{cookie:ownerCookie});
  assert.match(receipt.data,/\+919876543210/);
  const publicTracking=await ok(`/api/cafe/orders/${order.tracking_token}`);
  assert.equal(Object.hasOwn(publicTracking.order,'customer_phone'),false);
  const kitchen=await ok('/api/cafe/admin/orders',{cookie:ownerCookie});
  assert.equal(Object.hasOwn(kitchen.orders.find(entry=>entry.id===order.id),'customer_phone'),false);
  const invalid=await api('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line('classic-veg-burger')],{customer_phone:'12345'})});
  assert.equal(invalid.response.status,400);
});

await check('Held cart keeps the customer phone for resume',async()=>{
  const held=await ok('/api/cafe/pos/holds',{method:'POST',cookie:ownerCookie,
    body:{cart:[line('classic-cold-coffee')],customer_name:'Hold QA',customer_phone:'+91 98765 43210',service_type:'COUNTER'}},201);
  assert.equal(held.hold.customer_phone,'+919876543210');
  const list=await ok('/api/cafe/pos/holds',{cookie:ownerCookie});
  assert.equal(list.holds.find(entry=>entry.id===held.hold.id).customer_phone,'+919876543210');
  await ok(`/api/cafe/pos/holds/${held.hold.id}`,{method:'DELETE',cookie:ownerCookie});
});

await check('Curated Amul catalogue appears only in staff POS',async()=>{
  const publicMenu=await ok('/api/cafe/menu');
  assert.ok(publicMenu.categories.every(c=>c.items.every(p=>!p.id.startsWith('amul-'))));
  const posMenu=await ok('/api/cafe/pos/catalog',{cookie:ownerCookie});
  const packaged=posMenu.categories.flatMap(c=>c.items).filter(p=>p.id.startsWith('amul-'));
  assert.equal(packaged.length,243);
  const cone=packaged.find(p=>p.id==='amul-ictrbch45');
  assert.equal(cone.price_paise,5000);
  assert.equal(cone.available,true);
  const photo=await api('/images/ICTRBCH45.jpg',{raw:true});
  assert.equal(photo.response.status,200);
});

await check('Opening stock sells one pack and deducts one batch unit',async()=>{
  const id='amul-ictrbch45';
  const before=await ok('/api/cafe/admin/products',{cookie:ownerCookie});
  assert.equal(before.products.find(p=>p.id===id).stock_quantity,20);
  const sale=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line(id)],{source:'RETAIL',payments:[{method:'CASH',amount_paise:5000}]})},201);
  assert.equal(sale.status,'COMPLETED');
  const after=await ok('/api/cafe/admin/products',{cookie:ownerCookie});
  assert.equal(after.products.find(p=>p.id===id).stock_quantity,19);
  const stock=await ok('/api/cafe/admin/inventory',{cookie:ownerCookie});
  assert.equal(stock.batches.find(b=>b.product_id===id).quantity,19);
});

await check('Table 7 QR context and frappe order',async()=>{
  const code=await ok('/api/cafe/qr/table-7');
  assert.equal(code.table_number,'7');
  const order=await ok('/api/cafe/orders',{method:'POST',body:qrOrder([line('classic-cafe-frappe')])},201);
  globalThis.tableOrder=order;
  assert.equal(order.total_paise,12900);
  const tracking=await ok(`/api/cafe/orders/${order.tracking_token}`);
  assert.equal(tracking.order.table_number,'7');
  assert.equal(tracking.items[0].item_id,'classic-cafe-frappe');
  assert.equal(tracking.order.payment_status,'UNPAID');
});

await check('Kitchen queue, cook steps, and live status',async()=>{
  const list=await ok('/api/cafe/admin/orders',{cookie:ownerCookie});
  const found=list.orders.find(o=>o.id===globalThis.tableOrder.id);
  assert.ok(found);
  assert.equal(found.items[0].item_id,'classic-cafe-frappe');
  assert.ok(found.items[0].prep_steps.length);
  const event=await ok('/api/cafe/admin/events?since=0',{cookie:ownerCookie});
  assert.ok(event.version>0);
  for (const status of ['ACCEPTED','PREPARING','READY']) {
    await ok(`/api/cafe/admin/orders/${globalThis.tableOrder.id}/status`,{method:'POST',cookie:ownerCookie,body:{status}});
    const tracked=await ok(`/api/cafe/orders/${globalThis.tableOrder.tracking_token}`);
    assert.equal(tracked.order.status,status);
  }
});

await check('Veg burger and cheese ₹100',async()=>{
  const order=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line('classic-veg-burger',1,{'burger-cheese':true})])},201);
  assert.equal(order.total_paise,10000);
});
await check('Chicken burger and cheese ₹130',async()=>{
  const order=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line('classic-chicken-burger',1,{'burger-cheese':true})])},201);
  assert.equal(order.total_paise,13000);
});

await check('Double-scoop sundae customization and pricing',async()=>{
  const options={'sundae-size':'double','sundae-serving':'waffle-bowl',
    'sundae-flavors':['Vanilla','Chocolate Brownie'],
    'sundae-sauce':['Chocolate Fudge','Caramel'],
    'sundae-topping':['Cashews','Oreo Crumbs'],
    'sundae-extras':['additional-sauce','additional-topping','whipped-cream']};
  const order=await ok('/api/cafe/orders',{method:'POST',body:qrOrder([line('build-your-own-sundae',1,options)])},201);
  assert.equal(order.total_paise,19500);
  const invalid=await api('/api/cafe/orders',{method:'POST',body:qrOrder([line('build-your-own-sundae',1,
    {...options,'sundae-serving':'waffle-cone'})])});
  assert.equal(invalid.response.status,400);
});

const suffix=randomUUID().slice(0,8);
const categoryId=`qa-category-${suffix}`;
const retailId=`qa-retail-${suffix}`;
const newId=`qa-new-${suffix}`;
const exactId=`qa-exact-${suffix}`;
const barcode=`QA${suffix.toUpperCase()}`;

await check('Admin creates category, uploads image, adds product',async()=>{
  const cat=await ok('/api/cafe/admin/categories',{method:'POST',cookie:ownerCookie,
    body:{id:categoryId,name:`QA Specials ${suffix}`,show_qr:true,show_pos:true}},201);
  assert.equal(cat.category.id,categoryId);
  const tinyPng=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64'));
  const form=new FormData();
  form.set('file',new Blob([tinyPng],{type:'image/png'}),'qa.png');
  const uploaded=await ok('/api/cafe/admin/images',{method:'POST',cookie:ownerCookie,body:form},201);
  assert.match(uploaded.url,/^\/api\/cafe\/images\/[a-f0-9]{32}$/);
  const served=await api(uploaded.url,{raw:true});
  assert.equal(served.response.status,200);
  assert.deepEqual(Buffer.from(served.data),Buffer.from(tinyPng));
  const product=await ok('/api/cafe/admin/products',{method:'POST',cookie:ownerCookie,
    body:{id:newId,name:`QA Dessert ${suffix}`,category_id:categoryId,type:'PREPARED',price_paise:7500,
      image_url:uploaded.url,prep_steps:['Assemble the cup','Serve chilled']}},201);
  assert.equal(product.product.image_url,uploaded.url);
  const publicMenu=await ok('/api/cafe/menu');
  assert.ok(publicMenu.categories.find(c=>c.id===categoryId)?.items.some(p=>p.id===newId));
  const posMenu=await ok('/api/cafe/pos/catalog',{cookie:ownerCookie});
  assert.ok(posMenu.categories.find(c=>c.id===categoryId)?.items.some(p=>p.id===newId));
});

await check('Sold-out product cannot be ordered',async()=>{
  await ok(`/api/cafe/admin/products/${newId}`,{method:'PATCH',cookie:ownerCookie,body:{available:false}});
  const order=await api('/api/cafe/orders',{method:'POST',body:qrOrder([line(newId)])});
  assert.equal(order.response.status,409);
});

await check('Retail barcode, stock deduction, and no kitchen entry',async()=>{
  const created=await ok('/api/cafe/admin/products',{method:'POST',cookie:ownerCookie,
    body:{id:retailId,name:`QA Cup ${suffix}`,category_id:'retail-cups',type:'RETAIL',price_paise:15000,
      mrp_paise:15000,barcode,track_stock:true,stock_quantity:5,brand:'Amul',pack_size:'100 ml'}},201);
  assert.equal(created.product.stock_quantity,5);
  const lookup=await ok(`/api/cafe/pos/lookup?barcode=${barcode}`,{cookie:ownerCookie});
  assert.equal(lookup.product.id,retailId);
  const order=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line(retailId)],{source:'RETAIL',payments:[{method:'CASH',amount_paise:15000}]})},201);
  globalThis.retailOrder=order;
  assert.equal(order.status,'COMPLETED');
  const after=await ok('/api/cafe/admin/products',{cookie:ownerCookie});
  assert.equal(after.products.find(p=>p.id===retailId).stock_quantity,4);
  const kitchen=await ok('/api/cafe/admin/orders',{cookie:ownerCookie});
  assert.ok(!kitchen.orders.some(o=>o.id===order.id));
  const detail=await ok(`/api/cafe/pos/orders/${order.id}`,{cookie:ownerCookie});
  assert.equal(detail.order.payment_status,'PAID');
});

await check('QR retail order reaches staff for pickup',async()=>{
  await ok('/api/cafe/admin/categories/retail-cups',{method:'PATCH',cookie:ownerCookie,body:{show_qr:true}});
  const order=await ok('/api/cafe/orders',{method:'POST',body:qrOrder([line(retailId)])},201);
  assert.equal(order.status,'RECEIVED');
  const kitchen=await ok('/api/cafe/admin/orders',{cookie:ownerCookie});
  const found=kitchen.orders.find(o=>o.id===order.id);
  assert.deepEqual(found.items.map(i=>i.item_id),[retailId]);
});

await check('Unpriced retail item cannot be ordered',async()=>{
  const unpriced=`qa-unpriced-${suffix}`;
  await ok('/api/cafe/admin/products',{method:'POST',cookie:ownerCookie,
    body:{id:unpriced,name:`QA Unpriced ${suffix}`,category_id:'retail-cups',type:'RETAIL',price_paise:0,available:true}},201);
  const menu=await ok('/api/cafe/menu');
  assert.equal(menu.categories.find(c=>c.id==='retail-cups').items.find(p=>p.id===unpriced).available,false);
  const order=await api('/api/cafe/orders',{method:'POST',body:qrOrder([line(unpriced)])});
  assert.equal(order.response.status,409);
});

await check('Mixed retail and prepared order sends only food to kitchen',async()=>{
  const order=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line(retailId),line('classic-veg-burger')])},201);
  const kitchen=await ok('/api/cafe/admin/orders',{cookie:ownerCookie});
  const found=kitchen.orders.find(o=>o.id===order.id);
  assert.deepEqual(found.items.map(i=>i.item_id),['classic-veg-burger']);
});

await check('Free fries applies only above ₹250 eligible ice cream',async()=>{
  const eligible=await ok('/api/cafe/orders',{method:'POST',body:qrOrder([line('hot-chocolate-fudge'),line('brownie-fudge')])},201);
  const tracked=await ok(`/api/cafe/orders/${eligible.tracking_token}`);
  const free=tracked.items.find(i=>i.item_id==='salted-fries');
  assert.ok(free?.is_complimentary);
  assert.equal(free.total_paise,0);
  assert.equal(eligible.total_paise,31800);
  const mixed=await ok('/api/cafe/orders',{method:'POST',body:qrOrder([line('hot-chocolate-fudge'),line('classic-veg-burger',2)])},201);
  assert.ok(!(await ok(`/api/cafe/orders/${mixed.tracking_token}`)).items.some(i=>i.is_complimentary));
  await ok('/api/cafe/admin/products',{method:'POST',cookie:ownerCookie,
    body:{id:exactId,name:`QA Exact Sundae ${suffix}`,category_id:'signature-sundaes',type:'PREPARED',price_paise:25000}},201);
  const exact=await ok('/api/cafe/orders',{method:'POST',body:qrOrder([line(exactId)])},201);
  assert.ok(!(await ok(`/api/cafe/orders/${exact.tracking_token}`)).items.some(i=>i.is_complimentary));
});

await check('Concurrent order numbers and idempotent retry',async()=>{
  const [a,b]=await Promise.all([1,2].map(()=>ok('/api/cafe/orders',{method:'POST',
    body:qrOrder([line('classic-cold-coffee')])},201)));
  assert.notEqual(a.order_number,b.order_number);
  const body=qrOrder([line('classic-cold-coffee')]);
  const first=await ok('/api/cafe/orders',{method:'POST',body},201);
  const second=await ok('/api/cafe/orders',{method:'POST',body},200);
  assert.equal(first.id,second.id);
  assert.equal(first.order_number,second.order_number);
});

await check('Cashier cannot edit product prices',async()=>{
  const name=`cashier_${suffix}`;
  await ok('/api/cafe/admin/staff',{method:'POST',cookie:ownerCookie,
    body:{username:name,password:`LocalTest_${suffix}_long`,role:'CASHIER'}},201);
  const login=await api('/api/cafe/staff/login',{method:'POST',body:{username:name,password:`LocalTest_${suffix}_long`}});
  assert.equal(login.response.status,200);
  cashierCookie=login.response.headers.get('set-cookie')?.split(';')[0]||'';
  const denied=await api(`/api/cafe/admin/products/${newId}`,{method:'PATCH',cookie:cashierCookie,
    body:{price_paise:1}});
  assert.equal(denied.response.status,403);
});

await check('Payments, receipt, refund, and retail return',async()=>{
  const order=await ok('/api/cafe/pos/orders',{method:'POST',cookie:ownerCookie,
    body:posOrder([line(retailId)])},201);
  const first=await ok(`/api/cafe/pos/orders/${order.id}/payments`,{method:'POST',cookie:ownerCookie,
    body:{method:'UPI',amount_paise:5000,reference:'QA-UPI'}},201);
  assert.equal(first.payment_status,'PARTIAL');
  const second=await ok(`/api/cafe/pos/orders/${order.id}/payments`,{method:'POST',cookie:ownerCookie,
    body:{method:'CASH',amount_paise:10000}},201);
  assert.equal(second.payment_status,'PAID');
  const receipt=await api(`/api/cafe/pos/orders/${order.id}/receipt?width=80`,{cookie:ownerCookie});
  assert.equal(receipt.response.status,200);
  assert.match(receipt.data,/QA Cup/);
  assert.match(receipt.data,/PAID/);
  await ok(`/api/cafe/pos/orders/${order.id}/returns`,{method:'POST',cookie:ownerCookie,
    body:{reason:'Local QA return',items:[{line_no:1,quantity:1}]}},201);
  const refund=await ok(`/api/cafe/admin/payments/${first.payment.id}/refunds`,{method:'POST',cookie:ownerCookie,
    body:{amount_paise:5000,reason:'Local QA return'}},201);
  assert.equal(refund.payment_status,'PARTIAL');
});

await check('Orders persist across fresh reads and reports load',async()=>{
  const tracked=await ok(`/api/cafe/orders/${globalThis.tableOrder.tracking_token}`);
  assert.equal(tracked.order.order_number,globalThis.tableOrder.order_number);
  const report=await ok('/api/cafe/admin/reports?range=today',{cookie:ownerCookie});
  assert.ok(report);
});

console.log(`\n${results.length} local integration checks passed`);
