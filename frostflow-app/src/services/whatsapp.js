const {businessToday,AppError}=require('../domain');
class WhatsAppService {
 constructor(db,erp,{fetchImpl=fetch}={}) {
  this.db=db;this.erp=erp;this.fetch=fetchImpl;this.token=process.env.FROSTFLOW_WHATSAPP_TOKEN || '';
  db.exec("CREATE TABLE IF NOT EXISTS whatsapp_config(id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS whatsapp_outbox(id INTEGER PRIMARY KEY, source TEXT NOT NULL, invoice_id TEXT NOT NULL, day TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(source,invoice_id,day));");
  db.prepare("UPDATE whatsapp_outbox SET status='UNKNOWN',error='App restarted during sending; check Meta before retrying.' WHERE status='SENDING'").run();
  this.job=null;
  db.exec('CREATE TABLE IF NOT EXISTS whatsapp_retry_history(id INTEGER PRIMARY KEY, original_id INTEGER NOT NULL, payload TEXT NOT NULL, archived_at TEXT DEFAULT CURRENT_TIMESTAMP)');
 }
 phone(value) {let p=String(value || '').replace(/\D/g,'');if(p.length===10)p='91'+p;return /^[1-9]\d{10,14}$/.test(p)?p:'';}
 config() {
  const c=JSON.parse(this.db.prepare('SELECT payload FROM whatsapp_config WHERE id=1').get()?.payload || '{}');
  return {phoneId:c.phoneId || '',version:c.version || '',template:c.template || '',language:c.language || 'en',tokenConfigured:!!this.token};
 }
 save(input) {
  const c={phoneId:String(input.phoneId || '').trim(),version:String(input.version || '').trim(),template:String(input.template || '').trim(),language:String(input.language || 'en').trim()};
  if(!/^\d+$/.test(c.phoneId))throw new AppError('Meta Phone Number ID must contain digits only.');
  if(!/^v\d+\.0$/.test(c.version))throw new AppError('Graph API version must look like v25.0 (not v1).');
  if(!/^[a-z0-9_]+$/.test(c.template))throw new AppError('Template name must be the exact approved Meta name, using lowercase letters, numbers and underscores only.');
  if(!/^[a-zA-Z_]+$/.test(c.language))throw new AppError('Template language must be a code such as en or en_US.');
  if(input.token)this.token=String(input.token).trim();
  this.db.prepare('INSERT INTO whatsapp_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(c));
  return this.config();
 }
 history() {
  const current=this.db.prepare("SELECT o.*,CASE WHEN o.source='AMUL' THEN a.invoice_number ELSE i.invoice_number END invoice_number FROM whatsapp_outbox o LEFT JOIN amul_sales_invoices a ON o.source='AMUL' AND a.sal_id=o.invoice_id LEFT JOIN invoices i ON o.source='LOCAL' AND i.id=o.invoice_id ORDER BY o.id DESC LIMIT 200").all();
  const archived=this.db.prepare('SELECT id,payload FROM whatsapp_retry_history ORDER BY id DESC LIMIT 200').all().map(r=>({...JSON.parse(r.payload),id:'archive-'+r.id,archived:true}));
  return [...current,...archived].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,200);
 }
 status() {return this.job || {running:false};}
 preview(input) {
  if(!['LOCAL','AMUL'].includes(input.source)||!input.invoiceId)throw new AppError('Choose an invoice.');
  const r=this.current(input.source,input.invoiceId);if(!r)throw new AppError('Invoice not found.',404);
  return {source:r.source,invoiceId:String(r.invoice_id),invoiceNumber:r.invoice_number,customer:r.customer_name,recipient:this.phone(r.phone),outstandingPaise:r.outstanding_paise,dueDate:r.due_date};
 }
 current(source,id) {
  if(source==='AMUL')return this.db.prepare("SELECT a.sal_id invoice_id,a.invoice_number,a.customer_name,COALESCE((SELECT NULLIF(TRIM(r.mobile),'') FROM amul_retailers r WHERE r.retailer_id=a.customer_id AND r.local_deleted=0),a.mobile) phone,CASE WHEN a.payment_status='PAID' THEN 0 ELSE MAX(0,a.total_paise-a.paid_paise) END outstanding_paise,a.due_date,'AMUL' source FROM amul_sales_invoices a WHERE a.sal_id=? AND a.local_deleted=0").get(String(id));
  const invoice=this.db.prepare("SELECT id,customer_id FROM invoices WHERE id=? AND status='POSTED'").get(Number(id));
  if(!invoice)return null;
  const r=this.erp.invoiceBalances(invoice.id);
  const customer=this.db.prepare("SELECT name,COALESCE(NULLIF(whatsapp_number,''),mobile) phone FROM parties WHERE id=?").get(invoice.customer_id);
  return {...r,source:'LOCAL',invoice_id:String(r.id),customer_name:customer?.name,phone:customer?.phone};
 }
 start(input={}) {
  if(input.all===true && (input.invoiceId!==undefined || input.source!==undefined))throw new AppError('Choose either one invoice or all unpaid invoices, never both.');
  if(this.running)throw new AppError('A reminder batch is already running.',409);
  const c=this.config();
  if(!this.token || !c.phoneId || !c.version || !c.template)throw new AppError('Configure WhatsApp connection and access token in Settings first.');
  if(input.all!==true && (!['LOCAL','AMUL'].includes(input.source) || !String(input.invoiceId || '').trim()))throw new AppError('Choose an invoice or Send to all unpaid.');
  if(input.expectedRecipient!==undefined && this.preview(input).recipient!==input.expectedRecipient)throw new AppError('Customer phone changed. Review the recipient again.',409);
  const targets=input.all===true?[
   ...this.db.prepare("SELECT id invoice_id,'LOCAL' source FROM invoices WHERE status='POSTED'").all(),
   ...this.db.prepare("SELECT sal_id invoice_id,'AMUL' source FROM amul_sales_invoices WHERE local_deleted=0").all()
  ]:[{source:input.source,invoice_id:String(input.invoiceId)}];
  if(input.retryFailed===true){
   if(input.all===true || !input.expectedRecipient)throw new AppError('Review one customer before retrying.');
   const rows=this.db.prepare('SELECT * FROM whatsapp_outbox WHERE source=? AND invoice_id=? ORDER BY id DESC').all(input.source,String(input.invoiceId));
   if(!rows.length || rows.some(r=>r.status!=='FAILED'||r.message_id))throw new AppError('Only confirmed rejected reminders without a message ID can be retried. Check delivery history.',409);
   this.db.exec('BEGIN IMMEDIATE');try{
    for(const r of rows){this.db.prepare('INSERT INTO whatsapp_retry_history(original_id,payload) VALUES(?,?)').run(r.id,JSON.stringify(r));this.db.prepare('DELETE FROM whatsapp_outbox WHERE id=?').run(r.id);}
    this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  this.job={running:true,total:targets.length,processed:0,accepted:0,skippedPaid:0,skippedMissing:0,skippedDuplicate:0,skippedHeld:0,failed:0,unknown:0};
  // Only invoice-screen actions start sends. No automatic sending timer.
  this.running=this.run(targets,c,this.token).catch(()=>{this.job.error='Reminder batch stopped unexpectedly. Check history before retrying.';}).finally(()=>{this.job.running=false;this.running=null;});
  return this.status();
 }
 async run(targets,c,token) {
  const job=this.job,day=businessToday();
  for(const target of targets) {
   if(this.stopping) {job.error='Sending stopped because the app is closing. Remaining invoices were not sent.';break;}
   const r=this.current(target.source,target.invoice_id);
   if(!r || r.outstanding_paise<=0) {job.skippedPaid++;job.processed++;continue;}
   const recipient=this.phone(r.phone);
   if(!recipient) {job.skippedMissing++;job.processed++;continue;}
   const prior=this.db.prepare("SELECT status,day FROM whatsapp_outbox WHERE source=? AND invoice_id=? AND (day=? OR status IN ('UNKNOWN','SENDING','FAILED')) ORDER BY id DESC LIMIT 1").get(r.source,String(r.invoice_id),day);
   if(prior) {if(['UNKNOWN','SENDING','FAILED'].includes(prior.status))job.skippedHeld++;else job.skippedDuplicate++;job.processed++;continue;}
   const row=this.db.prepare("INSERT INTO whatsapp_outbox(source,invoice_id,day,recipient,status) VALUES(?,?,?,?,'SENDING')").run(r.source,String(r.invoice_id),day,recipient);
   try {
    const response=await this.fetch('https://graph.facebook.com/'+c.version+'/'+c.phoneId+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:c.template,language:{code:c.language},components:[{type:'body',parameters:[r.customer_name,r.invoice_number,(r.outstanding_paise/100).toFixed(2),r.due_date || 'Not specified'].map(text=>({type:'text',text:String(text || '')}))}]}})});
    const result=await response.json();
    if(!response.ok) {
     this.db.prepare("UPDATE whatsapp_outbox SET status='FAILED',error=? WHERE id=?").run('Meta rejected request (code '+String(result.error?.code || response.status)+'). Check connection or template settings.',row.lastInsertRowid);
     job.failed++;job.processed++;job.error='Batch stopped after Meta rejected a reminder. Review history.';break;
    }
    if(!result.messages?.[0]?.id)throw new Error('No message confirmation');
    this.db.prepare("UPDATE whatsapp_outbox SET status='ACCEPTED',message_id=? WHERE id=?").run(result.messages[0].id,row.lastInsertRowid);job.accepted++;
   } catch {
    this.db.prepare("UPDATE whatsapp_outbox SET status='UNKNOWN',error='Delivery uncertain; check Meta before sending another reminder.' WHERE id=?").run(row.lastInsertRowid);
    job.unknown++;job.processed++;job.error='Batch stopped because the delivery result is uncertain. Review history.';break;
   }
   job.processed++;
  }
 }
 async stop() {this.stopping=true;await this.running;}
}
module.exports={WhatsAppService};
