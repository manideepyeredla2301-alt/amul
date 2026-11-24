import prep from './prep.json' with { type: 'json' };
import { PlatformError, MAX_LINES, asUtc, audit, checkOrigin, dateKey, html, integer, json, parseArray, parseDbJson, paymentMethods, randomHex, readJson, requestId, text, sha256 } from './platform-core.js';
import { requirePermission } from './platform-auth.js';
import { catalog, itemFromRow, priceProduct, productRow } from './platform-catalog.js';

function effectiveStatus(row) { return row.status==='RECEIVED'&&row.accepted_at?'ACCEPTED':row.status; }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}

function publicOrder(row,request) {
  const url=new URL('/',request.url);
  url.searchParams.set('order',row.tracking_token);
  return {id:row.id,order_number:row.order_number,status:effectiveStatus(row),tracking_token:row.tracking_token,
    tracking_url:url.toString(),total_paise:row.total_paise,payment_status:row.payment_status||'UNPAID'};
}

async function verifyQr(env,codeId) {
  if (!codeId) return null;
  const id=text(codeId,'qr_code_id',80);
  const row=await env.DB.prepare('SELECT id,label,context,table_number,active FROM cafe_qr_codes WHERE id=?1').bind(id).first();
  if (!row||!row.active) throw new PlatformError('This QR code is unavailable. Please ask the café team for a current code.',410);
  return row;
}

async function rateLimitOrder(request,env) {
  if (!env.CAFE_SESSION_SECRET) throw new PlatformError('Ordering is temporarily unavailable',503);
  const now=Math.floor(Date.now()/1000);
  const ipHash=await sha256(`${env.CAFE_SESSION_SECRET}:${request.headers.get('CF-Connecting-IP')||'local'}`);
  const result=await env.DB.prepare(`INSERT INTO cafe_order_rate(ip_hash,window_started,order_count)
    VALUES(?1,?2,1) ON CONFLICT(ip_hash) DO UPDATE SET
      order_count=CASE WHEN window_started<=?3 THEN 1 ELSE order_count+1 END,
      window_started=CASE WHEN window_started<=?3 THEN ?2 ELSE window_started END
    WHERE window_started<=?3 OR order_count<40`).bind(ipHash,now,now-600).run();
  if (!result.meta?.changes) throw new PlatformError('Too many orders from this connection. Please ask the café team for help.',429);
}

async function activePromotion(env,lines) {
  const rows=(await env.DB.prepare(`SELECT * FROM cafe_promotions WHERE active=1
    AND (starts_at IS NULL OR starts_at<=CURRENT_TIMESTAMP)
    AND (ends_at IS NULL OR ends_at>=CURRENT_TIMESTAMP)
    AND (usage_limit IS NULL OR usage_count<usage_limit) ORDER BY id`).all()).results||[];
  const subtotal=lines.reduce((sum,line)=>sum+line.total_paise,0);
  for (const promo of rows) {
    const categoryIds=parseDbJson(promo.eligible_category_ids_json,[]);
    const productIds=parseDbJson(promo.eligible_product_ids_json,[]);
    const allEligible=!categoryIds.length&&!productIds.length;
    const eligible=lines.filter(line=>allEligible||categoryIds.includes(line.product.category_id)||productIds.includes(line.product.id))
      .reduce((sum,line)=>sum+line.total_paise,0);
    if (promo.type==='FREE_ITEM') {
      if (eligible<=promo.threshold_paise||subtotal<promo.minimum_spend_paise) continue;
      const free=await productRow(env,promo.free_product_id);
      if (!free||!free.active||!free.available) continue;
      if (free.track_stock) {
        if (free.type==='PREPARED') {
          const recipe=(await env.DB.prepare(`SELECT COUNT(*) AS count,MIN(CASE WHEN i.stock_quantity>=r.quantity THEN 1 ELSE 0 END) AS usable
            FROM cafe_recipes r JOIN cafe_ingredients i ON i.id=r.ingredient_id WHERE r.product_id=?1`).bind(free.id).first());
          if (recipe.count ? !recipe.usable : free.stock_quantity<1) continue;
        } else if (free.stock_quantity<1) continue;
      }
      return {promo,free,discount_paise:0};
    }
    if (eligible<promo.minimum_spend_paise||eligible<=promo.threshold_paise) continue;
    const discount=promo.type==='PERCENT'?Math.floor(eligible*promo.discount_value/10000):Math.min(eligible,promo.discount_value);
    if (discount>0) return {promo,free:null,discount_paise:discount};
  }
  return null;
}

async function groupConfigs(env) {
  const rows=(await env.DB.prepare('SELECT id,config_json FROM cafe_option_groups').all()).results||[];
  return Object.fromEntries(rows.map(row=>[row.id,parseDbJson(row.config_json,{})]));
}

