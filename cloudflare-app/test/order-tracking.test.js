import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';

function d1({triggers=false}={}){
  const db=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
  if(triggers)db.exec(readFileSync(new URL('../schema/triggers.sql',import.meta.url),'utf8'));
  const wrap=(sql,args=[])=>({bind:(...values)=>wrap(sql,values),first:async()=>db.prepare(sql).get(...args)??null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>{const result=db.prepare(sql).run(...args);return{meta:{changes:result.changes}}}});
  return{db,env:{DB:{prepare:sql=>wrap(sql),batch:async statements=>{for(const statement of statements)await statement.run()}}}};
}

test('private tracking link exposes order and invoice-safe fields without customer contact data',async()=>{
  const {db,env}=d1(),token='a'.repeat(48);
  db.exec("INSERT INTO inventory(product_id,product_name,source_device,snapshot_id) VALUES('P1','Vanilla Cups','test','s1')");
  db.prepare(`INSERT INTO orders(id,request_id,source,customer_name,phone,address,status,order_number,delivery_date,total_paise,workflow_status,subtotal_paise,tax_paise,gst_bps,public_token)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('O1','request-123','ONLINE','Anil Stores','919999999999','Private address','NEW','WEB-42','2026-09-30',25000,'RECEIVED',25000,0,500,token);
  db.prepare(`INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise,subtotal_paise,tax_paise,total_paise)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('O1',1,'P1','Vanilla Cups',10,'PC',1,'BOX',10,2500,25000,0,25000);
  const response=await worker.fetch(new Request(`https://orders.example/api/catalog/orders/${token}`),env),body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.order.order_number,'WEB-42');
  assert.equal(body.lines[0].requested_unit,'BOX');
  assert.equal(body.order.phone,undefined);
  assert.equal(body.order.address,undefined);
});

test('partial fulfilment invoices only picked stock and keeps the original order quantity',async()=>{
  const {db,env}=d1({triggers:true});
  env.APP_USER='admin';env.APP_PASSWORD='test-password';
  const headers={authorization:`Basic ${btoa('admin:test-password')}`,'content-type':'application/json'};
  db.prepare(`INSERT INTO inventory(product_id,sku,product_name,unit,stock_qty,selling_price_paise,active,source_device,snapshot_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('P1','P1','Vanilla Cups','PC',5,1000,1,'test','s1');
  db.prepare(`INSERT INTO customers(id,source,source_id,name,mobile,source_device,snapshot_id)
    VALUES(?,?,?,?,?,?,?)`).run('C1','LOCAL','C1','Anil Stores','919999999999','test','s1');
  db.prepare(`INSERT INTO orders(id,request_id,source,customer_id,customer_name,status,order_number,delivery_date,total_paise,workflow_status)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('O1','request-partial','ONLINE','C1','Anil Stores','NEW','WEB-1','2026-09-30',5000,'CONFIRMED');
  db.prepare(`INSERT INTO order_lines(order_id,line_no,product_id,product_name,quantity,unit,requested_quantity,requested_unit,units_per_box,price_paise,subtotal_paise,total_paise)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('O1',1,'P1','Vanilla Cups',5,'PC',5,'PC',1,1000,5000,5000);
  db.exec("UPDATE inventory SET stock_qty=3,manual_out_of_stock=1,active=0 WHERE product_id='P1'");

  const rejected=await worker.fetch(new Request('https://orders.example/api/orders/O1/pick',{method:'PATCH',headers,body:JSON.stringify({line_no:1,picked_qty:5})}),env);
  assert.equal(rejected.status,409);
  const picked=await worker.fetch(new Request('https://orders.example/api/orders/O1/pick',{method:'PATCH',headers,body:JSON.stringify({line_no:1,picked_qty:3})}),env);
  assert.equal(picked.status,200);
  const listed=await worker.fetch(new Request('https://orders.example/api/orders',{headers:{authorization:headers.authorization}}),env),orders=await listed.json();
  assert.equal(orders.orders[0].lines[0].fulfillable_qty,3);
  assert.equal(orders.orders[0].lines[0].picked_qty,3);

  const invoice=await worker.fetch(new Request('https://orders.example/api/invoices',{method:'POST',headers,body:JSON.stringify({
    request_id:'invoice-partial-1',order_id:'O1',customer_id:'C1',invoice_date:'2026-09-29',due_date:'2026-09-29',
    lines:[{product_id:'P1',quantity:3,unit_price_paise:1000,gst_bps:0}],
  })}),env),invoiceBody=await invoice.json();
  assert.equal(invoice.status,201,JSON.stringify(invoiceBody));
  assert.equal(db.prepare('SELECT quantity FROM invoice_lines WHERE invoice_id=?').get(invoiceBody.id).quantity,3);
  const orderLine=db.prepare("SELECT quantity,picked_qty FROM order_lines WHERE order_id='O1'").get();
  assert.equal(orderLine.quantity,5);assert.equal(orderLine.picked_qty,3);
  const inventory=db.prepare("SELECT stock_qty,reserved_qty FROM inventory WHERE product_id='P1'").get();
  assert.equal(inventory.stock_qty,0);assert.equal(inventory.reserved_qty,0);
  assert.equal(db.prepare("SELECT workflow_status FROM orders WHERE id='O1'").get().workflow_status,'INVOICED');
});
