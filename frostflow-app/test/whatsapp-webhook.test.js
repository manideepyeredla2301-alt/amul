const test=require('node:test'),assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {openDatabase}=require('../src/db');
const {createWebhook}=require('../src/whatsapp-webhook');
test('webhook verifies signatures, retains external test errors, and prevents delivery regression',async()=>{
  const db=openDatabase(':memory:');
  db.exec("CREATE TABLE whatsapp_outbox(message_id TEXT,status TEXT,error TEXT); INSERT INTO whatsapp_outbox VALUES('m1','ACCEPTED',NULL)");
  const server=createWebhook({db,appSecret:'secret',verifyToken:'verify',phoneId:'123'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/webhooks/whatsapp`;
  try{
    assert.equal(await (await fetch(url.replace('/webhooks/whatsapp','/healthz'))).text(),'OK');
    assert.equal(await (await fetch(url+'?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=hello')).text(),'hello');
    assert.equal((await fetch(url+'?hub.mode=subscribe&hub.verify_token=bad')).status,403);
    const post=async(status,id='m1',valid=true)=>{
      const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'123'},statuses:[{id,status,timestamp:'100',errors:status==='failed'?[{code:131026,title:'Undeliverable'}]:undefined}]}}]}]});
      return fetch(url,{method:'POST',headers:{'x-hub-signature-256':valid?'sha256='+createHmac('sha256','secret').update(body).digest('hex'):'invalid'},body});
    };
    assert.equal((await post('read','m1',false)).status,403);
    assert.equal(db.prepare('SELECT status FROM whatsapp_outbox').get().status,'ACCEPTED');
    await post('read');await post('sent');
    assert.equal(db.prepare('SELECT status FROM whatsapp_outbox').get().status,'READ');
    await post('failed','external-test');await post('failed','external-test');
    const rows=db.prepare("SELECT * FROM whatsapp_delivery_events WHERE message_id='external-test'").all();
    assert.equal(rows.length,1);assert.match(rows[0].error,/131026/);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
