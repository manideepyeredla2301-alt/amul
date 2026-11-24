import { PlatformError, audit, checkOrigin, decimal, flag, integer, json, parseArray, parseDbJson, paymentMethods, randomHex, readJson, securityHeaders, slug, text } from './platform-core.js';
import { requirePermission } from './platform-auth.js';

export function itemFromRow(row) {
  return {
    id:row.id,category_id:row.category_id,name:row.name,description:row.description,
    type:row.type,image_url:row.image_url,price:row.price_paise/100,price_paise:row.price_paise,
    mrp_paise:row.mrp_paise,cost_paise:row.cost_paise,tax_rate_bps:row.tax_rate_bps,
    sku:row.sku,barcode:row.barcode,brand:row.brand,pack_size:row.pack_size,
    veg_type:row.veg_type,available:!!row.available&&(!row.track_stock||Number(row.stock_quantity)>0),
    available_setting:!!row.available,
    active:!!row.active,optional:!!row.optional,track_stock:!!row.track_stock,
    stock_quantity:Number(row.stock_quantity),prep_minutes:row.prep_minutes,
    low_stock_threshold:Number(row.low_stock_threshold??5),
    kitchen_route:!!row.kitchen_route,optionGroups:parseDbJson(row.option_groups_json,[]),
    prep_steps:parseDbJson(row.prep_steps_json,[]),
    sort_order:row.sort_order,
  };
}

export async function catalog(env,channel='qr',includeInactive=false) {
  const categories=(await env.DB.prepare(`SELECT * FROM cafe_categories ORDER BY sort_order,id`).all()).results||[];
  const products=(await env.DB.prepare(`SELECT * FROM cafe_products ORDER BY sort_order,id`).all()).results||[];
  const recipeRows=(await env.DB.prepare(`SELECT r.product_id,MIN(CASE WHEN i.stock_quantity>=r.quantity THEN 1 ELSE 0 END) AS usable
    FROM cafe_recipes r JOIN cafe_ingredients i ON i.id=r.ingredient_id GROUP BY r.product_id`).all()).results||[];
  const batchRows=(await env.DB.prepare(`SELECT product_id,COALESCE(SUM(CASE WHEN expiry_date IS NULL OR expiry_date>=date('now','+5 hours','+30 minutes') THEN quantity ELSE 0 END),0) AS usable
    FROM cafe_stock_batches WHERE product_id IS NOT NULL GROUP BY product_id`).all()).results||[];
  const recipeAvailability=new Map(recipeRows.map(row=>[row.product_id,!!row.usable]));
  const batchAvailability=new Map(batchRows.map(row=>[row.product_id,Number(row.usable)>0]));
  const groups=(await env.DB.prepare('SELECT id,config_json FROM cafe_option_groups ORDER BY id').all()).results||[];
  const optionGroups=Object.fromEntries(groups.map(group=>[group.id,parseDbJson(group.config_json,{})]));
  const offer=await env.DB.prepare(`SELECT id,name,type,threshold_paise,free_product_id,eligible_category_ids_json,eligible_product_ids_json FROM cafe_promotions
    WHERE id='ice-cream-free-fries' AND active=1`).first();
  const eligibleCategories=parseDbJson(offer?.eligible_category_ids_json,[]);
  const eligibleProducts=parseDbJson(offer?.eligible_product_ids_json,[]);
  const visibility={qr:'show_qr',pos:'show_pos',retail:'show_retail'}[channel];
  if (!visibility) throw new PlatformError('Invalid catalog channel');
  const output=categories.filter(category=>includeInactive||(category.active&&category[visibility]))
    .map(category=>({
      id:category.id,name:category.name,description:category.description,serving:category.serving,
      image_url:category.image_url,sort_order:category.sort_order,active:!!category.active,
      show_qr:!!category.show_qr,show_pos:!!category.show_pos,show_retail:!!category.show_retail,
      items:products.filter(product=>product.category_id===category.id&&(includeInactive||product.active))
        .map(product=>{
          const full=itemFromRow(product);
          if (product.track_stock) {
            if (product.type==='PREPARED'&&recipeAvailability.has(product.id)) full.available=!!product.available&&recipeAvailability.get(product.id);
            if (product.type==='RETAIL'&&batchAvailability.has(product.id)) full.available=!!product.available&&Number(product.stock_quantity)>0&&batchAvailability.get(product.id);
          }
          const offerEligible=eligibleCategories.includes(product.category_id)||eligibleProducts.includes(product.id);
          if (includeInactive) return {...full,ice_cream_offer_eligible:offerEligible};
          const safe={id:full.id,name:full.name,description:full.description,type:full.type,
            image_url:full.image_url,price:full.price,price_paise:full.price_paise,
            veg_type:full.veg_type,available:full.available,optional:full.optional,
            optionGroups:full.optionGroups,ice_cream_offer_eligible:offerEligible};
          if (channel==='pos') Object.assign(safe,{sku:full.sku,barcode:full.barcode,brand:full.brand,pack_size:full.pack_size});
          return safe;
        }),
    }));
  return {currency:'INR',payment_methods:await paymentMethods(env),categories:output,optionGroups,offers:offer?[{
    id:offer.id,name:offer.name,type:offer.type,threshold_paise:offer.threshold_paise,
    complimentary_product_id:offer.free_product_id,
    eligible_category_ids:eligibleCategories,eligible_product_ids:eligibleProducts,
  }]:[]};
}

