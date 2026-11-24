import { PlatformError, SESSION_SECONDS, checkOrigin, equalSecret, integer, json, randomHex, readJson, sha256, text } from './platform-core.js';

const STAFF_COOKIE='__Secure-cafe_staff_session';
const LEGACY_COOKIE='__Secure-cafe_session';
const ITERATIONS=210000;
const defaultPermissions={
  OWNER:['*'],
  MANAGER:['pos','kitchen','orders','payments','refunds','discounts','inventory','reports','qr','availability'],
  CASHIER:['pos','orders','payments'],
  KITCHEN:['kitchen'],
};

function cookie(request,name) {
  const match=(request.headers.get('Cookie')||'').match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`,'i'));
  return match?.[1]||'';
}

function sessionCookie(token,maxAge) {
  return `${STAFF_COOKIE}=${token}; Path=/api/cafe; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function fromHex(hex) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new PlatformError('Invalid password hash',500);
  return Uint8Array.from(hex.match(/.{2}/g),value=>parseInt(value,16));
}

function toHex(bytes) { return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join(''); }

async function derive(password,salt,iterations) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:fromHex(salt),iterations},key,256);
  return toHex(new Uint8Array(bits));
}

export async function passwordRecord(password) {
  if (typeof password!=='string'||password.length<12||password.length>200) throw new PlatformError('Staff password must be 12–200 characters');
  const salt=randomHex(16);
  return {password_salt:salt,password_hash:await derive(password,salt,ITERATIONS),password_iterations:ITERATIONS};
}

async function verifyPassword(password,row) {
  const hash=await derive(password,row.password_salt,integer(row.password_iterations,'iterations',100000,1000000));
  return equalSecret(hash,row.password_hash);
}

export async function principal(request,env) {
  const token=cookie(request,STAFF_COOKIE);
  if (token) {
    const row=await env.DB.prepare(`SELECT s.username,s.role,s.expires_at,s.user_id,u.active,u.permissions_json
      FROM cafe_staff_sessions s LEFT JOIN cafe_staff_users u ON u.id=s.user_id
      WHERE s.token_hash=?1 AND s.expires_at>?2`).bind(await sha256(token),Math.floor(Date.now()/1000)).first();
    if (row && (row.user_id===null||row.active===1)) {
      return {username:row.username,role:row.role,permissions:row.user_id?JSON.parse(row.permissions_json||'[]'):['*']};
    }
  }
  const legacy=cookie(request,LEGACY_COOKIE);
  if (legacy) {
    const row=await env.DB.prepare('SELECT token_hash FROM cafe_admin_sessions WHERE token_hash=?1 AND expires_at>?2')
      .bind(await sha256(legacy),Math.floor(Date.now()/1000)).first();
    if (row) return {username:env.CAFE_ADMIN_USER||'owner',role:'OWNER',permissions:['*']};
  }
  return null;
}

export function can(user,permission) {
  if (!user) return false;
  if (user.role==='OWNER') return true;
  return (defaultPermissions[user.role]||[]).includes(permission) ||
    (Array.isArray(user.permissions)&&user.permissions.includes(permission));
}

export function requirePermission(user,permission) {
  if (!user) throw new PlatformError('Sign in to continue',401);
  if (!can(user,permission)) throw new PlatformError('You do not have permission for this action',403);
  return user;
}

export async function staffLogin(request,env) {
  checkOrigin(request);
  const body=await readJson(request,3000);
  if (!env.CAFE_SESSION_SECRET) throw new PlatformError('Staff sign-in is not configured',503);
  const username=text(body.username,'username',80);
  const password=text(body.password,'password',200);
  const now=Math.floor(Date.now()/1000);
  const ipHash=await sha256(`${env.CAFE_SESSION_SECRET}:${request.headers.get('CF-Connecting-IP')||'local'}`);
  const attempt=await env.DB.prepare('SELECT failure_count,window_started FROM cafe_auth_attempts WHERE ip_hash=?1').bind(ipHash).first();
  if (attempt&&attempt.window_started>now-900&&attempt.failure_count>=8) throw new PlatformError('Too many sign-in attempts. Try again later.',429);
  let role=null,userId=null;
  if (env.CAFE_ADMIN_USER&&env.CAFE_ADMIN_PASSWORD &&
      await equalSecret(username,env.CAFE_ADMIN_USER) && await equalSecret(password,env.CAFE_ADMIN_PASSWORD)) role='OWNER';
  else {
    const staff=await env.DB.prepare('SELECT * FROM cafe_staff_users WHERE username=?1 AND active=1').bind(username).first();
    if (staff && await verifyPassword(password,staff)) { role=staff.role; userId=staff.id; }
  }
  if (!role) {
    const failures=attempt&&attempt.window_started>now-900?attempt.failure_count+1:1;
    await env.DB.prepare(`INSERT INTO cafe_auth_attempts(ip_hash,failure_count,window_started) VALUES(?1,?2,?3)
      ON CONFLICT(ip_hash) DO UPDATE SET failure_count=excluded.failure_count,window_started=excluded.window_started`)
      .bind(ipHash,failures,failures===1?now:attempt.window_started).run();
    throw new PlatformError('Invalid username or password',401);
  }
  const token=randomHex(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cafe_auth_attempts WHERE ip_hash=?1').bind(ipHash),
    env.DB.prepare('DELETE FROM cafe_staff_sessions WHERE expires_at<=?1').bind(now),
    env.DB.prepare(`INSERT INTO cafe_staff_sessions(token_hash,user_id,username,role,created_at,expires_at)
      VALUES(?1,?2,?3,?4,?5,?6)`).bind(await sha256(token),userId,username,role,now,now+SESSION_SECONDS),
  ]);
  return json({authenticated:true,username,role},200,{'Set-Cookie':sessionCookie(token,SESSION_SECONDS)});
}

export async function staffLogout(request,env) {
  checkOrigin(request);
  const token=cookie(request,STAFF_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM cafe_staff_sessions WHERE token_hash=?1').bind(await sha256(token)).run();
  return json({authenticated:false},200,{'Set-Cookie':sessionCookie('',0)});
}

export async function staffSession(request,env) {
  const user=await principal(request,env);
  return user?json({authenticated:true,username:user.username,role:user.role,permissions:user.permissions}):json({authenticated:false},401);
}
