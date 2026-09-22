const {AppError}=require('../domain');
function category(name){const n=String(name).toLowerCase();if(/combo|\(1\+1\)/.test(n))return 'Combos';if(/tricone|tricon/.test(n))return 'Tricones';if(/\bstk\b|stick|frostik|kulfi|chocobar/.test(n))return 'Sticks & Kulfi';if(/125\s*m[l]?\b/.test(n))return 'Cups 125 ml';if(/bulk|catering|\b[245]\s*l\b/.test(n))return 'Bulk Packs';if(/\bcup\b/.test(n))return 'Other Cups';if(/\bfp\b|family|\btub\b/.test(n))return 'Family Packs & Tubs';if(/sandwich|cassatta|cassata/.test(n))return 'Sandwiches & Cassatta';if(/\bic\b|ice\s*cream/.test(n))return 'Other Ice Creams';return 'Dairy & Other Products';}
function inboxSchema(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_delivery_events(message_id TEXT NOT NULL,status TEXT NOT NULL,event_time TEXT NOT NULL,error TEXT,received_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(message_id,status,event_time));`);
 db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_incoming_messages(message_id TEXT PRIMARY KEY,from_number TEXT NOT NULL,message_type TEXT NOT NULL,body TEXT,event_time TEXT NOT NULL,raw_json TEXT NOT NULL,received_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS whatsapp_chat_outbox(request_id TEXT PRIMARY KEY,recipient TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,error TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS whatsapp_catalog_items(product_id TEXT PRIMARY KEY,retailer_id TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS whatsapp_order_requests(message_id TEXT PRIMARY KEY,customer_phone TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'REVIEW',received_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
}
class WhatsAppInbox {
 constructor(db,wa){this.db=db;this.wa=wa;inboxSchema(db);db.prepare("UPDATE whatsapp_chat_outbox SET status='UNKNOWN',error='App restarted during sending. Check delivery before retrying.' WHERE status='SENDING'").run();}
 list(){return this.db.prepare(`SELECT phone,MAX(time) last_activity FROM (SELECT from_number phone,received_at time FROM whatsapp_incoming_messages UNION ALL SELECT recipient,created_at FROM whatsapp_chat_outbox UNION ALL SELECT recipient,created_at FROM whatsapp_outbox) GROUP BY phone ORDER BY last_activity DESC LIMIT 200`).all();}
 thread(phone){
  phone=this.wa.phone(phone);if(!phone)throw new AppError('Invalid phone number.');
  const incoming=this.db.prepare('SELECT message_id id,body,message_type,event_time,received_at time FROM whatsapp_incoming_messages WHERE from_number=? ORDER BY received_at DESC LIMIT 200').all(phone).map(r=>({...r,direction:'IN'}));
  const outgoing=this.db.prepare('SELECT request_id id,body,status,message_id,error,created_at time FROM whatsapp_chat_outbox WHERE recipient=? ORDER BY created_at DESC LIMIT 200').all(phone).map(r=>({...r,direction:'OUT'}));
  for(const r of this.db.prepare('SELECT id,source,invoice_id,status,message_id,error,created_at time FROM whatsapp_outbox WHERE recipient=? ORDER BY id DESC LIMIT 200').all(phone))outgoing.push({...r,id:'reminder-'+r.id,direction:'OUT',body:'Payment reminder · '+r.source+' invoice '+r.invoice_id});
  for(const r of outgoing){if(r.message_id){const e=this.db.prepare("SELECT status,error FROM whatsapp_delivery_events WHERE message_id=? ORDER BY CASE status WHEN 'READ' THEN 4 WHEN 'DELIVERED' THEN 3 WHEN 'SENT' THEN 2 ELSE 1 END DESC LIMIT 1").get(r.message_id);if(e)Object.assign(r,e);}}
  const latest=this.db.prepare('SELECT MAX(CAST(event_time AS INTEGER)) t FROM whatsapp_incoming_messages WHERE from_number=?').get(phone).t;
  return {phone,canReply:!!latest && latest<=Date.now()/1000+60 && Date.now()/1000-latest<86400,messages:[...incoming,...outgoing].sort((a,b)=>a.time.localeCompare(b.time))};
 }
 catalog(){return {catalogId:this.db.prepare("SELECT value FROM settings WHERE key='whatsapp_catalog_id'").get()?.value || '',items:this.db.prepare('SELECT p.product_id,p.sku,p.product_name,p.mrp_paise,p.selling_price_paise,p.stock_qty,c.retailer_id FROM amul_products_local p LEFT JOIN whatsapp_catalog_items c ON c.product_id=p.product_id WHERE p.active=1 ORDER BY p.product_name').all()};}
 saveCatalog(input){
  if(!/^\d+$/.test(String(input.catalogId)))throw new AppError('Enter a valid Meta Commerce catalog ID.');
  if(!Array.isArray(input.items)||input.items.length>5000)throw new AppError('Invalid catalog items.');
  const seen=new Set();for(const r of input.items){if(!r.retailerId||String(r.retailerId).length>100||seen.has(r.retailerId)||!this.db.prepare('SELECT 1 FROM amul_products_local WHERE product_id=? AND active=1').get(String(r.productId)))throw new AppError('Invalid or duplicate catalog mapping.');seen.add(r.retailerId);}
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("INSERT INTO settings(key,value) VALUES('whatsapp_catalog_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(input.catalogId));this.db.exec('DELETE FROM whatsapp_catalog_items');for(const r of input.items)this.db.prepare('INSERT INTO whatsapp_catalog_items VALUES(?,?)').run(String(r.productId),String(r.retailerId));this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}return this.catalog();
 }
 async send(input){
  const phone=this.wa.phone(input.phone),key=String(input.requestId || '');
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key))throw new AppError('A unique request ID is required.');
  const text=String(input.text || '').trim();let payload={messaging_product:'whatsapp',to:phone,type:'text',text:{body:text}};
  if(input.productIds){const c=this.catalog();if(!Array.isArray(input.productIds)||input.productIds.length<1||input.productIds.length>30)throw new AppError('Choose 1–30 products.');const items=[...new Set(input.productIds.map(String))].map(id=>c.items.find(p=>p.product_id===id));if(items.some(p=>!p))throw new AppError('Selected product is unavailable. Refresh the catalog.');const groups=new Map();for(const p of items){const k=category(p.product_name);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(`${p.sku || p.product_id} — ${p.product_name}`);}const body='AMUL PRODUCT LIST\n\n'+[...groups].map(([k,v])=>'*'+k+'*\n'+v.join('\n')).join('\n\n')+'\n\nTo order, reply with product code, quantity and unit (BOX / CRT / PC). Prices and availability will be confirmed before billing.';if(body.length>4096)throw new AppError('Select fewer products so the list fits in one message.');payload={messaging_product:'whatsapp',to:phone,type:'text',text:{body}};}
  else if(!text||text.length>4096)throw new AppError('Enter a message of 1–4096 characters.');
  const serialized=JSON.stringify(payload),prior=this.db.prepare('SELECT * FROM whatsapp_chat_outbox WHERE request_id=?').get(key);
  if(prior){if(prior.body!==serialized||prior.recipient!==phone)throw new AppError('Request ID already used.',409);return prior;}
  if(!this.thread(phone).canReply)throw new AppError('The 24-hour reply window is closed. Send an approved template from Invoices or ask the customer to message you first.',409);
  const c=this.wa.config();if(!this.wa.token||!c.phoneId||!c.version)throw new AppError('Configure WhatsApp settings and token first.');
  this.db.prepare("INSERT INTO whatsapp_chat_outbox(request_id,recipient,body,status) VALUES(?,?,?,'SENDING')").run(key,phone,serialized);
  try{const response=await this.wa.fetch(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`,{method:'POST',headers:{Authorization:'Bearer '+this.wa.token,'Content-Type':'application/json'},body:serialized,signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok||!result.messages?.[0]?.id){this.db.prepare("UPDATE whatsapp_chat_outbox SET status='FAILED',error=? WHERE request_id=?").run('Meta rejected message: '+String(result.error?.code || response.status),key);}else this.db.prepare("UPDATE whatsapp_chat_outbox SET status='ACCEPTED',message_id=? WHERE request_id=?").run(result.messages[0].id,key);}catch{this.db.prepare("UPDATE whatsapp_chat_outbox SET status='UNKNOWN',error='Delivery uncertain. Do not resend without checking.' WHERE request_id=?").run(key);}
  return this.db.prepare('SELECT * FROM whatsapp_chat_outbox WHERE request_id=?').get(key);
 }
}
module.exports={WhatsAppInbox,inboxSchema,category};