export async function productRow(env,id) {
  return env.DB.prepare('SELECT * FROM cafe_products WHERE id=?1').bind(id).first();
}

function choiceId(choice) { return typeof choice==='string'?choice:choice?.id; }

export function priceProduct(product,submitted,groups) {
  const allowed=parseDbJson(product.option_groups_json,[]);
  const options=submitted??{};
  if (!options||typeof options!=='object'||Array.isArray(options)) throw new PlatformError('Invalid item options');
  for (const id of Object.keys(options)) if (!allowed.includes(id)) throw new PlatformError('Unsupported item option');
  const normalized={};
  let price=product.price_paise;
  for (const id of allowed) {
    const group=groups[id];
    if (!group) throw new PlatformError('Product option is unavailable',409);
    const value=options[id];
    if (group.type==='checkbox') {
      if (value!==undefined&&typeof value!=='boolean') throw new PlatformError(`${group.name} must be yes or no`);
      if (value) { normalized[id]=true; price+=integer(group.priceDelta??0,'option price',0,100000)*100; }
    } else if (group.type==='single') {
      if (value===undefined||value==='') {
        if (group.required) throw new PlatformError(`${group.name} is required`);
        continue;
      }
      const choice=(group.choices||[]).find(entry=>choiceId(entry)===value);
      if (!choice) throw new PlatformError(`Invalid ${group.name.toLowerCase()} choice`);
      normalized[id]=value;
      price+=integer(choice.priceDelta??0,'option price',0,100000)*100;
    } else if (group.type==='multi') {
      if (value===undefined) continue;
      if (!Array.isArray(value)||value.length>20) throw new PlatformError(`Invalid ${group.name.toLowerCase()} choices`);
      const ids=new Set((group.choices||[]).map(choiceId));
      for (const selected of value) if (typeof selected!=='string'||!ids.has(selected)) throw new PlatformError(`Invalid ${group.name.toLowerCase()} choice`);
      if (id!=='sundae-flavors'&&new Set(value).size!==value.length) throw new PlatformError(`Duplicate ${group.name.toLowerCase()} choice`);
      if (group.minChoices!==undefined&&value.length<group.minChoices) throw new PlatformError(`Choose more ${group.name.toLowerCase()}`);
      if (group.maxChoices!==undefined&&value.length>group.maxChoices) throw new PlatformError(`Choose fewer ${group.name.toLowerCase()}`);
      normalized[id]=value;
      for (const selected of value) {
        const choice=(group.choices||[]).find(entry=>typeof entry==='object'&&entry.id===selected);
        if (choice) price+=integer(choice.priceDelta??0,'option price',0,100000)*100;
      }
    } else throw new PlatformError('Invalid product option configuration',500);
  }
  if (product.id==='build-your-own-sundae') {
    const count={single:1,double:2,triple:3}[normalized['sundae-size']];
    const flavours=normalized['sundae-flavors']||[];
    const sauces=normalized['sundae-sauce']||[];
    const toppings=normalized['sundae-topping']||[];
    const extras=normalized['sundae-extras']||[];
    if (!count||flavours.length!==count) throw new PlatformError('Choose one flavour for each scoop');
    if (sauces.length<1||sauces.length>2) throw new PlatformError('Choose one sauce, with an optional extra');
    if (toppings.length<1||toppings.length>2) throw new PlatformError('Choose one topping, with an optional extra');
    if ((sauces.length===2)!==extras.includes('additional-sauce')) throw new PlatformError('Extra sauce selection does not match');
    if ((toppings.length===2)!==extras.includes('additional-topping')) throw new PlatformError('Extra topping selection does not match');
    if (normalized['sundae-serving']==='waffle-cone' &&
        (count!==1||sauces.length!==1||toppings.length!==1||toppings[0]==='Jelly'||extras.includes('whipped-cream'))) {
      throw new PlatformError('Waffle cones allow one scoop, one sauce and one dry topping, without whipped cream');
    }
  }
  if (!Number.isSafeInteger(price)||price<0||price>2_000_000) throw new PlatformError('Invalid item price');
  return {unit_price_paise:price,options:normalized};
}

