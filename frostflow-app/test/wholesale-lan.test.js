'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase}=require('../src/db');
const {saveUser}=require('../src/wholesale-lan-auth');
const {createWholesaleLanServer}=require('../src/wholesale-lan-server');

test('LAN API requires login and CSRF, then makes a draft only from checked items',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'frostflow-wholesale-lan-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const dbPath=path.join(dir,'frostflow.sqlite'),authFile=path.join(dir,'auth.json');
  const seed=openDatabase(dbPath);
  seed.prepare("INSERT INTO products(id,sku,name,wholesale_price_paise,gst_bps) VALUES(1,'IC1','Vanilla Ice Cream',10000,500)").run();
  seed.prepare("INSERT INTO parties(id,party_type,code,name) VALUES(1,'CUSTOMER','C1','Corner Shop')").run();
  seed.close();
  saveUser(authFile,{username:'rachana',password:'test-password-123',role:'OWNER'});
  saveUser(authFile,{username:'picker',password:'staff-password-123',role:'STAFF'});
  const app=createWholesaleLanServer({dbPath,authFile,host:'127.0.0.1'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=(route,{method='GET',data,csrf='',cookie='',origin=base}={})=>fetch(base+route,{
    method,headers:{...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),origin},
    ...(data?{body:JSON.stringify(data)}:{}),
  });
  assert.equal((await call('/api/orders')).status,401);
  assert.equal((await call('/api/login',{method:'POST',data:{username:'rachana',password:'wrong'}})).status,401);
  const login=await call('/api/login',{method:'POST',data:{username:'rachana',password:'test-password-123'}});
  assert.equal(login.status,200);
  const owner=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal(owner.role,'OWNER');
  const categories=await (await call('/api/categories',{cookie})).json();
  const iceCream=categories.find(category=>category.name==='Ice Cream');
  assert.ok(iceCream);
  const tiles=await (await call(`/api/catalog?category=${encodeURIComponent(iceCream.id)}`,{cookie})).json();
  assert.equal(tiles[0].name,'Vanilla Ice Cream');
  assert.equal((await call('/api/orders',{method:'POST',cookie,data:{}})).status,403);
  assert.equal((await call('/api/orders',{cookie,origin:'http://evil.example'})).status,403);
  const created=await call('/api/orders',{method:'POST',cookie,csrf:owner.csrf,
    data:{customerKey:'LOCAL:1',items:[{productKey:'LOCAL:1',quantity:3}]}});
  assert.equal(created.status,201,await created.clone().text());
  const order=await created.json();
  assert.equal(order.lines[0].pickedQuantity,null);
  const picked=await call(`/api/orders/${order.id}/lines/${order.lines[0].id}`,{method:'PATCH',cookie,csrf:owner.csrf,
    data:{pickedQuantity:2,shortageReason:'Only two in freezer'}});
  assert.equal(picked.status,200,await picked.clone().text());
  const ready=await call(`/api/orders/${order.id}/status`,{method:'PATCH',cookie,csrf:owner.csrf,data:{status:'READY'}});
  assert.equal(ready.status,200,await ready.clone().text());
  const draftResponse=await call(`/api/orders/${order.id}/draft`,{method:'POST',cookie,csrf:owner.csrf,data:{}});
  assert.equal(draftResponse.status,201,await draftResponse.clone().text());
  const draft=await draftResponse.json();
  assert.equal(draft.lines.length,1);
  assert.equal(draft.lines[0].quantity,2);
  assert.match(draft.notice,/NOT POSTED/);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM invoices').get().n,0);
  const staffLogin=await call('/api/login',{method:'POST',data:{username:'picker',password:'staff-password-123'}});
  const staff=await staffLogin.json(),staffCookie=staffLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(`/api/drafts/${draft.id}`,{cookie:staffCookie})).status,403);
  assert.equal((await call(`/api/orders/${order.id}/draft`,{method:'POST',cookie:staffCookie,csrf:staff.csrf,data:{}})).status,403);
});
