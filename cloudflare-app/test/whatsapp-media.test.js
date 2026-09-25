import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker,{whatsappMedia,messageBody} from '../src/worker.js';

function d1(){
 const db=new DatabaseSync(':memory:');const dir=new URL('../migrations/',import.meta.url);
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
 const wrap=(sql,args=[])=>({bind:(...a)=>wrap(sql,a),first:async()=>db.prepare(sql).get(...args)??null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>{db.prepare(sql).run(...args);return{meta:{}}}});
 return{db,DB:{prepare:sql=>wrap(sql),batch:async l=>{for(const s of l)await s.run()}}};
}
const image={from:'919000000001',id:'wamid.IMG1',type:'image',image:{caption:'Paid using PhonePe UPI.',mime_type:'image/jpeg',id:'1812982189700250'}};
function seed(env){
 env.db.prepare("INSERT INTO whatsapp_events(event_id,event_type,from_number,direction,message_type,body,raw_json) VALUES(?,?,?,?,?,?,?)").run('wamid.IMG1','MESSAGE','919000000001','INBOUND','image',null,JSON.stringify(image));
 env.db.prepare("INSERT INTO whatsapp_events(event_id,event_type,from_number,direction,message_type,body,raw_json) VALUES(?,?,?,?,?,?,?)").run('wamid.TXT1','MESSAGE','919000000001','INBOUND','text','Need 2 boxes','not json');
}

test('captions and filenames become the stored message text',()=>{
 assert.equal(messageBody(image),'Paid using PhonePe UPI.');
 assert.equal(messageBody({type:'document',document:{filename:'invoice.pdf'}}),'invoice.pdf');
 assert.equal(messageBody({type:'text',text:{body:'hello'}}),'hello');
});

test('conversations expose captions and media for rows already stored, and tolerate malformed raw_json',async()=>{
 const env={...d1(),APP_USER:'u',APP_PASSWORD:'p'};seed(env);
 const res=await worker.fetch(new Request('https://x/api/whatsapp/conversations',{headers:{authorization:'Basic '+btoa('u:p')}}),env);
 assert.equal(res.status,200);
 const messages=(await res.json()).conversations[0].messages;
 const img=messages.find(m=>m.event_id==='wamid.IMG1'),txt=messages.find(m=>m.event_id==='wamid.TXT1');
 assert.equal(img.body,'Paid using PhonePe UPI.');assert.equal(img.has_media,1);assert.equal(img.media_mime,'image/jpeg');
 assert.equal(txt.body,'Need 2 boxes');assert.equal(txt.has_media,0);
});

test('media is fetched from Meta only for stored inbound attachments',async()=>{
 const env={...d1(),META_ACCESS_TOKEN:'token',META_GRAPH_VERSION:'v25.0'};seed(env);
 const calls=[];const real=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{calls.push([String(url),opts?.headers?.authorization]);if(String(url).startsWith('https://graph.facebook.com/'))return new Response(JSON.stringify({url:'https://lookaside.example/file',mime_type:'image/jpeg'}),{status:200});return new Response(new Uint8Array([1,2,3]),{status:200});};
 try{
  const ok=await whatsappMedia(env,'wamid.IMG1');
  assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'image/jpeg');assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())],[1,2,3]);
  assert.equal(calls[0][0],'https://graph.facebook.com/v25.0/1812982189700250');assert.equal(calls[0][1],'Bearer token');assert.equal(calls[1][1],'Bearer token');
  assert.equal((await whatsappMedia(env,'wamid.TXT1')).status,404);
  assert.equal((await whatsappMedia(env,'wamid.missing')).status,404);
  assert.equal(calls.length,2);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'expired'}}),{status:404});
  assert.equal((await whatsappMedia(env,'wamid.IMG1')).status,410);
 }finally{globalThis.fetch=real;}
});