function imageUrl(value) {
  const result=text(value,'image_url',300,false);
  if (result&&!/^\/(?:images\/(?:products\/)?[a-z0-9._-]+|api\/cafe\/images\/[a-f0-9]{32})$/i.test(result)) throw new PlatformError('Image must be an uploaded or built-in café image');
  return result;
}

function categoryFields(body) {
  const fields={};
  for (const [key,max] of [['name',100],['description',500],['serving',40]]) if (Object.hasOwn(body,key)) fields[key]=text(body[key],key,max,key==='name');
  if (Object.hasOwn(body,'image_url')) fields.image_url=imageUrl(body.image_url);
  if (Object.hasOwn(body,'sort_order')) fields.sort_order=integer(body.sort_order,'sort_order',0,100000);
  for (const key of ['active','show_qr','show_pos','show_retail']) if (Object.hasOwn(body,key)) fields[key]=flag(body[key],key);
  return fields;
}

function productFields(body) {
  const fields={};
  for (const [key,max] of [['name',120],['description',500],['category_id',80],['brand',80],['pack_size',60]])
    if (Object.hasOwn(body,key)) fields[key]=text(body[key],key,max,['name','category_id'].includes(key));
  if (Object.hasOwn(body,'type')) {
    fields.type=text(body.type,'type',20);
    if (!['PREPARED','RETAIL'].includes(fields.type)) throw new PlatformError('Invalid product type');
  }
  if (Object.hasOwn(body,'image_url')) fields.image_url=imageUrl(body.image_url);
  for (const key of ['price_paise','mrp_paise','cost_paise']) if (Object.hasOwn(body,key)) fields[key]=integer(body[key],key,0,2_000_000,key==='price_paise');
  if (Object.hasOwn(body,'tax_rate_bps')) fields.tax_rate_bps=integer(body.tax_rate_bps,'tax_rate_bps',0,10000);
  for (const key of ['sku','barcode']) if (Object.hasOwn(body,key)) fields[key]=text(body[key],key,80,false)||null;
  if (Object.hasOwn(body,'veg_type')) {
    fields.veg_type=text(body.veg_type,'veg_type',20);
    if (!['VEG','NON_VEG','EGG'].includes(fields.veg_type)) throw new PlatformError('Invalid veg_type');
  }
  for (const key of ['available','active','optional','track_stock','kitchen_route']) if (Object.hasOwn(body,key)) fields[key]=flag(body[key],key);
  if (Object.hasOwn(body,'stock_quantity')) fields.stock_quantity=decimal(body.stock_quantity,'stock_quantity');
  if (Object.hasOwn(body,'low_stock_threshold')) fields.low_stock_threshold=decimal(body.low_stock_threshold,'low_stock_threshold');
  if (Object.hasOwn(body,'prep_minutes')) fields.prep_minutes=integer(body.prep_minutes,'prep_minutes',0,240);
  if (Object.hasOwn(body,'sort_order')) fields.sort_order=integer(body.sort_order,'sort_order',0,100000);
  if (Object.hasOwn(body,'optionGroups')) {
    const ids=parseArray(body.optionGroups,'optionGroups',20);
    if (ids.some(id=>typeof id!=='string'||!/^[a-z0-9-]{2,80}$/.test(id))||new Set(ids).size!==ids.length) throw new PlatformError('Invalid option groups');
    fields.option_groups_json=JSON.stringify(ids);
  }
  if (Object.hasOwn(body,'prep_steps')) {
    const steps=parseArray(body.prep_steps,'prep_steps',12);
    if (steps.some(step=>typeof step!=='string'||!step.trim()||step.length>300)) throw new PlatformError('Invalid preparation steps');
    fields.prep_steps_json=JSON.stringify(steps.map(step=>step.trim()));
  }
  return fields;
}

