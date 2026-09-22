const http = require('node:http');
const {createHmac, timingSafeEqual} = require('node:crypto');

// This separate listener exposes no ERP pages or business APIs.
function createWebhook({db, appSecret, verifyToken, phoneId}) {
  if (!appSecret || !verifyToken || !phoneId) throw new Error('Webhook app secret, verify token and phone ID are required.');
  require('./services/whatsapp-inbox').inboxSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_delivery_events (
    message_id TEXT NOT NULL, status TEXT NOT NULL, event_time TEXT NOT NULL,
    error TEXT, received_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(message_id,status,event_time));`);
  db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_incoming_messages (
    message_id TEXT PRIMARY KEY, from_number TEXT NOT NULL, message_type TEXT NOT NULL,
    body TEXT, event_time TEXT NOT NULL, raw_json TEXT NOT NULL,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  return http.createServer(async (req,res) => {
    const send=(code,text)=>{res.writeHead(code,{'Content-Type':'text/plain'});res.end(text);};
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET' && ['/privacy','/privacy.html'].includes(url.pathname)) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});
        return res.end(require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/privacy.html')));
      }
      if(req.method==='GET' && url.pathname==='/healthz')return send(200,'OK');
      if(!['/webhooks/whatsapp','/webhooks/whatsapp/'].includes(url.pathname))return send(404,'Not found');
      if(req.method==='GET') {
        if(url.searchParams.get('hub.mode')==='subscribe' && url.searchParams.get('hub.verify_token')===verifyToken)
          return send(200,url.searchParams.get('hub.challenge') || '');
        return send(403,'Verification failed');
      }
      if(req.method!=='POST')return send(405,'Method not allowed');
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1048576)return send(413,'Too large');chunks.push(chunk);}
      const raw=Buffer.concat(chunks);
      const signature=String(req.headers['x-hub-signature-256'] || '');
      const expected='sha256='+createHmac('sha256',appSecret).update(raw).digest('hex');
      if(signature.length!==expected.length || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return send(403,'Invalid signature');
      const body=JSON.parse(raw.toString('utf8'));
      if(body.object!=='whatsapp_business_account')return send(400,'Invalid object');
      db.exec('BEGIN IMMEDIATE');
      try {
        for(const entry of body.entry || [])for(const change of entry.changes || []) {
          const value=change.value;
          if(change.field!=='messages' || value?.metadata?.phone_number_id!==(typeof phoneId==='function'?phoneId():phoneId))continue;
          for(const message of value.messages || []) {
            if(!message.id || !message.from)continue;
            if(message.type==='order' && message.order)db.prepare('INSERT OR IGNORE INTO whatsapp_order_requests(message_id,customer_phone,payload) VALUES(?,?,?)').run(message.id,String(message.from),JSON.stringify(message.order));
            const body=message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
            db.prepare('INSERT OR IGNORE INTO whatsapp_incoming_messages(message_id,from_number,message_type,body,event_time,raw_json) VALUES(?,?,?,?,?,?)').run(message.id,String(message.from),String(message.type || 'unknown'),body,String(message.timestamp || ''),JSON.stringify(message));
          }
          for(const event of value.statuses || []) {
            const status=String(event.status || '').toUpperCase();
            if(!['SENT','DELIVERED','READ','FAILED'].includes(status) || !event.id || !event.timestamp)continue;
            const error=event.errors?.map(e=>`${e.code}: ${e.title || e.message || ''} ${e.error_data?.details || ''}`).join('; ').slice(0,4000) || null;
            db.prepare('INSERT OR IGNORE INTO whatsapp_delivery_events(message_id,status,event_time,error) VALUES(?,?,?,?)').run(event.id,status,String(event.timestamp),error);
            const prior=db.prepare('SELECT status FROM whatsapp_outbox WHERE message_id=?').get(event.id);
            const ranks={ACCEPTED:0,UNKNOWN:0,SENDING:0,FAILED:1,SENT:2,DELIVERED:3,READ:4};
            if(prior && (ranks[status]>=(ranks[prior.status] ?? 0)))db.prepare('UPDATE whatsapp_outbox SET status=?,error=? WHERE message_id=?').run(status,error,event.id);
          }
        }
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      send(200,'EVENT_RECEIVED');
    }catch(error){send(error instanceof SyntaxError?400:500,'Webhook processing failed');}
  });
}
module.exports={createWebhook};
