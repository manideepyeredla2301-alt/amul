import { PlatformError, asUtc, audit, checkOrigin, decimal, flag, integer, json, parseArray, parseDbJson, randomHex, readJson, slug, text } from './platform-core.js';
import { requirePermission, passwordRecord } from './platform-auth.js';
import { catalog, itemFromRow, productRow } from './platform-catalog.js';

function sqliteDate(value,field) {
  if (value===null||value===undefined||value==='') return null;
  const date=text(value,field,30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(`${date}T00:00:00+05:30`))) throw new PlatformError(`Invalid ${field}`);
  return date;
}

export async function inventory(request,env,user) {
  requirePermission(user,'inventory');
  const [data,ingredientRows,movementRows,batchRows]=await Promise.all([
    catalog(env,'pos',true),
    env.DB.prepare('SELECT * FROM cafe_ingredients ORDER BY name').all(),
    env.DB.prepare(`SELECT m.*,COALESCE(p.name,i.name) AS item_name,p.name AS product_name FROM cafe_inventory_movements m
      LEFT JOIN cafe_products p ON p.id=m.product_id LEFT JOIN cafe_ingredients i ON i.id=m.ingredient_id
      ORDER BY m.created_at DESC LIMIT 200`).all(),
    env.DB.prepare('SELECT * FROM cafe_stock_batches ORDER BY expiry_date,created_at LIMIT 300').all(),
  ]);
  const products=data.categories.flatMap(category=>category.items);
  const ingredients=ingredientRows.results||[],movements=movementRows.results||[],batches=batchRows.results||[];
  const valuation_paise=products.reduce((sum,p)=>sum+(p.cost_paise||0)*p.stock_quantity,0)+
    ingredients.reduce((sum,i)=>sum+(i.cost_paise_per_unit||0)*i.stock_quantity,0);
  return json({products,ingredients,movements,batches,valuation_paise});
}

