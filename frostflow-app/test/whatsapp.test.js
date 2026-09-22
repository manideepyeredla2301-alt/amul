const test=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase}=require('../src/db');
const {ERPService}=require('../src/services/erp-service');
const {AmulSync}=require('../src/services/amul-sync');
const {WhatsAppService}=require('../src/services/whatsapp');
function fixture(fetchImpl) {
 const db=openDatabase(':memory:'),erp=new ERPService(db);new AmulSync(db,{enabled:false});
 const wa=new WhatsAppService(db,erp,{fetchImpl});
 wa.save({phoneId:'123',version:'v23.0',template:'payment_due',language:'en',token:'test-token',enabled:true,recipients:'legacy value'});
 const put=(id,total=10000,paid=0,mobile='9876543210')=>db.prepare("INSERT INTO amul_sales_invoices(sal_id,invoice_number,customer_name,mobile,total_paise,paid_paise,due_date,payment_status) VALUES(?,?,'Retailer',?,?,?,'2099-01-01',?)").run(String(id),'INV'+id,mobile,total,paid,paid>=total?'PAID':paid>0?'PARTIAL':'PENDING');
 return {db,erp,wa,put};
}
const accepted=()=>({ok:true,json:async()=>({messages:[{id:'wamid.test'}]})});
test('explicit rejected retry preserves history and cannot retry an accepted message',async()=>{
 let reject=true,calls=0;const {db,wa,put}=fixture(async()=>{calls++;return reject?{ok:false,json:async()=>({error:{code:190}})}:accepted();});put(1);
 wa.start({source:'AMUL',invoiceId:'1'});await wa.running;
 wa.start({source:'AMUL',invoiceId:'1'});await wa.running;assert.equal(calls,1);assert.equal(wa.status().skippedHeld,1);
 reject=false;const request={source:'AMUL',invoiceId:'1',expectedRecipient:'919876543210',retryFailed:true};
 wa.start(request);await wa.running;assert.equal(calls,2);assert.equal(wa.history().length,2);assert.equal(wa.history().filter(r=>r.archived&&r.status==='FAILED').length,1);
 assert.throws(()=>wa.start(request),/Only confirmed/);assert.equal(calls,2);await wa.stop();db.close();
});
test('reminder preview rejects a changed customer recipient before sending',async()=>{
 const {db,wa,put}=fixture(accepted);put(1);
 const preview=wa.preview({source:'AMUL',invoiceId:'1'});
 assert.equal(preview.recipient,'919876543210');assert.equal(preview.outstandingPaise,10000);
 assert.throws(()=>wa.start({source:'AMUL',invoiceId:'1',expectedRecipient:'919123456789'}),/phone changed/);
 assert.equal(wa.history().length,0);await wa.stop();db.close();
});
test('single invoice reminder only contacts that customer and rejects mixed bulk scope',async()=>{
 const sent=[];const {db,wa,put}=fixture(async(url,options)=>{sent.push(JSON.parse(options.body));return accepted();});
 put(1,10000,0,'9876543210');put(2,20000,0,'9123456789');
 assert.throws(()=>wa.start({all:true,source:'AMUL',invoiceId:'1'}),/never both/);
 wa.start({source:'AMUL',invoiceId:'2'});await wa.running;
 assert.equal(sent.length,1);assert.equal(sent[0].to,'919123456789');
 assert.equal(sent[0].template.components[0].parameters[1].text,'INV2');
 assert.equal(wa.status().total,1);await wa.stop();db.close();
});
test('settings never send automatically; single paid invoice is skipped',async()=>{
 let calls=0;const {db,wa,put}=fixture(async()=>{calls++;return accepted();});
 put(1,10000,10000);
 assert.equal(wa.timer,undefined);assert.equal(wa.config().enabled,undefined);assert.equal(wa.config().recipients,undefined);
 assert.equal(wa.config().token,undefined);assert.equal(calls,0);
 wa.start({source:'AMUL',invoiceId:'1'});await wa.running;
 assert.equal(calls,0);assert.equal(wa.status().skippedPaid,1);
 await wa.stop();db.close();
});
test('all includes partial and not-yet-due invoices; paid and missing numbers are skipped',async()=>{
 const bodies=[];const {db,wa,put}=fixture(async(url,options)=>{bodies.push(JSON.parse(options.body));return accepted();});
 put(1);put(2,10000,4000);put(3,10000,10000);put(4,10000,0,'');
 wa.start({all:true});await wa.running;
 assert.equal(bodies.length,2);
 assert.equal(bodies[1].template.components[0].parameters[2].text,'60.00');
 assert.equal(wa.status().skippedPaid,1);assert.equal(wa.status().skippedMissing,1);
 wa.start({all:true});await wa.running;
 assert.equal(bodies.length,2);assert.equal(wa.status().skippedDuplicate,2);
 assert.equal(wa.history()[0].status,'ACCEPTED');
 await wa.stop();db.close();
});
test('payment during sending is rechecked and concurrent batches are rejected',async()=>{
 let release,calls=0;
 const {db,wa,put}=fixture(async()=>{calls++;await new Promise(r=>release=r);return accepted();});
 put(1);put(2);
 wa.start({all:true});
 assert.throws(()=>wa.start({all:true}),/already running/);
 db.prepare("UPDATE amul_sales_invoices SET paid_paise=total_paise,payment_status='PAID' WHERE sal_id='2'").run();
 release();await wa.running;
 assert.equal(calls,1);assert.equal(wa.status().skippedPaid,1);
 await wa.stop();db.close();
});
test('bulk send includes records beyond page and old 500 row limits',async()=>{
 let calls=0;const {db,wa,put}=fixture(async()=>{calls++;return accepted();});
 for(let i=1;i<=505;i++)put(i);
 wa.start({all:true});await wa.running;
 assert.equal(calls,505);assert.equal(wa.status().processed,505);
 await wa.stop();db.close();
});
test('uncertain results are held and batch stops without duplicating sends',async()=>{
 let calls=0;const {db,wa,put}=fixture(async()=>{calls++;throw Error('timeout');});
 put(1);put(2);
 wa.start({all:true});await wa.running;
 assert.equal(calls,1);assert.equal(wa.status().unknown,1);assert.equal(wa.status().processed,1);
 wa.start({source:'AMUL',invoiceId:'1'});await wa.running;
 assert.equal(calls,1);assert.equal(wa.status().skippedHeld,1);
 await wa.stop();db.close();
});
test('local customer invoice reminders use the remaining balance',async()=>{
 const bodies=[];const {db,erp,wa}=fixture(async(url,o)=>{bodies.push(JSON.parse(o.body));return accepted();});
 const p=erp.createProduct({sku:'P',name:'Cup',wholesalePrice:10,gstBps:0});
 const s=erp.createParty({partyType:'SUPPLIER',name:'Supplier'});
 const c=erp.createParty({name:'Customer',whatsappNumber:'919876543210'});
 erp.receivePurchase({supplierId:s.id,items:[{productId:p.id,quantity:10,unitCost:5,batchNumber:'B'}]});
 const sale=erp.createInvoice({channel:'DISTRIBUTION',customerId:c.id,items:[{productId:p.id,quantity:2}],payments:[{method:'CASH',amount:5}]});
 wa.start({source:'LOCAL',invoiceId:String(sale.id)});await wa.running;
 assert.equal(bodies[0].template.components[0].parameters[2].text,'15.00');
 assert.equal(wa.history()[0].invoice_number,sale.invoiceNumber);
 await wa.stop();db.close();
});
