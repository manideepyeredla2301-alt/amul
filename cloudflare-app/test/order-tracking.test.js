import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';

function d1(){
  const db=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
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