export async function stockAdjustment(request,env,user,id) {
  requirePermission(user,'inventory'); checkOrigin(request);
  const body=await readJson(request,4000);
  const delta=decimal(body.quantity_delta,'quantity_delta',-1_000_000,1_000_000);
  if (!delta) throw new PlatformError('Stock change cannot be zero');
  const reason=text(body.reason,'reason',80);
  if (!['OPENING','PURCHASE','ADJUSTMENT','WASTAGE','RETURN','CORRECTION'].includes(reason)) throw new PlatformError('Invalid stock reason');
  const product=await productRow(env,id);
  const ingredient=product?null:await env.DB.prepare('SELECT * FROM cafe_ingredients WHERE id=?1').bind(id).first();
  if (!product&&!ingredient) throw new PlatformError('Stock item not found',404);
  const current=Number((product||ingredient).stock_quantity);
  if (current+delta<0) throw new PlatformError('Adjustment would make stock negative',409);
  const batchNumber=text(body.batch_number,'batch_number',80,false);
  const manufacture=sqliteDate(body.manufacturing_date,'manufacturing_date');
  const expiry=sqliteDate(body.expiry_date,'expiry_date');
  const cost=body.cost_paise===undefined?null:integer(body.cost_paise,'cost_paise',0,2_000_000);
  const createBatch=delta>0&&(!!batchNumber||product?.type==='RETAIL'&&product.track_stock);
  const batchId=createBatch?crypto.randomUUID():null;
  const statements=[];
  if (batchId) statements.push(env.DB.prepare(`INSERT INTO cafe_stock_batches
    (id,product_id,ingredient_id,batch_number,manufacturing_date,expiry_date,quantity,cost_paise_per_unit)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(batchId,product?id:null,ingredient?id:null,batchNumber||'UNSPECIFIED',manufacture,expiry,delta,cost));
  const movement=(quantity,movementBatchId)=>env.DB.prepare(`INSERT INTO cafe_inventory_movements
    (id,product_id,ingredient_id,batch_id,quantity_delta,reason,unit_cost_paise,actor)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
    .bind(crypto.randomUUID(),product?id:null,ingredient?id:null,movementBatchId,quantity,reason,cost,user.username);
  if (delta<0&&product?.type==='RETAIL'&&product.track_stock) {
    const batches=(await env.DB.prepare(`SELECT id,batch_number,quantity FROM cafe_stock_batches WHERE product_id=?1
      ORDER BY COALESCE(expiry_date,'9999-12-31'),created_at,id`).bind(id).all()).results||[];
    if (batchNumber&&!batches.some(batch=>batch.batch_number===batchNumber)) throw new PlatformError('Stock batch not found',404);
    let remaining=-delta;
    for (const batch of batches) {
      if (batchNumber&&batch.batch_number!==batchNumber) continue;
      const take=Math.min(remaining,Number(batch.quantity));
      if (take>0) { statements.push(movement(-take,batch.id)); remaining-=take; }
      if (!remaining) break;
    }
    if (remaining&&batches.length) throw new PlatformError('Not enough stock in the selected batches',409);
    if (remaining) statements.push(movement(-remaining,null));
  } else statements.push(movement(delta,batchId));
  try { await env.DB.batch(statements); }
  catch (error) {
    if (/insufficient stock/i.test(String(error))) throw new PlatformError('Adjustment would make stock negative',409);
    throw error;
  }
  await audit(env,user.username,'STOCK_ADJUST',product?'PRODUCT':'INGREDIENT',id,{quantity_delta:delta,reason,batch_number:batchNumber});
  const updated=product?await productRow(env,id):await env.DB.prepare('SELECT * FROM cafe_ingredients WHERE id=?1').bind(id).first();
  return json({item:product?itemFromRow(updated):updated,quantity_delta:delta});
}

export async function ingredientsRoute(request,env,user,id) {
  requirePermission(user,'inventory');
  if (request.method==='GET'&&!id) return json({ingredients:(await env.DB.prepare('SELECT * FROM cafe_ingredients ORDER BY name').all()).results||[]});
  checkOrigin(request);
  if (request.method==='POST'&&!id) {
    const body=await readJson(request,4000);
    const ingredientId=body.id?slug(body.id):`${text(body.name,'name',100).toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,55)}-${randomHex(3)}`;
    const name=text(body.name,'name',100),unit=text(body.unit,'unit',10);
    if (!['g','ml','each'].includes(unit)) throw new PlatformError('Invalid ingredient unit');
    const low=decimal(body.low_stock_quantity??0,'low_stock_quantity');
    const cost=body.cost_paise_per_unit===undefined?null:decimal(body.cost_paise_per_unit,'cost_paise_per_unit');
    const opening=decimal(body.stock_quantity??0,'stock_quantity');
    const statements=[env.DB.prepare(`INSERT INTO cafe_ingredients(id,name,unit,stock_quantity,low_stock_quantity,cost_paise_per_unit)
      VALUES(?1,?2,?3,0,?4,?5)`).bind(ingredientId,name,unit,low,cost)];
    if (opening) statements.push(env.DB.prepare(`INSERT INTO cafe_inventory_movements(id,ingredient_id,quantity_delta,reason,actor)
      VALUES(?1,?2,?3,'OPENING',?4)`).bind(crypto.randomUUID(),ingredientId,opening,user.username));
    await env.DB.batch(statements);
    await audit(env,user.username,'CREATE','INGREDIENT',ingredientId,{name,unit,opening});
    return json({ingredient:await env.DB.prepare('SELECT * FROM cafe_ingredients WHERE id=?1').bind(ingredientId).first()},201);
  }
  if (id&&request.method==='PATCH') {
    const body=await readJson(request,4000),fields={};
    if (Object.hasOwn(body,'name')) fields.name=text(body.name,'name',100);
    if (Object.hasOwn(body,'unit')) { fields.unit=text(body.unit,'unit',10); if (!['g','ml','each'].includes(fields.unit)) throw new PlatformError('Invalid unit'); }
    if (Object.hasOwn(body,'low_stock_quantity')) fields.low_stock_quantity=decimal(body.low_stock_quantity,'low_stock_quantity');
    if (Object.hasOwn(body,'cost_paise_per_unit')) fields.cost_paise_per_unit=decimal(body.cost_paise_per_unit,'cost_paise_per_unit');
    if (Object.hasOwn(body,'active')) fields.active=flag(body.active,'active');
    if (!Object.keys(fields).length) throw new PlatformError('No ingredient changes');
    await env.DB.prepare(`UPDATE cafe_ingredients SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(fields),id).run();
    await audit(env,user.username,'UPDATE','INGREDIENT',id,fields);
    return json({ingredient:await env.DB.prepare('SELECT * FROM cafe_ingredients WHERE id=?1').bind(id).first()});
  }
  throw new PlatformError('Endpoint not found',404);
}

export async function recipeRoute(request,env,user,productId) {
  requirePermission(user,'inventory');
  const product=await productRow(env,productId);
  if (!product||product.type!=='PREPARED') throw new PlatformError('Prepared product not found',404);
  if (request.method==='GET') return json({recipe:(await env.DB.prepare(`SELECT r.*,i.name,i.unit FROM cafe_recipes r JOIN cafe_ingredients i ON i.id=r.ingredient_id
    WHERE r.product_id=?1 ORDER BY i.name`).bind(productId).all()).results||[]});
  if (request.method==='PUT') {
    checkOrigin(request);
    const body=await readJson(request,10000),recipe=parseArray(body.recipe,'recipe',30);
    const statements=[env.DB.prepare('DELETE FROM cafe_recipes WHERE product_id=?1').bind(productId)];
    const ids=new Set();
    for (const line of recipe) {
      const id=text(line?.ingredient_id,'ingredient_id',80),quantity=decimal(line?.quantity,'quantity',0.001,100000);
      if (ids.has(id)) throw new PlatformError('Duplicate recipe ingredient');
      ids.add(id);
      if (!await env.DB.prepare('SELECT id FROM cafe_ingredients WHERE id=?1 AND active=1').bind(id).first()) throw new PlatformError(`Ingredient ${id} not found`,404);
      statements.push(env.DB.prepare('INSERT INTO cafe_recipes(product_id,ingredient_id,quantity) VALUES(?1,?2,?3)').bind(productId,id,quantity));
    }
    await env.DB.batch(statements);
    await audit(env,user.username,'UPDATE','RECIPE',productId,{recipe});
    return json({recipe});
  }
  throw new PlatformError('Endpoint not found',404);
}

function kolkataDate(offset=0) {
  const now=new Date(Date.now()+offset*86400000);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const value=type=>parts.find(part=>part.type===type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function reportBounds(url) {
  const range=url.searchParams.get('range')||'today';
  let start,end;
  if (range==='today') start=end=kolkataDate();
  else if (range==='yesterday') start=end=kolkataDate(-1);
  else if (range==='7d') { start=kolkataDate(-6); end=kolkataDate(); }
  else if (range==='month') { start=`${kolkataDate().slice(0,7)}-01`; end=kolkataDate(); }
  else if (range==='custom') { start=sqliteDate(url.searchParams.get('from'),'from'); end=sqliteDate(url.searchParams.get('to'),'to'); }
  else throw new PlatformError('Invalid report range');
  if (!start||!end||start>end) throw new PlatformError('Invalid report dates');
  const from=new Date(`${start}T00:00:00+05:30`);
  const to=new Date(new Date(`${end}T00:00:00+05:30`).getTime()+86400000);
  if (to-from>366*86400000) throw new PlatformError('Report range is too long');
  return {range,start,end,from:from.toISOString().slice(0,19).replace('T',' '),to:to.toISOString().slice(0,19).replace('T',' ')};
}

export async function reports(request,env,user) {
  requirePermission(user,'reports');
  const bounds=reportBounds(new URL(request.url)),args=[bounds.from,bounds.to];
  const [orderStats,paymentStats,refundStats,topProducts,categorySales,payments,lowStock,addOns,
    typeSales,slowMoving,ingredientConsumption,outOfStock]=await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN status<>'CANCELLED' THEN 1 ELSE 0 END),0) AS completed_or_open_orders,
      COALESCE(SUM(CASE WHEN status<>'CANCELLED' THEN total_paise ELSE 0 END),0) AS order_value_paise,
      COALESCE(SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END),0) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN status<>'CANCELLED' THEN MAX(0,total_paise-
        (SELECT COALESCE(SUM(amount_paise),0) FROM cafe_payments p WHERE p.order_id=cafe_orders.id)+
        (SELECT COALESCE(SUM(r.amount_paise),0) FROM cafe_refunds r JOIN cafe_payments p ON p.id=r.payment_id WHERE p.order_id=cafe_orders.id))
        ELSE 0 END),0) AS pending_paise
      FROM cafe_orders WHERE created_at>=?1 AND created_at<?2`).bind(...args).first(),
    env.DB.prepare(`SELECT COALESCE(SUM(amount_paise),0) AS paid_paise FROM cafe_payments WHERE created_at>=?1 AND created_at<?2`).bind(...args).first(),
    env.DB.prepare(`SELECT COALESCE(SUM(amount_paise),0) AS refunds_paise FROM cafe_refunds WHERE created_at>=?1 AND created_at<?2`).bind(...args).first(),
    env.DB.prepare(`SELECT i.item_id,i.name,SUM(i.quantity) AS quantity,SUM(i.total_paise) AS sales_paise
      FROM cafe_order_items i JOIN cafe_orders o ON o.id=i.order_id WHERE o.created_at>=?1 AND o.created_at<?2 AND o.status<>'CANCELLED'
      GROUP BY i.item_id,i.name ORDER BY quantity DESC,sales_paise DESC LIMIT 20`).bind(...args).all(),
    env.DB.prepare(`SELECT i.category AS category_id,COALESCE(c.name,i.category) AS name,SUM(i.quantity) AS quantity,SUM(i.total_paise) AS sales_paise
      FROM cafe_order_items i JOIN cafe_orders o ON o.id=i.order_id LEFT JOIN cafe_categories c ON c.id=i.category
      WHERE o.created_at>=?1 AND o.created_at<?2 AND o.status<>'CANCELLED' GROUP BY i.category ORDER BY sales_paise DESC`).bind(...args).all(),
    env.DB.prepare(`SELECT method,COUNT(*) AS count,SUM(amount_paise) AS amount_paise FROM cafe_payments
      WHERE created_at>=?1 AND created_at<?2 GROUP BY method ORDER BY amount_paise DESC`).bind(...args).all(),
    env.DB.prepare('SELECT id,name,type,stock_quantity,low_stock_threshold FROM cafe_products WHERE active=1 AND track_stock=1 AND stock_quantity<=low_stock_threshold ORDER BY stock_quantity LIMIT 50').all(),
    env.DB.prepare(`SELECT options_json,quantity FROM cafe_order_items i JOIN cafe_orders o ON o.id=i.order_id
      WHERE o.created_at>=?1 AND o.created_at<?2 AND o.status<>'CANCELLED' AND options_json<>'{}'`).bind(...args).all(),
    env.DB.prepare(`SELECT i.product_type,SUM(i.total_paise) AS sales_paise,SUM(i.quantity) AS quantity
      FROM cafe_order_items i JOIN cafe_orders o ON o.id=i.order_id WHERE o.created_at>=?1 AND o.created_at<?2
      AND o.status<>'CANCELLED' AND o.payment_status='PAID' GROUP BY i.product_type`).bind(...args).all(),
    env.DB.prepare(`SELECT p.id,p.name,p.type,COALESCE(SUM(CASE WHEN o.created_at>=?1 AND o.created_at<?2 AND o.status<>'CANCELLED'
      THEN i.quantity ELSE 0 END),0) AS quantity FROM cafe_products p
      LEFT JOIN cafe_order_items i ON i.item_id=p.id LEFT JOIN cafe_orders o ON o.id=i.order_id
      WHERE p.active=1 GROUP BY p.id ORDER BY quantity ASC,p.name LIMIT 50`).bind(...args).all(),
    env.DB.prepare(`SELECT i.id,i.name,i.unit,COALESCE(SUM(-m.quantity_delta),0) AS consumed_quantity
      FROM cafe_ingredients i LEFT JOIN cafe_inventory_movements m ON m.ingredient_id=i.id AND m.reason='RECIPE'
      AND m.created_at>=?1 AND m.created_at<?2 GROUP BY i.id ORDER BY consumed_quantity DESC LIMIT 50`).bind(...args).all(),
    env.DB.prepare(`SELECT id,name,type,stock_quantity FROM cafe_products
      WHERE active=1 AND track_stock=1 AND stock_quantity<=0 ORDER BY name LIMIT 50`).all(),
  ]);
  const totalSales=Math.max(0,paymentStats.paid_paise-refundStats.refunds_paise);
  const typeMap=Object.fromEntries((typeSales.results||[]).map(row=>[row.product_type,row.sales_paise]));
  const summary={total_sales_paise:totalSales,sales_paise:totalSales,total_orders:orderStats.total_orders,
    average_order_paise:orderStats.completed_or_open_orders?Math.round(orderStats.order_value_paise/orderStats.completed_or_open_orders):0,
    pending_paise:orderStats.pending_paise,refunds_paise:refundStats.refunds_paise,
    cancelled_orders:orderStats.cancelled_orders,order_value_paise:orderStats.order_value_paise,
    cafe_sales_paise:typeMap.PREPARED||0,retail_sales_paise:typeMap.RETAIL||0};
  const addons=new Map();
  for (const row of addOns.results||[]) for (const [group,value] of Object.entries(parseDbJson(row.options_json,{}))) {
    const label=`${group}: ${Array.isArray(value)?value.join(', '):value===true?'yes':value}`;
    addons.set(label,(addons.get(label)||0)+row.quantity);
  }
  return json({range:bounds.range,from:bounds.start,to:bounds.end,summary,top_products:topProducts.results||[],
    category_sales:categorySales.results||[],payments:payments.results||[],low_stock:lowStock.results||[],
    slow_moving:slowMoving.results||[],out_of_stock:outOfStock.results||[],
    ingredient_consumption:ingredientConsumption.results||[],
    popular_addons:[...addons].map(([name,quantity])=>({name,quantity})).sort((a,b)=>b.quantity-a.quantity).slice(0,20)});
}

export async function overview(request,env,user) {
  const result=await reports(new Request(new URL('/api/cafe/admin/reports?range=today',request.url),request),env,user);
  const data=await result.json();
  return json(data);
}

function promotionOut(row) {
  return {...row,active:!!row.active,eligible_category_ids:parseDbJson(row.eligible_category_ids_json,[]),
    eligible_product_ids:parseDbJson(row.eligible_product_ids_json,[])};
}

function promotionFields(body) {
  const fields={};
  for (const [key,max] of [['name',120],['description',300],['type',20]])
    if (Object.hasOwn(body,key)) fields[key]=text(body[key],key,max,key!=='description');
  if (fields.type&&!['FREE_ITEM','PERCENT','FIXED'].includes(fields.type)) throw new PlatformError('Invalid promotion type');
  for (const key of ['threshold_paise','minimum_spend_paise','discount_value'])
    if (Object.hasOwn(body,key)) fields[key]=integer(body[key],key,0,key==='discount_value'&&body.type==='PERCENT'?10000:2_000_000);
  if (Object.hasOwn(body,'free_product_id')) fields.free_product_id=text(body.free_product_id,'free_product_id',80,false)||null;
  for (const key of ['eligible_category_ids','eligible_product_ids']) if (Object.hasOwn(body,key)) {
    const ids=parseArray(body[key],key,100);
    if (ids.some(id=>typeof id!=='string'||id.length>80)) throw new PlatformError(`Invalid ${key}`);
    fields[`${key}_json`]=JSON.stringify([...new Set(ids)]);
  }
  for (const key of ['starts_at','ends_at']) if (Object.hasOwn(body,key)) {
    const value=body[key];
    if (value===null||value==='') fields[key]=null;
    else {
      const local=String(value);
      const withZone=/[zZ]|[+-]\d\d:\d\d$/.test(local)?local:/^\d{4}-\d{2}-\d{2}$/.test(local)?`${local}T00:00:00+05:30`:`${local}+05:30`;
      const parsed=Date.parse(withZone);
      if (Number.isNaN(parsed)) throw new PlatformError(`Invalid ${key}`);
      fields[key]=new Date(parsed).toISOString().slice(0,19).replace('T',' ');
    }
  }
  if (Object.hasOwn(body,'usage_limit')) fields.usage_limit=body.usage_limit===null||body.usage_limit===0?null:integer(body.usage_limit,'usage_limit',1,1_000_000);
  if (Object.hasOwn(body,'active')) fields.active=flag(body.active,'active');
  return fields;
}

async function validatePromotion(env,row) {
  if (row.type==='FREE_ITEM'&&!row.free_product_id) throw new PlatformError('Free item is required');
  if (row.free_product_id&&!await productRow(env,row.free_product_id)) throw new PlatformError('Free product not found',404);
  if (row.type==='PERCENT'&&row.discount_value>10000) throw new PlatformError('Percentage cannot exceed 100%');
  if (row.starts_at&&row.ends_at&&row.starts_at>row.ends_at) throw new PlatformError('Offer end must follow its start');
}

export async function promotionsRoute(request,env,user,id) {
  requirePermission(user,'promotions');
  if (request.method==='GET'&&!id) {
    const rows=(await env.DB.prepare('SELECT * FROM cafe_promotions ORDER BY created_at DESC,id').all()).results||[];
    return json({promotions:rows.map(promotionOut)});
  }
  checkOrigin(request);
  if (request.method==='POST'&&!id) {
    const body=await readJson(request,10000),fields=promotionFields(body);
    if (!fields.name||!fields.type) throw new PlatformError('Promotion name and type are required');
    const promoId=body.id?slug(body.id):`offer-${randomHex(5)}`;
    const row={description:'',threshold_paise:0,discount_value:0,free_product_id:null,eligible_category_ids_json:'[]',eligible_product_ids_json:'[]',minimum_spend_paise:0,starts_at:null,ends_at:null,usage_limit:null,active:1,...fields};
    await validatePromotion(env,row);
    const keys=['name','description','type','threshold_paise','discount_value','free_product_id','eligible_category_ids_json','eligible_product_ids_json','minimum_spend_paise','starts_at','ends_at','usage_limit','active'];
    await env.DB.prepare(`INSERT INTO cafe_promotions(id,${keys.join(',')}) VALUES(${Array(keys.length+1).fill('?').join(',')})`)
      .bind(promoId,...keys.map(key=>row[key])).run();
    await audit(env,user.username,'CREATE','PROMOTION',promoId,row);
    return json({promotion:promotionOut({id:promoId,usage_count:0,...row})},201);
  }
  if (id&&request.method==='PATCH') {
    const current=await env.DB.prepare('SELECT * FROM cafe_promotions WHERE id=?1').bind(id).first();
    if (!current) throw new PlatformError('Promotion not found',404);
    const fields=promotionFields(await readJson(request,10000));
    if (!Object.keys(fields).length) throw new PlatformError('No promotion changes');
    await validatePromotion(env,{...current,...fields});
    await env.DB.prepare(`UPDATE cafe_promotions SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(fields),id).run();
    await audit(env,user.username,'UPDATE','PROMOTION',id,fields);
    return json({promotion:promotionOut({...current,...fields})});
  }
  throw new PlatformError('Endpoint not found',404);
}

const settingRules={
  shop_name:value=>text(value,'shop_name',120),
  shop_phone:value=>text(value,'shop_phone',40,false),
  shop_address:value=>text(value,'shop_address',300,false),
  gstin:value=>{const result=text(value,'gstin',15,false);if(result&&!/^[0-9A-Z]{15}$/.test(result))throw new PlatformError('Invalid GSTIN');return result;},
  receipt_footer:value=>text(value,'receipt_footer',200,false),
  default_tax_rate_bps:value=>integer(value,'default_tax_rate_bps',0,5000),
  cash_enabled:value=>!!flag(value,'cash_enabled'),
  upi_enabled:value=>!!flag(value,'upi_enabled'),
  card_enabled:value=>!!flag(value,'card_enabled'),
};

export async function settingsRoute(request,env,user) {
  if (request.method==='GET') {
    requirePermission(user,'reports');
    const rows=(await env.DB.prepare('SELECT key,value FROM cafe_settings').all()).results||[];
    const settings={cash_enabled:true,upi_enabled:true,card_enabled:true,default_tax_rate_bps:0};
    for (const row of rows) settings[row.key]=parseDbJson(row.value,row.value);
    return json({settings});
  }
  if (request.method==='PUT') {
    requirePermission(user,'settings'); checkOrigin(request);
    const body=await readJson(request,10000),entries=Object.entries(body);
    if (!entries.length) throw new PlatformError('No settings changes');
    const statements=[];
    for (const [key,value] of entries) {
      if (!settingRules[key]) throw new PlatformError(`Unsupported setting ${key}`);
      const normalized=settingRules[key](value);
      statements.push(env.DB.prepare(`INSERT INTO cafe_settings(key,value) VALUES(?1,?2)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key,JSON.stringify(normalized)));
    }
    await env.DB.batch(statements);
    await audit(env,user.username,'UPDATE','SETTINGS','main',Object.fromEntries(entries));
    return settingsRoute(new Request(request.url,{method:'GET',headers:request.headers}),env,user);
  }
  throw new PlatformError('Endpoint not found',404);
}