async function validateProductRefs(env,fields) {
  if (fields.category_id && !await env.DB.prepare('SELECT id FROM cafe_categories WHERE id=?1').bind(fields.category_id).first()) throw new PlatformError('Category not found',404);
  if (fields.option_groups_json) {
    for (const id of JSON.parse(fields.option_groups_json)) if (!await env.DB.prepare('SELECT id FROM cafe_option_groups WHERE id=?1').bind(id).first()) throw new PlatformError(`Option group ${id} not found`,404);
  }
}

function idFromName(name) {
  return `${name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,55)}-${randomHex(3)}`;
}

export async function categoriesRoute(request,env,user,segments) {
  const method=request.method,id=segments[0];
  if (method==='GET'&&!id) {
    requirePermission(user,'catalog');
    return json({categories:(await catalog(env,'pos',true)).categories.map(({items,...category})=>category)});
  }
  requirePermission(user,'catalog'); checkOrigin(request);
  if (method==='POST'&&!id) {
    const body=await readJson(request);
    const fields=categoryFields(body),categoryId=body.id?slug(body.id):idFromName(fields.name||'category');
    if (!fields.name) throw new PlatformError('name is required');
    const row={description:'',serving:'',image_url:'',sort_order:100,active:1,show_qr:1,show_pos:1,show_retail:0,...fields};
    await env.DB.prepare(`INSERT INTO cafe_categories(id,name,description,serving,image_url,sort_order,active,show_qr,show_pos,show_retail)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`).bind(categoryId,row.name,row.description,row.serving,row.image_url,row.sort_order,row.active,row.show_qr,row.show_pos,row.show_retail).run();
    await audit(env,user.username,'CREATE','CATEGORY',categoryId,row);
    return json({category:{id:categoryId,...row}},201);
  }
  if (id&&method==='PATCH') {
    const current=await env.DB.prepare('SELECT * FROM cafe_categories WHERE id=?1').bind(id).first();
    if (!current) throw new PlatformError('Category not found',404);
    const fields=categoryFields(await readJson(request));
    if (!Object.keys(fields).length) throw new PlatformError('No category changes');
    await env.DB.prepare(`UPDATE cafe_categories SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(fields),id).run();
    await audit(env,user.username,'UPDATE','CATEGORY',id,fields);
    return json({category:{...current,...fields}});
  }
  if (id&&method==='DELETE') {
    const used=await env.DB.prepare('SELECT COUNT(*) AS count FROM cafe_products WHERE category_id=?1').bind(id).first();
    if (used?.count) throw new PlatformError('Archive or move this category’s products first',409);
    const result=await env.DB.prepare('DELETE FROM cafe_categories WHERE id=?1').bind(id).run();
    if (!result.meta?.changes) throw new PlatformError('Category not found',404);
    await audit(env,user.username,'DELETE','CATEGORY',id);
    return json({deleted:true});
  }
  throw new PlatformError('Endpoint not found',404);
}

export async function productsRoute(request,env,user,segments) {
  const method=request.method,id=segments[0];
  if (method==='GET'&&!id) {
    requirePermission(user,'catalog');
    const data=await catalog(env,'pos',true);
    return json({products:data.categories.flatMap(category=>category.items)});
  }
  if (method==='POST'&&!id) {
    requirePermission(user,'catalog'); checkOrigin(request);
    const body=await readJson(request),fields=productFields(body),id=body.id?slug(body.id):idFromName(fields.name||'product');
    for (const key of ['name','category_id','type','price_paise']) if (fields[key]===undefined) throw new PlatformError(`${key} is required`);
    await validateProductRefs(env,fields);
    if (fields.tax_rate_bps===undefined) {
      const setting=await env.DB.prepare("SELECT value FROM cafe_settings WHERE key='default_tax_rate_bps'").first();
      fields.tax_rate_bps=parseDbJson(setting?.value,0);
    }
    const row={description:'',image_url:'',mrp_paise:null,cost_paise:null,tax_rate_bps:0,sku:null,barcode:null,brand:'',pack_size:'',veg_type:'VEG',available:1,active:1,optional:0,track_stock:0,stock_quantity:0,low_stock_threshold:5,prep_minutes:10,kitchen_route:fields.type==='PREPARED'?1:0,option_groups_json:'[]',prep_steps_json:'[]',sort_order:100,...fields};
    const openingStock=row.stock_quantity;
    const keys=['category_id','name','description','type','image_url','price_paise','mrp_paise','cost_paise','tax_rate_bps','sku','barcode','brand','pack_size','veg_type','available','active','optional','track_stock','stock_quantity','low_stock_threshold','prep_minutes','kitchen_route','option_groups_json','prep_steps_json','sort_order'];
    const insert=env.DB.prepare(`INSERT INTO cafe_products(id,${keys.join(',')}) VALUES(${Array(keys.length+1).fill('?').join(',')})`)
      .bind(id,...keys.map(key=>key==='stock_quantity'?0:row[key]));
    const statements=[insert];
    const batchId=openingStock>0&&row.type==='RETAIL'&&row.track_stock?crypto.randomUUID():null;
    if (batchId) statements.push(env.DB.prepare(`INSERT INTO cafe_stock_batches(id,product_id,batch_number,quantity)
      VALUES(?1,?2,'OPENING',?3)`).bind(batchId,id,openingStock));
    if (openingStock>0) statements.push(env.DB.prepare(`INSERT INTO cafe_inventory_movements(id,product_id,batch_id,quantity_delta,reason,actor)
      VALUES(?1,?2,?3,?4,'OPENING',?5)`).bind(crypto.randomUUID(),id,batchId,openingStock,user.username));
    await env.DB.batch(statements);
    await audit(env,user.username,'CREATE','PRODUCT',id,{name:row.name,price_paise:row.price_paise});
    return json({product:itemFromRow({id,...row})},201);
  }
  if (id&&segments[1]==='duplicate'&&method==='POST') {
    requirePermission(user,'catalog'); checkOrigin(request);
    const original=await productRow(env,id);
    if (!original) throw new PlatformError('Product not found',404);
    const clone={...original,id:`${original.id}-copy-${randomHex(3)}`,name:`${original.name} Copy`,sku:null,barcode:null,stock_quantity:0,active:0,available:0};
    const keys=['id','category_id','name','description','type','image_url','price_paise','mrp_paise','cost_paise','tax_rate_bps','sku','barcode','brand','pack_size','veg_type','available','active','optional','track_stock','stock_quantity','low_stock_threshold','prep_minutes','kitchen_route','option_groups_json','prep_steps_json','sort_order'];
    await env.DB.prepare(`INSERT INTO cafe_products(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...keys.map(key=>clone[key])).run();
    await audit(env,user.username,'DUPLICATE','PRODUCT',clone.id,{source:id});
    return json({product:itemFromRow(clone)},201);
  }
  if (id&&method==='PATCH') {
    checkOrigin(request);
    const current=await productRow(env,id);
    if (!current) throw new PlatformError('Product not found',404);
    const fields=productFields(await readJson(request));
    if (!Object.keys(fields).length) throw new PlatformError('No product changes');
    const onlyAvailability=Object.keys(fields).every(key=>key==='available');
    requirePermission(user,onlyAvailability?'availability':'catalog');
    if (Object.hasOwn(fields,'stock_quantity')) throw new PlatformError('Use an inventory adjustment to change stock');
    await validateProductRefs(env,fields);
    await env.DB.prepare(`UPDATE cafe_products SET ${Object.keys(fields).map(key=>`${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...Object.values(fields),id).run();
    await audit(env,user.username,'UPDATE','PRODUCT',id,fields);
    return json({product:itemFromRow({...current,...fields})});
  }
  if (id&&method==='DELETE') {
    requirePermission(user,'catalog'); checkOrigin(request);
    const result=await env.DB.prepare('UPDATE cafe_products SET active=0,available=0,updated_at=CURRENT_TIMESTAMP WHERE id=?1').bind(id).run();
    if (!result.meta?.changes) throw new PlatformError('Product not found',404);
    await audit(env,user.username,'ARCHIVE','PRODUCT',id);
    return json({archived:true});
  }
  throw new PlatformError('Endpoint not found',404);
}

function optionConfig(body) {
  const name=text(body.name,'name',80),type=text(body.type,'type',20);
  if (!['checkbox','single','multi'].includes(type)) throw new PlatformError('Invalid option type');
  const config={name,type};
  if (type==='checkbox') config.priceDelta=integer(body.priceDelta??0,'priceDelta',0,20000);
  else {
    const choices=parseArray(body.choices,'choices',30);
    if (!choices.length) throw new PlatformError('Choose at least one option');
    for (const choice of choices) {
      if (typeof choice==='string') text(choice,'choice',80);
      else if (choice&&typeof choice==='object') {
        slug(choice.id,'choice id'); text(choice.name,'choice name',80);
        if (choice.priceDelta!==undefined) integer(choice.priceDelta,'choice priceDelta',0,20000);
      } else throw new PlatformError('Invalid choice');
    }
    if (new Set(choices.map(choice=>typeof choice==='string'?choice:choice.id)).size!==choices.length) throw new PlatformError('Duplicate option choice');
    config.choices=choices;
    if (body.required!==undefined) config.required=!!flag(body.required,'required');
    if (body.minChoices!==undefined) config.minChoices=integer(body.minChoices,'minChoices',0,30);
    if (body.maxChoices!==undefined) config.maxChoices=integer(body.maxChoices,'maxChoices',1,30);
  }
  return config;
}

export async function optionGroupsRoute(request,env,user,segments) {
  requirePermission(user,'catalog');
  const id=segments[0];
  if (request.method==='GET'&&!id) {
    const rows=(await env.DB.prepare('SELECT * FROM cafe_option_groups ORDER BY id').all()).results||[];
    return json({optionGroups:Object.fromEntries(rows.map(row=>[row.id,parseDbJson(row.config_json,{})]))});
  }
  checkOrigin(request);
  if (request.method==='POST'&&!id) {
    const body=await readJson(request),groupId=slug(body.id),config=optionConfig(body);
    await env.DB.prepare('INSERT INTO cafe_option_groups(id,config_json) VALUES(?1,?2)').bind(groupId,JSON.stringify(config)).run();
    await audit(env,user.username,'CREATE','OPTION_GROUP',groupId,config);
    return json({id:groupId,...config},201);
  }
  if (id&&request.method==='PATCH') {
    const current=await env.DB.prepare('SELECT config_json FROM cafe_option_groups WHERE id=?1').bind(id).first();
    if (!current) throw new PlatformError('Option group not found',404);
    const config=optionConfig({...parseDbJson(current.config_json,{}),...await readJson(request)});
    await env.DB.prepare('UPDATE cafe_option_groups SET config_json=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2').bind(JSON.stringify(config),id).run();
    await audit(env,user.username,'UPDATE','OPTION_GROUP',id,config);
    return json({id,...config});
  }
  if (id&&request.method==='DELETE') {
    const used=await env.DB.prepare(`SELECT COUNT(*) AS count FROM cafe_products WHERE option_groups_json LIKE ?1`).bind(`%"${id}"%`).first();
    if (used?.count) throw new PlatformError('Remove this option group from products first',409);
    await env.DB.prepare('DELETE FROM cafe_option_groups WHERE id=?1').bind(id).run();
    await audit(env,user.username,'DELETE','OPTION_GROUP',id);
    return json({deleted:true});
  }
  throw new PlatformError('Endpoint not found',404);
}

export async function uploadImage(request,env,user) {
  requirePermission(user,'catalog'); checkOrigin(request);
  if (!env.IMAGES && Number(request.headers.get('Content-Length')||0)>1_100_000) throw new PlatformError('Image must be under 1 MB',413);
  if (!/^multipart\/form-data(?:;|$)/i.test(request.headers.get('Content-Type')||'')) throw new PlatformError('Image form required',415);
  const form=await request.formData(),file=form.get('file');
  if (!(file instanceof File)||file.size<1) throw new PlatformError('Image file required');
  const max=env.IMAGES?5_000_000:1_000_000;
  if (file.size>max) throw new PlatformError(`Image must be under ${env.IMAGES?5:1} MB`,413);
  const bytes=new Uint8Array(await file.arrayBuffer());
  const isJpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const isPng=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71&&bytes[4]===13&&bytes[5]===10;
  const isWebp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  const type=isJpeg?'image/jpeg':isPng?'image/png':isWebp?'image/webp':null;
  if (!type||file.type!==type) throw new PlatformError('Use a JPEG, PNG or WebP image');
  const key=randomHex(16);
  if (env.IMAGES) await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:type}});
  await env.DB.prepare(`INSERT INTO cafe_product_images(id,object_key,content_type,byte_size,blob_data,uploaded_by)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(),key,type,bytes.length,env.IMAGES?null:bytes,user.username).run();
  await audit(env,user.username,'UPLOAD','IMAGE',key,{content_type:type,byte_size:bytes.length});
  const url=`/api/cafe/images/${key}`;
  return json({url,image_url:url,key},201);
}

export async function serveImage(env,key) {
  const row=await env.DB.prepare('SELECT object_key,content_type,blob_data FROM cafe_product_images WHERE object_key=?1').bind(key).first();
  if (!row) throw new PlatformError('Image not found',404);
  let data=row.blob_data?new Uint8Array(row.blob_data):null;
  if (!data&&env.IMAGES) data=(await env.IMAGES.get(key))?.body;
  if (!data) throw new PlatformError('Image storage unavailable',503);
  return new Response(data,{headers:{...securityHeaders,'Cache-Control':'public, max-age=31536000, immutable','Content-Type':row.content_type}});
}

export async function deleteImage(request,env,user,key) {
  requirePermission(user,'catalog'); checkOrigin(request);
  const url=`/api/cafe/images/${key}`;
  const used=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM cafe_products WHERE image_url=?1)+
    (SELECT COUNT(*) FROM cafe_categories WHERE image_url=?1) AS count`).bind(url).first();
  if (used?.count) throw new PlatformError('Replace this image on products and categories first',409);
  const result=await env.DB.prepare('DELETE FROM cafe_product_images WHERE object_key=?1').bind(key).run();
  if (!result.meta?.changes) throw new PlatformError('Image not found',404);
  if (env.IMAGES) await env.IMAGES.delete(key);
  await audit(env,user.username,'DELETE','IMAGE',key);
  return json({deleted:true});
}

