const {AppError}=require('../domain');
const {inTransaction}=require('../db');
function scaled(value) {
 const s=String(value);if(!/^\d+(?:\.\d{1,6})?$/.test(s))throw new AppError('Quantity and price must be positive numbers with at most six decimals.');
 const [a,b='']=s.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));
}
function linePaise(q,p){const n=Number((scaled(q)*scaled(p)+5000000000n)/10000000000n);if(!Number.isSafeInteger(n))throw new AppError('Amount too large.');return n;}
function amulUnitLabels(name, units){
 const extras=units.filter(u=>u.code!=='BASE').sort((a,b)=>a.factor-b.factor);
 const match=String(name||'').match(/\((\d+)\s*[xX×]\s*(\d+)\)/);
 const labels=new Map([['BASE','PC']]);
 // Amul's source UOM codes commonly use CRT/CAR, but the physical
 // stock counted in this business is a box. Keep the source code and
 // conversion factor unchanged; only present business-friendly labels.
 if(extras.length===1) labels.set(extras[0].code,'BOX');
 else extras.forEach((u,i)=>labels.set(u.code,i===0?'BOX':i===1?'BOX 2':'PACK '+(i+1)));
 return units.map(u=>({...u,label:labels.get(u.code)||u.label}));
}
class ProductUnits {
 constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS product_unit_settings(source TEXT NOT NULL,product_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source,product_id))');}
 list(source,id){
  if(!['LOCAL','AMUL'].includes(source))throw new AppError('Invalid product source.');
  const p=this.db.prepare(source==='LOCAL'?'SELECT unit FROM products WHERE id=?':'SELECT source_json,product_name FROM amul_products_local WHERE product_id=?').get(String(id));
  if(!p)throw new AppError('Product not found.');
  const saved=this.db.prepare('SELECT payload FROM product_unit_settings WHERE source=? AND product_id=?').get(source,String(id));if(saved)return JSON.parse(saved.payload);
  const units=[{code:'BASE',label:p.unit || 'Stock unit',factor:1}];
  if(source==='AMUL'){
   const group=JSON.parse(p.source_json).UomGroupId;
   const rows=this.db.prepare("SELECT payload FROM amul_records WHERE run=(SELECT run FROM amul_active WHERE id=1) AND dataset='units'").all().map(r=>JSON.parse(r.payload)).filter(r=>String(r.UomGroupId)===String(group));
   const base=rows.find(r=>r.BaseUom==='Y');
   for(const r of rows){const factor=Number(r.ConversionFactor)/Number(base?.ConversionFactor || 1);if(r!==base && Number.isSafeInteger(factor) && factor>1)units.push({code:'UOM:'+r.UomId,label:'Pack UOM '+r.UomId,factor});}
   return amulUnitLabels(p.product_name,units);
  }
  return units;
 }
 save(source,id,input){
  const before=this.list(source,id),units=input.units;
  if(!String(input.reason || '').trim() || !Array.isArray(units)||!units.length||units.length>12)throw new AppError('Enter units and a reason.');
  const codes=new Set();for(const u of units){if(!/^[A-Z0-9:_-]+$/.test(u.code)||codes.has(u.code)||!String(u.label).trim()||String(u.label).length>40||!Number.isSafeInteger(u.factor)||u.factor<1)throw new AppError('Each unit needs a unique code, label and positive whole stock-unit factor.');codes.add(u.code);}
  if(units[0].code!=='BASE'||units[0].factor!==1)throw new AppError('Base stock unit must remain 1.');
  return inTransaction(this.db,()=>{this.db.prepare('INSERT INTO product_unit_settings VALUES(?,?,?) ON CONFLICT(source,product_id) DO UPDATE SET payload=excluded.payload').run(source,String(id),JSON.stringify(units));this.db.prepare("INSERT INTO audit_log(actor,action,entity_type,metadata_json) VALUES('Owner','UPDATE','PRODUCT_UNITS',?)").run(JSON.stringify({source,id,before,after:units,reason:input.reason}));return units;});
 }
 normalize(source,id,input,defaultRate=0){
  const unit=this.list(source,id).find(u=>u.code===input.unitCode);
  if(!unit || (input.unitFactor!==undefined && Number(input.unitFactor)!==unit.factor))throw new AppError('Product packing changed. Re-select the unit.');
  const qty=scaled(input.quantity)*BigInt(unit.factor);
  if(qty%1000000n || qty<=0n || qty/1000000n>BigInt(Number.MAX_SAFE_INTEGER))throw new AppError('Quantity must consume a whole number of base stock units.');
  const price=input.unitPrice ?? Number((defaultRate*unit.factor).toFixed(6));
  return {quantity:Number(qty/1000000n),amount:linePaise(input.quantity,price),baseRate:Number(price)/unit.factor,unit:{...unit,quantity:Number(input.quantity),price:Number(price)}};
 }
}
module.exports={ProductUnits,linePaise};