export async function staffRoute(request,env,user,id) {
  requirePermission(user,'staff');
  if (request.method==='GET'&&!id) {
    const rows=(await env.DB.prepare(`SELECT id,username,display_name,role,permissions_json,active,created_at,updated_at
      FROM cafe_staff_users ORDER BY created_at DESC`).all()).results||[];
    return json({staff:[{id:'owner-env',username:env.CAFE_ADMIN_USER||'owner',display_name:'Owner',role:'OWNER',active:true,managed_by_environment:true},
      ...rows.map(row=>({...row,permissions:parseDbJson(row.permissions_json,[]),active:!!row.active}))]});
  }
  checkOrigin(request);
  if (request.method==='POST'&&!id) {
    const body=await readJson(request,5000),username=text(body.username,'username',80),role=text(body.role,'role',20);
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username)) throw new PlatformError('Invalid username');
    if (!['MANAGER','CASHIER','KITCHEN'].includes(role)) throw new PlatformError('Invalid staff role');
    if (username.toLowerCase()===String(env.CAFE_ADMIN_USER||'').toLowerCase()) throw new PlatformError('Username is reserved for the owner');
    const password=await passwordRecord(body.password),id=crypto.randomUUID();
    const display=text(body.display_name||username,'display_name',100),active=body.active===undefined?1:flag(body.active,'active');
    const permissions=parseArray(body.permissions||[],'permissions',30);
    if (permissions.some(p=>typeof p!=='string'||p.length>40)) throw new PlatformError('Invalid permissions');
    await env.DB.prepare(`INSERT INTO cafe_staff_users(id,username,display_name,role,password_salt,password_hash,password_iterations,permissions_json,active)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
      .bind(id,username,display,role,password.password_salt,password.password_hash,password.password_iterations,JSON.stringify(permissions),active).run();
    await audit(env,user.username,'CREATE','STAFF',id,{username,role});
    return json({staff:{id,username,display_name:display,role,permissions,active:!!active}},201);
  }
  if (id&&request.method==='PATCH') {
    if (id==='owner-env') throw new PlatformError('Owner credentials are managed in Cloudflare',403);
    const body=await readJson(request,5000),fields={};
    if (Object.hasOwn(body,'username')) {
      fields.username=text(body.username,'username',80);
      if (!/^[a-zA-Z0-9._-]{3,80}$/.test(fields.username)) throw new PlatformError('Invalid username');
    }
    if (Object.hasOwn(body,'display_name')) fields.display_name=text(body.display_name,'display_name',100);
    if (Object.hasOwn(body,'role')) { fields.role=text(body.role,'role',20);if (!['MANAGER','CASHIER','KITCHEN'].includes(fields.role)) throw new PlatformError('Invalid role'); }
    if (Object.hasOwn(body,'active')) fields.active=flag(body.active,'active');
    if (Object.hasOwn(body,'permissions')) {
      const permissions=parseArray(body.permissions,'permissions',30);
      if (permissions.some(p=>typeof p!=='string'||p.length>40)) throw new PlatformError('Invalid permissions');
      fields.permissions_json=JSON.stringify(permissions);
    }
    if (body.password) Object.assign(fields,await passwordRecord(body.password));
    if (!Object.keys(fields).length) throw new PlatformError('No staff changes');
    const result=await env.DB.prepare(`UPDATE cafe_staff_users SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(fields),id).run();
    if (!result.meta?.changes) throw new PlatformError('Staff user not found',404);
    if (fields.password_hash||fields.active===0||fields.role) await env.DB.prepare('DELETE FROM cafe_staff_sessions WHERE user_id=?1').bind(id).run();
    await audit(env,user.username,'UPDATE','STAFF',id,{...fields,password_hash:fields.password_hash?'[changed]':undefined,password_salt:undefined});
    return json({staff:{id,...fields,password_hash:undefined,password_salt:undefined}});
  }
  throw new PlatformError('Endpoint not found',404);
}