function parseCsv(raw) {
  const rows=[];
  let row=[],cell='',quoted=false;
  for (let i=0;i<raw.length;i++) {
    const char=raw[i];
    if (quoted) {
      if (char==='"'&&raw[i+1]==='"') { cell+='"'; i++; }
      else if (char==='"') quoted=false;
      else cell+=char;
    } else if (char==='"') quoted=true;
    else if (char===',') { row.push(cell); cell=''; }
    else if (char==='\n'||char==='\r') {
      if (char==='\r'&&raw[i+1]==='\n') i++;
      row.push(cell); cell='';
      if (row.some(value=>value.trim())) rows.push(row);
      row=[];
    } else cell+=char;
  }
  if (quoted) throw new PlatformError('CSV has an unclosed quoted field');
  row.push(cell);
  if (row.some(value=>value.trim())) rows.push(row);
  if (!rows.length) throw new PlatformError('CSV is empty');
  const headers=rows.shift().map(value=>value.trim().replace(/^\ufeff/,''));
  if (new Set(headers).size!==headers.length) throw new PlatformError('Duplicate CSV header');
  return rows.map((values,index)=>{
    if (values.length!==headers.length) throw new PlatformError(`CSV row ${index+2} has the wrong number of fields`);
    return Object.fromEntries(headers.map((key,i)=>[key,values[i].trim()]));
  });
}

