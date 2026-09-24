import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {acceptBusinessSnapshot} from '../src/worker.js';

// Minimal D1 facade over node:sqlite with every migration applied.
function d1(){
 const db=new DatabaseSync(':memory:');
 const dir=new URL('../migrations/',import.meta.url);
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
 const wrap=(sql,args=[])=>({bind:(...a)=>wrap(sql,a),first:async()=>db.prepare(sql).get(...args)??null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>{const r=db.prepare(sql).run(...args);return{meta:{changes:r.changes}};},exec:()=>db.prepare(sql).run(...args)});
 return{db,DB:{prepare:sql=>wrap(sql),batch:async list=>{db.exec('BEGIN');try{for(const s of list)s.exec();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}};
}
const post=(env,body)=>acceptBusinessSnapshot(new Request('http://x/api/sync/business',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device_id:'amul-pc',captured_at:'2026-09-24T00:00:00Z',...body})}),env);

test('routes: new routes are complete; existing routes keep cloud edits but refresh Amul-only details',async()=>{
 const env=d1();
 const route={id:'AMUL:7',source:'AMUL',source_id:'7',code:'SR01',name:'Badangpet',active:true,visit_days:'Mon',customer_count:3,details:{RMId:7,RMMon:true}};
 await post(env,{snapshot_id:'s1',dataset:'routes',items:[route]});
 let r=env.db.prepare('SELECT * FROM routes').get();
 assert.equal(r.visit_days,'Mon');assert.equal(r.customer_count,3);assert.equal(JSON.parse(r.details_json).RMId,7);
 env.db.exec("UPDATE routes SET name='Badangpet (edited)'");
 await post(env,{snapshot_id:'s2',dataset:'routes',items:[{...route,name:'Overwrite attempt',visit_days:'Mon,Fri',customer_count:43}]});
 r=env.db.prepare('SELECT * FROM routes').get();
 assert.equal(r.name,'Badangpet (edited)');assert.equal(r.visit_days,'Mon,Fri');assert.equal(r.customer_count,43);
});

test('customer_routes is an upserted Amul mapping',async()=>{
 const env=d1();
 const link={id:'AMUL:50:7',source:'AMUL',source_id:'50:7',customer_id:'AMUL:50',route_id:'AMUL:7',active:true};
 await post(env,{snapshot_id:'s1',dataset:'customer_routes',items:[link]});
 await post(env,{snapshot_id:'s2',dataset:'customer_routes',items:[{...link,route_id:'AMUL:8'}]});
 const rows=env.db.prepare('SELECT * FROM customer_routes').all();
 assert.equal(rows.length,1);assert.equal(rows[0].route_id,'AMUL:8');
});

test('invoice window hides Amul invoices before min_date, never deletes, and never touches edits or local invoices',async()=>{
 const env=d1();
 const inv=(id,date)=>({id:'AMUL:'+id,source:'AMUL',source_id:String(id),invoice_number:'INV'+id,invoice_date:date,customer_name:'Shop',total_paise:1000,paid_paise:0,outstanding_paise:1000,payment_status:'UNPAID'});
 await post(env,{snapshot_id:'s1',dataset:'invoices',items:[inv(1,'2026-09-08'),inv(2,'2026-09-09')]});
 env.db.exec("UPDATE invoices SET paid_paise=1000,payment_status='PAID' WHERE id='AMUL:2'");
 env.db.exec("INSERT INTO invoices(id,source,source_id,invoice_number,invoice_date,customer_name,payment_status,source_device,snapshot_id) VALUES('LOCAL:1','LOCAL','1','L1','2026-09-01','Walk-in','PAID','cloudflare-admin','x')");
 await post(env,{snapshot_id:'s2',dataset:'invoices',items:[inv(2,'2026-09-09')]});
 await post(env,{snapshot_id:'s2',dataset:'invoices',complete:true,items:[],prune:true,min_date:'2026-09-09'});
 const rows=Object.fromEntries(env.db.prepare('SELECT id,deleted_at,payment_status FROM invoices').all().map(r=>[r.id,r]));
 assert.equal(Object.keys(rows).length,3);
 assert.ok(rows['AMUL:1'].deleted_at);
 assert.equal(rows['AMUL:2'].deleted_at,null);assert.equal(rows['AMUL:2'].payment_status,'PAID');
 assert.equal(rows['LOCAL:1'].deleted_at,null);
});

test('non-Amul records are still rejected',async()=>{
 const env=d1();
 await assert.rejects(post(env,{snapshot_id:'s1',dataset:'customer_routes',items:[{id:'LOCAL:1',source:'LOCAL',source_id:'1',customer_id:'LOCAL:1',route_id:'LOCAL:1'}]}));
});
