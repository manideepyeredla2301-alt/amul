const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApplication } = require('../server');

async function running(t) {
  const app = createApplication({ dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body, key, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}), ...extra }, body: JSON.stringify(body) });
  return { ...app, base, post };
}

test('local app serves dashboard, guards cross-site writes and prevents directory traversal', async t => {
  const { base, post } = await running(t);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.ok, true); assert.equal(health.version, '0.2.0');
  assert.match(await (await fetch(base + '/')).text(), /FrostFlow ERP/);
  assert.equal((await fetch(base + '/..%2Fserver.js')).status, 403);
  assert.equal((await post('/api/products', {sku:'CROSS',name:'Cross'}, null, {Origin:'https://example.com'})).status,403);
  assert.deepEqual(await (await fetch(base + '/api/products')).json(), []);
});

test('online origin requires authentication and still rejects cross-site requests',async t=>{
  const app=createApplication({
    dbPath:':memory:',
    publicOrigin:'https://erp.example.com',
    onlineUser:'owner',
    onlinePassword:'a-secure-password-123',
  });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=headers=>new Promise((resolve,reject)=>{const target=new URL(base+'/api/health');const call=http.request({hostname:target.hostname,port:target.port,path:target.pathname,headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));});call.on('error',reject);call.end();});
  const publicHeaders={Host:'erp.example.com'};
  assert.equal((await request(publicHeaders)).status,401);
  const authorization='Basic '+Buffer.from('owner:a-secure-password-123').toString('base64');
  const accepted=await request({...publicHeaders,authorization,origin:'https://erp.example.com'});
  assert.equal(accepted.status,200);
  assert.equal(JSON.parse(accepted.body).ok,true);
  assert.equal((await request({...publicHeaders,authorization,origin:'https://evil.example'})).status,403);
});

test('invoice packing endpoint is available in the current service',async t=>{
 const {base,erp}=await running(t);
 const p=erp.createProduct({sku:'PACK-API',name:'Packing test',unit:'PCS'});
 const response=await fetch(base+'/api/product-units/LOCAL/'+p.id);
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),[{code:'BASE',label:'PCS',factor:1}]);
});

test('retrying the same write key returns the original result and changed data is rejected', async t => {
  const { post, erp } = await running(t);
  const body = {sku:'ICE',name:'Ice bar',purchasePrice:'10.10',retailPrice:20,wholesalePrice:15};
  const a = await post('/api/products',body,'test-request-12345');
  assert.equal(a.status,201); const first = await a.json();
  const b = await post('/api/products',body,'test-request-12345');
  assert.deepEqual(await b.json(),first);assert.equal(erp.listProducts().length,1);
  const bad = await post('/api/products',{...body,name:'Different'},'test-request-12345');
  assert.equal(bad.status,409);
});

test('live event stream announces committed changes and exposes new current values', async t => {
  const {base,post} = await running(t);
  const controller = new AbortController();
  const response = await fetch(base+'/api/events',{signal:controller.signal});
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(),/event: ready/);
  await post('/api/products',{sku:'LIVE',name:'Live product',retailPrice:45});
  const event = Buffer.from((await reader.read()).value).toString();
  assert.match(event,/event: change/); assert.match(event,/revision/);
  controller.abort(); await reader.cancel().catch(()=>{});
  const bootstrap = await (await fetch(base+'/api/bootstrap')).json();
  assert.equal(bootstrap.products[0].retail_price_paise,4500);
});

test('HTTP Excel templates and exports are actual XLSX files', async t => {
  const {base}=await running(t);
  const {readWorkbook}=require('../src/excel-codec');
  for(const route of ['/api/excel/templates/products.xlsx','/api/excel/templates/stock.xlsx','/api/excel/export/all.xlsx']) {
    const response=await fetch(base+route); assert.equal(response.status,200,await response.clone().text());
    assert.match(response.headers.get('content-type'),/spreadsheetml/);
    const bytes=Buffer.from(await response.arrayBuffer()); assert.equal(bytes.subarray(0,2).toString(),'PK');
    const sheets=await readWorkbook(bytes,'export.xlsx'); assert.ok(sheets.length>0);
  }
});
