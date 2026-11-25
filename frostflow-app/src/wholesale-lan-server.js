'use strict';
const http=require('node:http');
const https=require('node:https');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {openDatabase,DATA_DIR}=require('./db');
const {WholesalePicking}=require('./services/wholesale-picking');
const {readUsers,verifyPassword}=require('./wholesale-lan-auth');

const PUBLIC_DIR=path.resolve(__dirname,'..','public');
const AUTH_FILE=path.join(DATA_DIR,'wholesale-lan-auth.json');
const SESSION_MS=12*60*60*1000;
const LOGIN_WINDOW_MS=10*60*1000;
const LOGIN_LIMIT=6;
const STATIC={
  '/wholesale-lan.html':['wholesale-lan.html','text/html; charset=utf-8'],
  '/wholesale-lan.css':['wholesale-lan.css','text/css; charset=utf-8'],
  '/wholesale-lan.js':['wholesale-lan.js','application/javascript; charset=utf-8'],
};

function privateIPv4(address){
  if(net.isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return a===127||a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
}
function resolveDatabasePath(root=path.resolve(__dirname,'..')){
  if(process.env.FROSTFLOW_DB)return path.resolve(process.env.FROSTFLOW_DB);
  const configFile=path.join(root,'data','cloud-sync.json');
  if(fs.existsSync(configFile)){
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    if(config.databasePath)return path.resolve(config.databasePath);
  }
  return path.join(root,'data','frostflow.sqlite');
}
function cookieValue(raw,name){
  const part=String(raw||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(name+'='));
  return part?part.slice(name.length+1):'';
}
function csrfEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}
function createWholesaleLanServer({dbPath=resolveDatabasePath(),authFile=AUTH_FILE,host='127.0.0.1',tlsKey='',tlsCert=''}={}){
  if(!privateIPv4(host))throw new Error('Wholesale LAN host must be a private IPv4 address or 127.0.0.1.');
  if(!fs.existsSync(dbPath)&&dbPath!==':memory:')throw new Error(`FrostFlow database not found at ${dbPath}. Start the Windows billing sync first or set FROSTFLOW_DB.`);
  readUsers(authFile);
  if(Boolean(tlsKey)!==Boolean(tlsCert))throw new Error('Both TLS key and certificate must be configured together.');
  const secure=Boolean(tlsKey),protocol=secure?'https':'http';
  const db=openDatabase(dbPath);
  const wholesale=new WholesalePicking(db);
  const sessions=new Map(),failures=new Map();
  const commonHeaders={
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
    'Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  function json(res,status,body,extra={}){res.writeHead(status,{...commonHeaders,'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(body));}
  function userSession(req){
    const token=cookieValue(req.headers.cookie,'wholesale_session');
    if(!/^[a-f0-9]{64}$/.test(token))return null;
    const session=sessions.get(token);
    if(!session)return null;
    if(session.expiresAt<Date.now()){sessions.delete(token);return null;}
    return {token,...session};
  }
  function sameOrigin(req,port){
    const origin=req.headers.origin;
    return !origin||origin===`${protocol}://${req.headers.host}`;
  }
  async function body(req){
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Object.assign(new Error('Send JSON data.'),{status:415});
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>1_000_000)throw Object.assign(new Error('Request is too large.'),{status:413});chunks.push(chunk);}
    let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400});}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('Expected a JSON object.'),{status:400});
    return value;
  }
  const handle=async(req,res)=>{
    try{
      const port=server.address()?.port;
      const hostHeader=String(req.headers.host||'');
      const allowed=new Set([`${host}:${port}`]);
      if(host==='127.0.0.1')allowed.add(`localhost:${port}`);
      if(!allowed.has(hostHeader))return json(res,403,{error:'This address is not allowed.'});
      if(!sameOrigin(req,port))return json(res,403,{error:'Cross-site requests are not allowed.'});
      const url=new URL(req.url,`${protocol}://${hostHeader}`),route=url.pathname;
      if(req.method==='GET'&&route==='/api/health')return json(res,200,{ok:true,service:'MR Enterprises wholesale LAN'});
      if(req.method==='GET'&&route==='/'){
        res.writeHead(302,{...commonHeaders,Location:'/wholesale-lan.html'});return res.end();
      }
      if(req.method==='GET'&&STATIC[route]){
        const [file,mime]=STATIC[route];
        const bytes=fs.readFileSync(path.join(PUBLIC_DIR,file));
        res.writeHead(200,{...commonHeaders,'Content-Type':mime,'Content-Length':bytes.length});return res.end(bytes);
      }
      if(route==='/api/login'&&req.method==='POST'){
        const ip=req.socket.remoteAddress||'';
        const history=(failures.get(ip)||[]).filter(time=>time>Date.now()-LOGIN_WINDOW_MS);
        if(history.length>=LOGIN_LIMIT)return json(res,429,{error:'Too many login attempts. Try again shortly.'});
        const input=await body(req);
        const users=readUsers(authFile);
        const user=users.find(entry=>entry.username.toLowerCase()===String(input.username||'').toLowerCase());
        if(!user||!verifyPassword(input.password,user)){
          failures.set(ip,[...history,Date.now()]);
          return json(res,401,{error:'Username or password is incorrect.'});
        }
        failures.delete(ip);
        const token=crypto.randomBytes(32).toString('hex');
        const session={user:user.username,role:user.role,csrf:crypto.randomBytes(24).toString('hex'),expiresAt:Date.now()+SESSION_MS};
        sessions.set(token,session);
        const cookie=`wholesale_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS/1000)}${secure?'; Secure':''}`;
        return json(res,200,{user:session.user,role:session.role,csrf:session.csrf},{'Set-Cookie':cookie});
      }
      if(!route.startsWith('/api/'))return json(res,404,{error:'Page not found.'});
      const session=userSession(req);
      if(!session)return json(res,401,{error:'Please sign in.'});
      if(route==='/api/session'&&req.method==='GET')return json(res,200,{user:session.user,role:session.role,csrf:session.csrf});
      if(!['GET','HEAD'].includes(req.method)&&!csrfEqual(req.headers['x-csrf-token'],session.csrf))return json(res,403,{error:'Session check failed. Sign in again.'});
      if(route==='/api/logout'&&req.method==='POST'){
        sessions.delete(session.token);
        return json(res,200,{ok:true},{'Set-Cookie':'wholesale_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
      }
      if(route==='/api/categories'&&req.method==='GET')return json(res,200,wholesale.categories());
      if(route==='/api/catalog'&&req.method==='GET')return json(res,200,wholesale.catalog(url.searchParams.get('q')||'',url.searchParams.get('category')||'',url.searchParams.get('offset')||0));
      if(route==='/api/customers'&&req.method==='GET')return json(res,200,wholesale.customers(url.searchParams.get('q')||''));
      if(route==='/api/orders'&&req.method==='GET')return json(res,200,wholesale.list());
      if(route==='/api/orders'&&req.method==='POST')return json(res,201,wholesale.createOrder(await body(req)));
      if(route==='/api/import-online'&&req.method==='POST')return json(res,200,wholesale.importInbox());
      const detail=route.match(/^\/api\/orders\/(\d+)$/);
      if(detail&&req.method==='GET')return json(res,200,wholesale.detail(Number(detail[1])));
      const line=route.match(/^\/api\/orders\/(\d+)\/lines\/(\d+)$/);
      if(line&&req.method==='PATCH')return json(res,200,wholesale.setPicked(Number(line[1]),Number(line[2]),await body(req)));
      const status=route.match(/^\/api\/orders\/(\d+)\/status$/);
      if(status&&req.method==='PATCH')return json(res,200,wholesale.setStatus(Number(status[1]),(await body(req)).status));
      const draft=route.match(/^\/api\/orders\/(\d+)\/draft$/);
      if(draft&&req.method==='POST'){
        if(session.role!=='OWNER')return json(res,403,{error:'Owner approval is required for invoice drafts.'});
        return json(res,201,wholesale.createDraft(Number(draft[1])));
      }
      const savedDraft=route.match(/^\/api\/drafts\/(\d+)$/);
      if(savedDraft&&req.method==='GET'){
        if(session.role!=='OWNER')return json(res,403,{error:'Owner approval is required for invoice drafts.'});
        return json(res,200,wholesale.draft(Number(savedDraft[1])));
      }
      return json(res,404,{error:'API endpoint not found.'});
    }catch(error){
      const status=Number(error.status);
      if(!Number.isInteger(status)||status<400||status>499)console.error('Wholesale LAN request failed:',error);
      json(res,Number.isInteger(status)&&status>=400&&status<=499?status:500,{error:Number.isInteger(status)&&status>=400&&status<=499?error.message:'The request could not be completed.'});
    }
  };
  const server=secure?https.createServer({key:fs.readFileSync(tlsKey),cert:fs.readFileSync(tlsCert)},handle):http.createServer(handle);
  server.requestTimeout=30_000;server.headersTimeout=10_000;
  const close=()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}));
  return {server,db,wholesale,close};
}
module.exports={createWholesaleLanServer,resolveDatabasePath,privateIPv4};