function lineTax(line,netTotal=line.total_paise) {
  const rate=line.product.tax_rate_bps||0;
  return rate?Math.round(netTotal*rate/(10000+rate)):0;
}

export async function createOrder(request,env,user=null,source='QR') {
  checkOrigin(request);
  if (source!=='QR') requirePermission(user,'pos');
  const body=await readJson(request,60000);
  const idempotency=requestId(body.request_id);
  const {request_id:ignored,...intent}=body;
  const intentHash=await sha256(JSON.stringify(canonical(intent)));
  const prior=await env.DB.prepare('SELECT * FROM cafe_orders WHERE request_id=?1').bind(idempotency).first();
  if (prior) {
    if (prior.request_hash&&prior.request_hash!==intentHash) throw new PlatformError('This request ID was already used for a different order',409);
    return json(publicOrder(prior,request));
  }
  let serviceType=text(body.service_type,'service_type',20);
  if (!['DINE_IN','TAKEAWAY','COUNTER'].includes(serviceType)) throw new PlatformError('Choose dine-in, takeaway or counter');
  if (source==='QR'&&!body.qr_code_id) throw new PlatformError('Scan or open an active café QR code to order');
  const qr=source==='QR'?await verifyQr(env,body.qr_code_id):null;
  if (qr?.context==='TABLE') serviceType='DINE_IN';
  if (qr?.context==='TAKEAWAY') serviceType='TAKEAWAY';
  if (qr?.context==='COUNTER') serviceType='COUNTER';
  if (source==='QR'&&serviceType==='COUNTER'&&!qr) throw new PlatformError('Counter pickup requires a counter QR code');
  const customerName=text(body.customer_name|| (source==='QR'?'':'Walk-in'),'customer_name',80);
  let tableNumber=text(body.table_number,'table_number',16,serviceType==='DINE_IN'&&qr?.context!=='TABLE');
  if (qr?.context==='TABLE') tableNumber=qr.table_number;
  if (serviceType==='DINE_IN'&&!/^[\p{L}\p{N}][\p{L}\p{N} -]{0,15}$/u.test(tableNumber)) throw new PlatformError('Invalid table number');
  const note=text(body.note,'note',300,false);
  const paymentPreference=body.payment_preference?text(body.payment_preference,'payment_preference',10):null;
  const enabledMethods=await paymentMethods(env);
  if (paymentPreference&&!enabledMethods.includes(paymentPreference)) throw new PlatformError('Payment method is unavailable');
  if (!Array.isArray(body.items)||!body.items.length||body.items.length>MAX_LINES) throw new PlatformError(`Choose 1–${MAX_LINES} items`);
  const groups=await groupConfigs(env),lines=[];
  let quantitySum=0;
  for (const submitted of body.items) {
    if (!submitted||typeof submitted!=='object'||Array.isArray(submitted)) throw new PlatformError('Invalid cart item');
    const product=await productRow(env,text(submitted.item_id,'item_id',80));
    if (!product||!product.active) throw new PlatformError('Item is no longer on the menu',409);
    const category=await env.DB.prepare('SELECT * FROM cafe_categories WHERE id=?1').bind(product.category_id).first();
    if (!category||!category.active||(source==='QR'&&!category.show_qr)||(source!=='QR'&&!category.show_pos)) throw new PlatformError('Item is unavailable in this ordering channel',409);
    const quantity=integer(submitted.quantity,'quantity',1,20);
    quantitySum+=quantity;
    if (product.type==='RETAIL'&&product.price_paise<=0) throw new PlatformError(`${product.name} needs a confirmed price`,409);
    if (!product.available) throw new PlatformError(`${product.name} is sold out`,409);
    if (product.track_stock) {
      const recipe=product.type==='PREPARED'?await env.DB.prepare('SELECT 1 FROM cafe_recipes WHERE product_id=?1 LIMIT 1').bind(product.id).first():null;
      if (!recipe && product.stock_quantity<quantity) throw new PlatformError(`${product.name} is sold out`,409);
    }
    const priced=priceProduct(product,submitted.options,groups);
    const itemNote=text(submitted.note,'item note',300,false);
    lines.push({product,quantity,note:itemNote,...priced,total_paise:priced.unit_price_paise*quantity});
  }
  if (quantitySum>100) throw new PlatformError('Order is too large');
  const originallyRetailOnly=lines.every(line=>line.product.type==='RETAIL');
  const resolvedSource=source==='QR'?'QR':body.source&&['TABLET','COUNTER','RETAIL'].includes(body.source)?body.source:originallyRetailOnly?'RETAIL':serviceType==='COUNTER'?'COUNTER':'TABLET';
  const promo=await activePromotion(env,lines);
  if (promo?.free) lines.push({product:promo.free,quantity:1,note:'',unit_price_paise:0,options:{},total_paise:0,is_complimentary:true});
  // QR retail orders still need a staff handoff; POS retail sales finish at the counter.
  const routeToKitchen=line=>!!line.product.kitchen_route||(source==='QR'&&line.product.type==='RETAIL');
  const noKitchenItems=lines.every(line=>!routeToKitchen(line));
  const subtotal=lines.reduce((sum,line)=>sum+line.total_paise,0);
  const authorizedDiscount=source==='QR'?0:integer(body.discount_paise??0,'discount_paise',0,subtotal);
  if (authorizedDiscount>0) requirePermission(user,'discounts');
  const discount=Math.min(subtotal,authorizedDiscount+(promo?.discount_paise||0));
  const total=subtotal-discount;
  let remainingDiscount=discount;
  const lastDiscountable=lines.findLastIndex(line=>line.total_paise>0);
  lines.forEach((line,index)=>{
    const share=index===lastDiscountable?remainingDiscount:
      Math.min(remainingDiscount,line.total_paise,subtotal?Math.round(discount*line.total_paise/subtotal):0);
    remainingDiscount-=share;
    line.tax_paise=lineTax(line,line.total_paise-share);
  });
  const tax=lines.reduce((sum,line)=>sum+line.tax_paise,0);
  if (total>2_000_000) throw new PlatformError('Order is too large');
  const payments=[];
  if (source!=='QR'&&body.payments!==undefined) {
    if (!Array.isArray(body.payments)||body.payments.length>4) throw new PlatformError('Invalid payments');
    for (const payment of body.payments) {
      const method=text(payment?.method,'payment method',10);
      if (!enabledMethods.includes(method)) throw new PlatformError('Payment method is unavailable');
      payments.push({method,amount_paise:integer(payment.amount_paise,'payment amount',1,2_000_000),reference:text(payment.reference,'payment reference',100,false)});
    }
  }
  if (payments.reduce((sum,p)=>sum+p.amount_paise,0)>total) throw new PlatformError('Payments exceed the final order total');
  if (source==='QR') await rateLimitOrder(request,env);
  const id=crypto.randomUUID(),trackingToken=randomHex(24);
  const orderNumber=`CF-${dateKey()}-${id.replaceAll('-','').slice(0,10).toUpperCase()}`;
  const status=noKitchenItems?'COMPLETED':'RECEIVED';
  const allocations=new Map(),reserved=new Map();
  for (const [lineIndex,line] of lines.entries()) {
    if (line.product.type!=='RETAIL'||!line.product.track_stock) continue;
    const batches=(await env.DB.prepare(`SELECT id,quantity,expiry_date FROM cafe_stock_batches WHERE product_id=?1
      ORDER BY COALESCE(expiry_date,'9999-12-31'),created_at,id`).bind(line.product.id).all()).results||[];
    if (!batches.length) continue;
    const today=dateKey().replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
    let remaining=line.quantity;
    for (const batch of batches) {
      if (batch.expiry_date&&batch.expiry_date<today) continue;
      const usable=Math.max(0,Number(batch.quantity)-(reserved.get(batch.id)||0));
      const take=Math.min(remaining,usable);
      if (take>0) {
        (allocations.get(lineIndex)||allocations.set(lineIndex,[]).get(lineIndex)).push({batch_id:batch.id,quantity:take});
        reserved.set(batch.id,(reserved.get(batch.id)||0)+take);
        remaining-=take;
      }
      if (!remaining) break;
    }
    if (remaining) throw new PlatformError(`${line.product.name} has no unexpired stock available`,409);
  }
  const statements=[env.DB.prepare(`INSERT INTO cafe_orders
    (id,request_id,tracking_token,order_number,customer_name,service_type,table_number,note,status,total_paise,
      source,order_context,request_hash,payment_status,payment_preference,subtotal_paise,discount_paise,tax_paise,created_by,promotion_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'UNPAID',?14,?15,?16,?17,?18,?19)`)
    .bind(id,idempotency,trackingToken,orderNumber,customerName,serviceType==='COUNTER'?'TAKEAWAY':serviceType,
      serviceType==='DINE_IN'?tableNumber:null,note,status,total,resolvedSource,serviceType==='COUNTER'?'COUNTER':'STANDARD',
      intentHash,paymentPreference,subtotal,discount,tax,user?.username||null,promo?.promo.id||null)];
  lines.forEach((line,index)=>{
    statements.push(env.DB.prepare(`INSERT INTO cafe_order_items
    (order_id,line_no,item_id,name,category,quantity,unit_price_paise,total_paise,options_json,product_type,kitchen_route,note,is_complimentary,tax_paise)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`)
    .bind(id,index+1,line.product.id,line.product.name,line.product.category_id,line.quantity,line.unit_price_paise,
      line.total_paise,JSON.stringify(line.options),line.product.type,routeToKitchen(line)?1:0,
      line.note,line.is_complimentary?1:0,line.tax_paise));
    for (const allocation of allocations.get(index)||[]) statements.push(env.DB.prepare(`INSERT INTO cafe_stock_allocations
      (order_id,line_no,batch_id,quantity) VALUES(?1,?2,?3,?4)`)
      .bind(id,index+1,allocation.batch_id,allocation.quantity));
  });
  if (promo) statements.push(env.DB.prepare(`INSERT INTO cafe_promotion_redemptions(id,promotion_id,order_id,discount_paise)
    VALUES(?1,?2,?3,?4)`).bind(crypto.randomUUID(),promo.promo.id,id,promo.discount_paise));
  for (const payment of payments) statements.push(env.DB.prepare(`INSERT INTO cafe_payments(id,order_id,method,amount_paise,reference,recorded_by)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(),id,payment.method,payment.amount_paise,payment.reference,user.username));
  try { await env.DB.batch(statements); }
  catch (error) {
    const existing=await env.DB.prepare('SELECT * FROM cafe_orders WHERE request_id=?1').bind(idempotency).first();
    if (existing) {
      if (existing.request_hash&&existing.request_hash!==intentHash) throw new PlatformError('This request ID was already used for a different order',409);
      return json(publicOrder(existing,request));
    }
    if (/insufficient stock|recipe is not configured/i.test(String(error))) throw new PlatformError('One item is out of stock. Please review the cart.',409);
    if (/promotion no longer available/i.test(String(error))) throw new PlatformError('The offer just became unavailable. Please try again.',409);
    throw error;
  }
  const saved=await env.DB.prepare('SELECT * FROM cafe_orders WHERE id=?1').bind(id).first();
  return json(publicOrder(saved,request),201);
}

function formatItem(row,includePrep=false) {
  const result={item_id:row.item_id,name:row.name,category:row.category,quantity:row.quantity,
    unit_price_paise:row.unit_price_paise,total_paise:row.total_paise,
    options:parseDbJson(row.options_json,{}),type:row.product_type||'PREPARED',kitchen_route:!!row.kitchen_route,
    note:row.note||'',is_complimentary:!!row.is_complimentary,tax_paise:row.tax_paise||0};
  if (includePrep) {
    const current=parseDbJson(row.prep_steps_json,[]);
    result.prep_steps=current.length?current:prep.items[row.item_id]||[];
  }
  return result;
}

export async function trackOrder(token,env) {
  const row=await env.DB.prepare(`SELECT id,order_number,customer_name,service_type,order_context,table_number,status,accepted_at,
    total_paise,payment_status,payment_preference,source,created_at,updated_at FROM cafe_orders WHERE tracking_token=?1`).bind(token).first();
  if (!row) throw new PlatformError('Order not found',404);
  const items=(await env.DB.prepare('SELECT * FROM cafe_order_items WHERE order_id=?1 ORDER BY line_no').bind(row.id).all()).results||[];
  row.status=effectiveStatus(row); delete row.accepted_at;
  if (row.order_context==='COUNTER') row.service_type='COUNTER';
  row.created_at=asUtc(row.created_at); row.updated_at=asUtc(row.updated_at);
  return json({order:row,items:items.map(item=>formatItem(item))});
}

export async function listOrders(env,{kitchenOnly=true}={}) {
  const where=kitchenOnly?`WHERE EXISTS(SELECT 1 FROM cafe_order_items i WHERE i.order_id=o.id AND i.kitchen_route=1)`:'';
  const orders=(await env.DB.prepare(`SELECT o.*,
    (SELECT COALESCE(SUM(amount_paise),0) FROM cafe_payments p WHERE p.order_id=o.id)-
    (SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id WHERE p.order_id=o.id) AS paid_paise
    FROM cafe_orders o ${where}
    ORDER BY CASE WHEN o.status IN ('RECEIVED','PREPARING','READY') THEN 0 ELSE 1 END,o.created_at DESC LIMIT 200`).all()).results||[];
  if (!orders.length) return json({orders:[]});
  const placeholders=orders.map(()=>'?').join(',');
  const itemWhere=kitchenOnly?"AND i.kitchen_route=1":'';
  const rows=(await env.DB.prepare(`SELECT i.*,p.prep_steps_json FROM cafe_order_items i
    LEFT JOIN cafe_products p ON p.id=i.item_id WHERE i.order_id IN (${placeholders}) ${itemWhere} ORDER BY i.line_no`)
    .bind(...orders.map(order=>order.id)).all()).results||[];
  const itemMap=new Map(orders.map(order=>[order.id,[]]));
  for (const row of rows) itemMap.get(row.order_id)?.push(formatItem(row,kitchenOnly));
  const prepTimes=(await env.DB.prepare(`SELECT i.order_id,MAX(COALESCE(p.prep_minutes,10)) AS expected_prep_minutes
    FROM cafe_order_items i JOIN cafe_products p ON p.id=i.item_id WHERE i.order_id IN (${placeholders})
      AND i.kitchen_route=1 GROUP BY i.order_id`).bind(...orders.map(order=>order.id)).all()).results||[];
  const prepMap=new Map(prepTimes.map(row=>[row.order_id,row.expected_prep_minutes]));
  for (const order of orders) {
    order.status=effectiveStatus(order);
    if (order.order_context==='COUNTER') order.service_type='COUNTER';
    order.created_at=asUtc(order.created_at); order.updated_at=asUtc(order.updated_at);
    order.items=itemMap.get(order.id)||[];
    order.expected_prep_minutes=prepMap.get(order.id)||0;
  }
  return json({orders});
}

export async function setOrderStatus(request,env,user,id) {
  requirePermission(user,'kitchen'); checkOrigin(request);
  const body=await readJson(request,2000),next=text(body.status,'status',20);
  const current=await env.DB.prepare('SELECT status,accepted_at FROM cafe_orders WHERE id=?1').bind(id).first();
  if (!current) throw new PlatformError('Order not found',404);
  const currentStatus=effectiveStatus(current);
  const allowed={RECEIVED:['ACCEPTED','PREPARING','CANCELLED'],ACCEPTED:['PREPARING','CANCELLED'],PREPARING:['READY','CANCELLED'],READY:['COMPLETED'],COMPLETED:[],CANCELLED:[]};
  if (!allowed[currentStatus]?.includes(next)) throw new PlatformError(`Cannot move ${currentStatus.toLowerCase()} to ${next.toLowerCase()}`,409);
  const statement=next==='ACCEPTED'
    ?env.DB.prepare(`UPDATE cafe_orders SET accepted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='RECEIVED' AND accepted_at IS NULL`).bind(id)
    :env.DB.prepare(`UPDATE cafe_orders SET status=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status=?3 AND ${currentStatus==='ACCEPTED'?'accepted_at IS NOT NULL':'(accepted_at IS NULL OR status<>\'RECEIVED\')'}`).bind(next,id,current.status);
  const result=await statement.run();
  if (!result.meta?.changes) throw new PlatformError('Order status changed on another device. Refresh and try again.',409);
  await audit(env,user.username,'STATUS','ORDER',id,{from:currentStatus,to:next});
  return json({id,status:next});
}

export async function orderEvents(request,env,user) {
  requirePermission(user,'kitchen');
  const since=integer(new URL(request.url).searchParams.get('since')??0,'since',0,1_000_000_000);
  let version=0;
  for (let attempt=0;attempt<15;attempt++) {
    const row=await env.DB.prepare('SELECT version FROM cafe_revision WHERE id=1').first();
    version=row?.version||0;
    if (version>since) break;
    if (attempt<14) await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return json({version,changed:version>since});
}

export async function recordPayment(request,env,user,orderId) {
  requirePermission(user,'payments'); checkOrigin(request);
  const body=await readJson(request,3000),method=text(body.method,'method',10);
  if (!(await paymentMethods(env)).includes(method)) throw new PlatformError('Payment method is unavailable');
  const amount=integer(body.amount_paise,'amount_paise',1,2_000_000),reference=text(body.reference,'reference',100,false);
  const order=await env.DB.prepare('SELECT id,total_paise FROM cafe_orders WHERE id=?1').bind(orderId).first();
  if (!order) throw new PlatformError('Order not found',404);
  const id=crypto.randomUUID();
  try { await env.DB.prepare('INSERT INTO cafe_payments(id,order_id,method,amount_paise,reference,recorded_by) VALUES(?1,?2,?3,?4,?5,?6)')
    .bind(id,orderId,method,amount,reference,user.username).run(); }
  catch (error) {
    if (/payment exceeds order total/i.test(String(error))) throw new PlatformError('Payment exceeds the remaining balance',409);
    throw error;
  }
  const payment=await env.DB.prepare('SELECT * FROM cafe_payments WHERE id=?1').bind(id).first();
  const paid=await env.DB.prepare(`SELECT (SELECT COALESCE(SUM(amount_paise),0) FROM cafe_payments WHERE order_id=?1)-
    (SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id WHERE p.order_id=?1) AS value`).bind(orderId).first();
  await audit(env,user.username,'PAYMENT','ORDER',orderId,{id,method,amount_paise:amount});
  return json({payment,payment_status:paid.value>=order.total_paise?'PAID':'PARTIAL',paid_paise:paid.value,total_paise:order.total_paise},201);
}

export async function refundPayment(request,env,user,paymentId) {
  requirePermission(user,'refunds'); checkOrigin(request);
  const body=await readJson(request,3000),reason=text(body.reason,'reason',300);
  const payment=await env.DB.prepare('SELECT * FROM cafe_payments WHERE id=?1').bind(paymentId).first();
  if (!payment) throw new PlatformError('Payment not found',404);
  const refunded=await env.DB.prepare('SELECT COALESCE(SUM(amount_paise),0) AS value FROM cafe_refunds WHERE payment_id=?1').bind(paymentId).first();
  const amount=integer(body.amount_paise,'amount_paise',1,payment.amount_paise-refunded.value);
  const id=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO cafe_refunds(id,payment_id,amount_paise,reason,authorized_by) VALUES(?1,?2,?3,?4,?5)')
      .bind(id,paymentId,amount,reason,user.username),
    env.DB.prepare(`UPDATE cafe_orders SET payment_status='PARTIAL',updated_at=CURRENT_TIMESTAMP WHERE id=?1`).bind(payment.order_id),
  ]);
  const net=await env.DB.prepare(`SELECT (SELECT COALESCE(SUM(amount_paise),0) FROM cafe_payments WHERE order_id=?1)-
    (SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id WHERE p.order_id=?1) AS value`).bind(payment.order_id).first();
  const order=await env.DB.prepare('SELECT total_paise FROM cafe_orders WHERE id=?1').bind(payment.order_id).first();
  const status=net.value>=order.total_paise?'PAID':net.value>0?'PARTIAL':'UNPAID';
  await env.DB.prepare('UPDATE cafe_orders SET payment_status=?1 WHERE id=?2').bind(status,payment.order_id).run();
  await audit(env,user.username,'REFUND','ORDER',payment.order_id,{id,payment_id:paymentId,amount_paise:amount,reason});
  return json({refund:{id,payment_id:paymentId,amount_paise:amount,reason},payment_status:status},201);
}

export async function holdsRoute(request,env,user,id) {
  requirePermission(user,'pos');
  if (request.method==='GET'&&!id) {
    const all=['OWNER','MANAGER'].includes(user.role);
    const query=env.DB.prepare(`SELECT * FROM cafe_order_holds ${all?'':'WHERE staff_username=?1'} ORDER BY created_at DESC LIMIT 100`);
    const rows=(await (all?query.all():query.bind(user.username).all())).results||[];
    return json({holds:(rows||[]).map(row=>({id:row.id,cart:parseDbJson(row.cart_json,[]),customer_name:row.customer_name,
      service_type:row.service_type,table_number:row.table_number,note:row.note,created_at:asUtc(row.created_at)}))});
  }
  checkOrigin(request);
  if (request.method==='POST'&&!id) {
    const body=await readJson(request,60000),cart=parseArray(body.cart,'cart',MAX_LINES);
    const hold={id:crypto.randomUUID(),cart,customer_name:text(body.customer_name,'customer_name',80,false),
      service_type:text(body.service_type||'COUNTER','service_type',20),table_number:text(body.table_number,'table_number',16,false),
      note:text(body.note,'note',300,false)};
    await env.DB.prepare(`INSERT INTO cafe_order_holds(id,staff_username,cart_json,customer_name,service_type,table_number,note)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(hold.id,user.username,JSON.stringify(cart),hold.customer_name,hold.service_type,hold.table_number,hold.note).run();
    await audit(env,user.username,'HOLD','ORDER',hold.id);
    hold.created_at=new Date().toISOString();
    return json({hold},201);
  }
  if (id&&request.method==='DELETE') {
    const result=await env.DB.prepare(`DELETE FROM cafe_order_holds WHERE id=?1 ${['OWNER','MANAGER'].includes(user.role)?'':'AND staff_username=?2'}`)
      .bind(...(['OWNER','MANAGER'].includes(user.role)?[id]:[id,user.username])).run();
    if (!result.meta?.changes) throw new PlatformError('Held order not found',404);
    return json({deleted:true});
  }
  throw new PlatformError('Endpoint not found',404);
}

function receiptOptionText(raw,groups) {
  const selected=parseDbJson(raw,{});
  if (!selected||typeof selected!=='object'||Array.isArray(selected)) return '';
  const readable=value=>String(value??'').replace(/[-_]+/g,' ').trim();
  return Object.entries(selected).flatMap(([id,value])=>{
    if (value===false||value===null||value===undefined||value==='') return [];
    const group=groups.get(id);
    const name=group?.name||readable(id);
    if (value===true) return [name];
    const choiceName=choiceId=>{
      const choice=(group?.choices||[]).find(entry=>(typeof entry==='string'?entry:entry?.id)===choiceId);
      return typeof choice==='string'?choice:(choice?.name||choice?.label||readable(choiceId));
    };
    const choices=Array.isArray(value)?value:[value];
    return choices.length?[`${name}: ${choices.map(choiceName).join(', ')}`]:[];
  }).join(' · ');
}

export async function receipt(request,env,user,orderId) {
  requirePermission(user,'orders');
  const order=await env.DB.prepare('SELECT * FROM cafe_orders WHERE id=?1').bind(orderId).first();
  if (!order) throw new PlatformError('Order not found',404);
  const items=(await env.DB.prepare('SELECT * FROM cafe_order_items WHERE order_id=?1 ORDER BY line_no').bind(orderId).all()).results||[];
  const payments=(await env.DB.prepare('SELECT * FROM cafe_payments WHERE order_id=?1 ORDER BY created_at').bind(orderId).all()).results||[];
  const refunds=(await env.DB.prepare(`SELECT r.* FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id
    WHERE p.order_id=?1 ORDER BY r.created_at`).bind(orderId).all()).results||[];
  const groupRows=(await env.DB.prepare('SELECT id,config_json FROM cafe_option_groups').all()).results||[];
  const optionGroups=new Map(groupRows.map(row=>[row.id,parseDbJson(row.config_json,{})]));
  const settings=(await env.DB.prepare('SELECT key,value FROM cafe_settings').all()).results||[];
  const setting=Object.fromEntries(settings.map(row=>[row.key,row.value]));
  const width=new URL(request.url).searchParams.get('width')==='80'?80:58;
  const money=paise=>`₹${(paise/100).toFixed(2)}`;
  const itemHtml=items.map(item=>{
    const options=receiptOptionText(item.options_json,optionGroups);
    return `<tr><td>${html(item.name)}${item.is_complimentary?' (Complimentary)':''}${options?`<small>${html(options)}</small>`:''}${item.note?`<small>${html(item.note)}</small>`:''}</td><td>${item.quantity}</td><td>${money(item.total_paise)}</td></tr>`;
  }).join('');
  const paymentHtml=payments.map(payment=>`<div>${html(payment.method)} ${money(payment.amount_paise)} ${html(payment.reference)}</div>`).join('');
  const refundsTotal=refunds.reduce((sum,refund)=>sum+refund.amount_paise,0);
  const paidNet=payments.reduce((sum,payment)=>sum+payment.amount_paise,0)-refundsTotal;
  const refundsHtml=refunds.map(refund=>`<div><span>Refund</span><span>−${money(refund.amount_paise)}</span></div>`).join('');
  const document=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${html(order.order_number)}</title><style>@page{size:${width}mm auto;margin:3mm}body{font:12px system-ui,sans-serif;color:#111;max-width:${width-6}mm;margin:0 auto;padding:5mm}h1{text-align:center;font-size:16px;margin:0}h2{text-align:center;font-size:12px;font-weight:500;margin:3px 0 12px}.meta{border-top:1px dashed #555;border-bottom:1px dashed #555;padding:8px 0}.meta div,.totals div{display:flex;justify-content:space-between;gap:5px}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{text-align:left;vertical-align:top;padding:4px 2px}td:last-child,th:last-child{text-align:right}small{display:block;font-size:10px;color:#555;overflow-wrap:anywhere}.totals{border-top:1px dashed #555;padding-top:7px}.total{font-size:15px;font-weight:800}.footer{text-align:center;margin-top:14px}button{display:block;margin:15px auto;padding:10px 20px}@media print{button{display:none}body{padding:0}}</style><body><h1>${html(setting.shop_name||'Amul Ice Cream & Café')}</h1><h2>Receipt</h2><div class="meta"><div><b>${html(order.order_number)}</b><span>${html(order.source||'QR')}</span></div><div><span>${html(asUtc(order.created_at))}</span><span>${html(order.order_context==='COUNTER'?'COUNTER':order.service_type)}</span></div>${order.table_number?`<div>Table ${html(order.table_number)}</div>`:''}</div><table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${itemHtml}</tbody></table><div class="totals"><div><span>Subtotal</span><span>${money(order.subtotal_paise||order.total_paise)}</span></div>${order.discount_paise?`<div><span>Discount</span><span>−${money(order.discount_paise)}</span></div>`:''}<div><span>Tax included</span><span>${money(order.tax_paise||0)}</span></div><div class="total"><span>Total</span><span>${money(order.total_paise)}</span></div><div><span>Payment</span><span>${html(order.payment_status||'UNPAID')}</span></div>${paymentHtml}${refundsHtml}<div><span>Net paid</span><span>${money(paidNet)}</span></div><div><span>Balance</span><span>${money(Math.max(0,order.total_paise-paidNet))}</span></div></div><p class="footer">${html(setting.receipt_footer||'Thank you!')}</p><button id="print-receipt" type="button">Print receipt</button><script src="/receipt.js" defer></script></body></html>`;
  return new Response(document,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'"}});
}

export async function orderDetails(env,user,orderId) {
  requirePermission(user,'orders');
  const order=await env.DB.prepare('SELECT * FROM cafe_orders WHERE id=?1').bind(orderId).first();
  if (!order) throw new PlatformError('Order not found',404);
  order.status=effectiveStatus(order);
  if (order.order_context==='COUNTER') order.service_type='COUNTER';
  const [items,payments,returns]=await Promise.all([
    env.DB.prepare('SELECT * FROM cafe_order_items WHERE order_id=?1 ORDER BY line_no').bind(orderId).all(),
    env.DB.prepare(`SELECT p.*,(SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r WHERE r.payment_id=p.id) AS refunded_paise
      FROM cafe_payments p WHERE p.order_id=?1 ORDER BY p.created_at`).bind(orderId).all(),
    env.DB.prepare('SELECT * FROM cafe_order_returns WHERE order_id=?1 ORDER BY created_at').bind(orderId).all(),
  ]);
  order.items=(items.results||[]).map(row=>({line_no:row.line_no,...formatItem(row)}));
  order.payments=payments.results||[];
  order.returns=returns.results||[];
  order.created_at=asUtc(order.created_at); order.updated_at=asUtc(order.updated_at);
  return json({order});
}

export async function returnItems(request,env,user,orderId) {
  requirePermission(user,'refunds'); checkOrigin(request);
  const body=await readJson(request,10000),reason=text(body.reason,'reason',300);
  const submitted=body.items;
  if (!Array.isArray(submitted)||!submitted.length||submitted.length>MAX_LINES) throw new PlatformError('Choose retail items to return');
  const order=await env.DB.prepare('SELECT id FROM cafe_orders WHERE id=?1').bind(orderId).first();
  if (!order) throw new PlatformError('Order not found',404);
  const statements=[];
  const returned=[];
  const seen=new Set();
  for (const line of submitted) {
    const lineNo=integer(line?.line_no,'line_no',1,MAX_LINES),qty=integer(line?.quantity,'quantity',1,20);
    if (seen.has(lineNo)) throw new PlatformError('Duplicate return line');
    seen.add(lineNo);
    const original=await env.DB.prepare('SELECT * FROM cafe_order_items WHERE order_id=?1 AND line_no=?2').bind(orderId,lineNo).first();
    if (!original||original.product_type!=='RETAIL') throw new PlatformError('Only retail products can be returned here',409);
    const prior=await env.DB.prepare('SELECT COALESCE(SUM(quantity),0) AS quantity FROM cafe_order_returns WHERE order_id=?1 AND line_no=?2').bind(orderId,lineNo).first();
    if (qty+prior.quantity>original.quantity) throw new PlatformError('Return quantity exceeds the sale',409);
    const id=crypto.randomUUID();
    statements.push(env.DB.prepare(`INSERT INTO cafe_order_returns(id,order_id,line_no,quantity,reason,authorized_by)
      VALUES(?1,?2,?3,?4,?5,?6)`).bind(id,orderId,lineNo,qty,reason,user.username));
    const product=await productRow(env,original.item_id);
    if (product?.track_stock) {
      statements.push(env.DB.prepare(`INSERT INTO cafe_inventory_movements
        (id,product_id,order_id,quantity_delta,reason,actor) VALUES(?1,?2,?3,?4,'RETURN',?5)`)
        .bind(crypto.randomUUID(),original.item_id,orderId,qty,user.username));
      const allocations=(await env.DB.prepare(`SELECT batch_id,quantity FROM cafe_stock_allocations
        WHERE order_id=?1 AND line_no=?2 ORDER BY batch_id`).bind(orderId,lineNo).all()).results||[];
      let skip=prior.quantity,remaining=qty;
      for (const allocation of allocations) {
        if (skip>=allocation.quantity) { skip-=allocation.quantity; continue; }
        const take=Math.min(remaining,allocation.quantity-skip);
        skip=0;
        if (take>0) statements.push(env.DB.prepare('UPDATE cafe_stock_batches SET quantity=quantity+?1 WHERE id=?2').bind(take,allocation.batch_id));
        remaining-=take;
        if (!remaining) break;
      }
    }
    returned.push({id,line_no:lineNo,quantity:qty,amount_paise:original.unit_price_paise*qty});
  }
  await env.DB.batch(statements);
  await audit(env,user.username,'RETURN','ORDER',orderId,{reason,items:returned});
  return json({returns:returned,refundable_paise:returned.reduce((sum,line)=>sum+line.amount_paise,0)},201);
}
