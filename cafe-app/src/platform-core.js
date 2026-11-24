export const encoder = new TextEncoder();
export const SESSION_SECONDS = 12 * 60 * 60;
export const MAX_LINES = 30;
export const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export class PlatformError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function randomHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), x => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}

export async function equalSecret(left, right) {
  const [a,b] = await Promise.all([sha256(left),sha256(right)]);
  let diff = a.length ^ b.length;
  for (let i=0;i<Math.min(a.length,b.length);i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

export function checkOrigin(request) {
  const origin=request.headers.get('Origin');
  const site=request.headers.get('Sec-Fetch-Site');
  if ((origin && origin!==new URL(request.url).origin) || (site && !['same-origin','none'].includes(site))) {
    throw new PlatformError('Cross-site request rejected',403);
  }
}

export async function readJson(request,maxBytes=60000) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||'')) throw new PlatformError('JSON required',415);
  if (Number(request.headers.get('Content-Length')||0)>maxBytes) throw new PlatformError('Request too large',413);
  const raw=await request.text();
  if (encoder.encode(raw).length>maxBytes) throw new PlatformError('Request too large',413);
  let body;
  try { body=JSON.parse(raw); } catch { throw new PlatformError('Invalid JSON'); }
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new PlatformError('JSON object required');
  return body;
}

export function text(value,field,max=200,required=true) {
  const result=String(value??'').trim();
  if (required&&!result) throw new PlatformError(`${field} is required`);
  if (result.length>max) throw new PlatformError(`${field} is too long`);
  return result;
}

export function integer(value,field,min=0,max=10_000_000,required=true) {
  if (!required && (value===null||value===undefined||value==='')) return null;
  const n=Number(value);
  if (!Number.isSafeInteger(n)||n<min||n>max) throw new PlatformError(`Invalid ${field}`);
  return n;
}

export function decimal(value,field,min=0,max=1_000_000) {
  const n=Number(value);
  if (!Number.isFinite(n)||n<min||n>max||Math.round(n*1000)!==n*1000) throw new PlatformError(`Invalid ${field}`);
  return n;
}

export function flag(value,field) {
  if (typeof value==='boolean') return value?1:0;
  if (value===0||value===1) return value;
  throw new PlatformError(`Invalid ${field}`);
}

export function slug(value,field='id') {
  const result=text(value,field,80);
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(result)) throw new PlatformError(`Invalid ${field}`);
  return result;
}

export function parseArray(value,field,max=50) {
  if (!Array.isArray(value)||value.length>max) throw new PlatformError(`Invalid ${field}`);
  return value;
}

export function parseDbJson(value,fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function asUtc(value) {
  return value && !/[zZ]|[+-]\d\d:\d\d$/.test(value) ? `${value.replace(' ','T')}Z` : value;
}

export function html(value) {
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

export function dateKey() {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const val=type=>parts.find(part=>part.type===type).value;
  return `${val('year')}${val('month')}${val('day')}`;
}

export function requestId(value) {
  const id=text(value,'request_id',80);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new PlatformError('Invalid request_id');
  return id;
}

export async function paymentMethods(env) {
  const rows=(await env.DB.prepare(`SELECT key,value FROM cafe_settings
    WHERE key IN ('cash_enabled','upi_enabled','card_enabled')`).all()).results||[];
  const settings=Object.fromEntries(rows.map(row=>[row.key,parseDbJson(row.value,true)]));
  return ['CASH','UPI','CARD'].filter(method=>settings[`${method.toLowerCase()}_enabled`]!==false);
}

export async function audit(env,actor,action,entityType,entityId,detail={}) {
  await env.DB.prepare('INSERT INTO cafe_audit_log(id,actor,action,entity_type,entity_id,detail_json) VALUES(?1,?2,?3,?4,?5,?6)')
    .bind(crypto.randomUUID(),actor,action,entityType,entityId,JSON.stringify(detail)).run();
}
