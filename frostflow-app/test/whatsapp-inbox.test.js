const test=require('node:test'),assert=require('node:assert/strict');
const {openDatabase}=require('../src/db');
const {ERPService}=require('../src/services/erp-service');
const {AmulSync}=require('../src/services/amul-sync');
const {WhatsAppService}=require('../src/services/whatsapp');
const {WhatsAppInbox,category}=require('../src/services/whatsapp-inbox');
test('category matching handles the requested Amul groups',()=>{
 for(const [name,expected] of [['Tricone Vanilla','Tricones'],['Amul IC STK Kulfi','Sticks & Kulfi'],['Amul IC Cup Coffee 125ml','Cups 125 ml'],['Amul IC Catering 4 L','Bulk Packs'],['Amul Combo Vanilla','Combos']])assert.equal(category(name),expected);
});
test('reminders appear in conversations and interrupted chats are not silently retried',()=>{
 const db=openDatabase(':memory:'),erp=new ERPService(db),wa=new WhatsAppService(db,erp);
 const inbox=new WhatsAppInbox(db,wa);
 db.prepare("INSERT INTO whatsapp_outbox(source,invoice_id,day,recipient,status) VALUES('LOCAL','1','2026-09-22','919876543210','ACCEPTED')").run();
 assert.equal(inbox.list()[0].phone,'919876543210');
 assert.match(inbox.thread('9876543210').messages[0].body,/Payment reminder/);
 db.prepare("INSERT INTO whatsapp_chat_outbox(request_id,recipient,body,status) VALUES('interrupted','919876543210','hello','SENDING')").run();
 new WhatsAppInbox(db,wa);
 assert.equal(db.prepare("SELECT status FROM whatsapp_chat_outbox").get().status,'UNKNOWN');db.close();
});
test('inbox enforces reply window, idempotency and sends price-free grouped products',async()=>{
 const db=openDatabase(':memory:'),erp=new ERPService(db);new AmulSync(db,{enabled:false});let calls=0,sent;
 const wa=new WhatsAppService(db,erp,{fetchImpl:async(u,o)=>{calls++;sent=JSON.parse(o.body);return {ok:true,json:async()=>({messages:[{id:'wamid.reply'}]})};}});
 wa.save({phoneId:'123',version:'v23.0',template:'test',language:'en',token:'secret'});const inbox=new WhatsAppInbox(db,wa);
 await assert.rejects(inbox.send({phone:'9876543210',text:'hello',requestId:'request-1'}),/window/);
 db.prepare('INSERT INTO whatsapp_incoming_messages VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)').run('in-1','919876543210','text','Hi',String(Math.floor(Date.now()/1000)),'{}');
 inbox.catalog=()=>({items:[{product_id:'1',sku:'TR1',product_name:'Tricone Vanilla',mrp_paise:9999}]});
 const request={phone:'9876543210',productIds:['1'],requestId:'request-2'};
 assert.equal((await inbox.send(request)).status,'ACCEPTED');await inbox.send(request);assert.equal(calls,1);assert.match(sent.text.body,/Tricones/);assert.doesNotMatch(sent.text.body,/9999|99\.99|₹/);assert.equal(inbox.thread('9876543210').messages.length,2);db.close();
});
