const {openDatabase,DB_PATH}=require('./src/db');
const {createWebhook}=require('./src/whatsapp-webhook');
const db=openDatabase(process.env.FROSTFLOW_DB || DB_PATH);
const server=createWebhook({db,appSecret:process.env.META_APP_SECRET,verifyToken:process.env.META_WEBHOOK_VERIFY_TOKEN,phoneId:()=>JSON.parse(db.prepare('SELECT payload FROM whatsapp_config WHERE id=1').get()?.payload || '{}').phoneId || process.env.META_PHONE_ID || '1260169793854093'});
server.listen(Number(process.env.WHATSAPP_WEBHOOK_PORT || 4318),'127.0.0.1',()=>console.log('WhatsApp webhook listening on localhost:4318/webhooks/whatsapp'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