export async function importProducts(request,env,user) {
  requirePermission(user,'catalog'); checkOrigin(request);
  if (Number(request.headers.get('Content-Length')||0)>1_100_000) throw new PlatformError('CSV must be under 1 MB',413);
  let raw;
  if (/^text\/csv(?:;|$)/i.test(request.headers.get('Content-Type')||'')) raw=await request.text();
  else if (/^multipart\/form-data(?:;|$)/i.test(request.headers.get('Content-Type')||'')) {
    const file=(await request.formData()).get('file');
    if (!(file instanceof File)||!file.name.toLowerCase().endsWith('.csv')) throw new PlatformError('CSV file required');
    raw=await file.text();
  } else throw new PlatformError('CSV file required',415);
  if (new TextEncoder().encode(raw).length>1_000_000) throw new PlatformError('CSV must be under 1 MB',413);
  const rows=parseCsv(raw);
  if (!rows.length||rows.length>200) throw new PlatformError('CSV must contain 1–200 products');
  const ids=new Set(),prepared=[];
  for (const [index,input] of rows.entries()) {
    const data={...input};
    for (const key of ['price_paise','mrp_paise','cost_paise','tax_rate_bps','stock_quantity','low_stock_threshold','sort_order'])
      if (data[key]==='') delete data[key];
    if (data.price_paise===undefined && data.price!==undefined && data.price!=='') data.price_paise=Math.round(Number(data.price)*100);
    if (data.optionGroups) data.optionGroups=data.optionGroups.split('|').map(value=>value.trim()).filter(Boolean);
    else delete data.optionGroups;
    for (const key of ['available','active','track_stock','kitchen_route'])
      if (data[key]==='') delete data[key];
      else if (data[key]!==undefined) data[key]=data[key]==='1'||data[key].toLowerCase()==='true';
    const fields=productFields(data);
    for (const key of ['name','category_id','type','price_paise']) if (fields[key]===undefined) throw new PlatformError(`CSV row ${index+2}: ${key} is required`);
    await validateProductRefs(env,fields);
    const id=data.id?slug(data.id):idFromName(fields.name);
    if (ids.has(id)) throw new PlatformError(`CSV row ${index+2}: duplicate product ID`);
    ids.add(id);
    prepared.push({id,...fields});
  }
  if (new URL(request.url).searchParams.get('dry_run')==='true') return json({valid:true,count:prepared.length,products:prepared});
  const statements=[];
  const keys=['category_id','name','description','type','image_url','price_paise','mrp_paise','cost_paise','tax_rate_bps','sku','barcode','brand','pack_size','veg_type','available','active','optional','track_stock','stock_quantity','low_stock_threshold','prep_minutes','kitchen_route','option_groups_json','prep_steps_json','sort_order'];
  for (const product of prepared) {
    const row={description:'',image_url:'',mrp_paise:null,cost_paise:null,tax_rate_bps:0,sku:null,barcode:null,brand:'',pack_size:'',veg_type:'VEG',available:1,active:1,optional:0,track_stock:0,stock_quantity:0,low_stock_threshold:5,prep_minutes:10,kitchen_route:product.type==='PREPARED'?1:0,option_groups_json:'[]',prep_steps_json:'[]',sort_order:100,...product};
    const opening=row.stock_quantity;
    statements.push(env.DB.prepare(`INSERT INTO cafe_products(id,${keys.join(',')}) VALUES(${Array(keys.length+1).fill('?').join(',')})`)
      .bind(row.id,...keys.map(key=>key==='stock_quantity'?0:row[key])));
    const batchId=opening>0&&row.type==='RETAIL'&&row.track_stock?crypto.randomUUID():null;
    if (batchId) statements.push(env.DB.prepare(`INSERT INTO cafe_stock_batches(id,product_id,batch_number,quantity)
      VALUES(?1,?2,'OPENING',?3)`).bind(batchId,row.id,opening));
    if (opening>0) statements.push(env.DB.prepare(`INSERT INTO cafe_inventory_movements(id,product_id,batch_id,quantity_delta,reason,actor)
      VALUES(?1,?2,?3,?4,'OPENING',?5)`).bind(crypto.randomUUID(),row.id,batchId,opening,user.username));
  }
  await env.DB.batch(statements);
  await audit(env,user.username,'IMPORT','PRODUCT','csv',{count:prepared.length,ids:[...ids]});
  return json({created:prepared.length,ids:[...ids]},201);
}
