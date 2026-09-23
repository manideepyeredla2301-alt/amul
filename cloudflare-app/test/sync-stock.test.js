import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
test('upstream stock observation preserves cloud stock, price, activity and ownership',()=>{
 const code=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8');
 const sql=code.match(/return env\.DB\.prepare\(`(INSERT INTO inventory\(product_id,sku,product_name,category,unit,stock_qty,[\s\S]*?)`\)/)[1];
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0009_source_stock.sql',import.meta.url),'utf8'));
 const statement=db.prepare(sql.replace(/\?(\d+)/g,':p$1'));
 const params={p1:'AMUL:1',p2:'A',p3:'Ice cream',p4:'Ice cream',p5:'PC',p6:100,p7:2000,p8:1500,p9:1,p10:'amul-pc',p11:'one',p12:'2026-09-23'};
 statement.run(params);db.exec("UPDATE inventory SET stock_qty=7,reserved_qty=2,selling_price_paise=1800,active=0");
 statement.run({...params,p6:999,p11:'two'});
 const r=db.prepare('SELECT * FROM inventory').get();
 assert.equal(r.stock_qty,7);assert.equal(r.reserved_qty,2);assert.equal(r.selling_price_paise,1800);assert.equal(r.active,0);assert.equal(r.source_stock_qty,999);
 db.exec("UPDATE inventory SET source_device='cloudflare-admin'");statement.run({...params,p6:888});
 assert.equal(db.prepare('SELECT source_stock_qty FROM inventory').get().source_stock_qty,999);db.close();
});