function qrOut(row,request) {
  const url=new URL('/',request.url); url.searchParams.set('qr',row.id);
  return {...row,active:!!row.active,url:url.toString()};
}

export async function publicQr(env,id) {
  const row=await env.DB.prepare('SELECT id,label,context,table_number,active FROM cafe_qr_codes WHERE id=?1').bind(id).first();
  if (!row||!row.active) throw new PlatformError('QR code is unavailable',410);
  return json({...row,active:true,service_type:row.context==='TABLE'?'DINE_IN':row.context==='GENERAL'?'DINE_IN':row.context==='COUNTER'?'COUNTER':'TAKEAWAY'});
}

export async function qrRoute(request,env,user,id) {
  requirePermission(user,'qr');
  if (request.method==='GET'&&!id) return json({codes:((await env.DB.prepare('SELECT * FROM cafe_qr_codes ORDER BY context,table_number,id').all()).results||[]).map(row=>qrOut(row,request))});
  checkOrigin(request);
  if (request.method==='POST'&&!id) {
    const body=await readJson(request,4000),context=text(body.context,'context',20);
    if (!['GENERAL','TABLE','TAKEAWAY','COUNTER'].includes(context)) throw new PlatformError('Invalid QR context');
    const qrId=body.id?slug(body.id):`qr-${randomHex(5)}`;
    const label=text(body.label,'label',100),table=context==='TABLE'?text(body.table_number,'table_number',16):null;
    const active=body.active===undefined?1:flag(body.active,'active');
    await env.DB.prepare('INSERT INTO cafe_qr_codes(id,label,context,table_number,active) VALUES(?1,?2,?3,?4,?5)')
      .bind(qrId,label,context,table,active).run();
    await audit(env,user.username,'CREATE','QR',qrId,{label,context,table_number:table});
    return json({code:qrOut({id:qrId,label,context,table_number:table,active},request)},201);
  }
  if (id&&request.method==='PATCH') {
    const current=await env.DB.prepare('SELECT * FROM cafe_qr_codes WHERE id=?1').bind(id).first();
    if (!current) throw new PlatformError('QR code not found',404);
    const body=await readJson(request,4000),fields={};
    if (Object.hasOwn(body,'label')) fields.label=text(body.label,'label',100);
    if (Object.hasOwn(body,'context')) { fields.context=text(body.context,'context',20);if(!['GENERAL','TABLE','TAKEAWAY','COUNTER'].includes(fields.context))throw new PlatformError('Invalid QR context'); }
    if (Object.hasOwn(body,'table_number')) fields.table_number=text(body.table_number,'table_number',16,false)||null;
    if (Object.hasOwn(body,'active')) fields.active=flag(body.active,'active');
    if ((fields.context||current.context)==='TABLE'&&!(fields.table_number??current.table_number)) throw new PlatformError('Table number is required');
    if ((fields.context||current.context)!=='TABLE') fields.table_number=null;
    if (!Object.keys(fields).length) throw new PlatformError('No QR changes');
    await env.DB.prepare(`UPDATE cafe_qr_codes SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(fields),id).run();
    await audit(env,user.username,'UPDATE','QR',id,fields);
    return json({code:qrOut({...current,...fields},request)});
  }
  throw new PlatformError('Endpoint not found',404);
}
