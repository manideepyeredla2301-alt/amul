const {inTransaction}=require('../db');
const {AppError,paise,rate}=require('../domain');
class CatalogueAdmin {
 constructor(db,erp) {
  this.db=db;this.erp=erp;
  db.exec('CREATE TABLE IF NOT EXISTS amul_product_overrides(product_id TEXT PRIMARY KEY,name TEXT NOT NULL,mrp_paise INTEGER NOT NULL,selling_price_paise INTEGER NOT NULL,active INTEGER NOT NULL)');
 }
 rows() {
  const local=this.erp.listProducts().map(p=>({source:'LOCAL',id:String(p.id),code:p.sku,barcode:p.barcode,name:p.name,stock:p.saleable_qty ?? p.stock_qty,mrp:p.mrp_paise,price:p.wholesale_price_paise,gst:p.gst_bps,active:p.active}));
  const amul=this.db.prepare('SELECT product_id id,sku code,barcode,product_name name,stock_qty stock,mrp_paise mrp,selling_price_paise price,active FROM amul_products_local').all().map(p=>({...p,source:'AMUL',gst:null}));
  return [...local,...amul].sort((a,b)=>(b.stock>0)-(a.stock>0)||a.name.localeCompare(b.name));
 }
 save(input) {
  if(!Array.isArray(input.rows) || !input.rows.length || input.rows.length>500)throw new AppError('Save between 1 and 500 changed rows.');
  return inTransaction(this.db,()=>{
   const current=new Map(this.rows().map(p=>[p.source+':'+p.id,p]));
   const seen=new Set();
   for(const change of input.rows) {
    const key=change.source+':'+change.id,old=current.get(key);
    if(!old || seen.has(key))throw new AppError('Invalid or duplicate product.');
    seen.add(key);
    if(!change.before || ['name','mrp','price','gst','active'].some(k=>change.before[k]!==old[k]))throw new AppError('Prices changed since this sheet was opened. Reload the sheet.',409);
    const name=String(change.name || '').trim();if(!name || name.length>200)throw new AppError('Enter a product name under 200 characters.');
    const mrp=paise(change.mrp,'MRP'),price=paise(change.price,'Selling price');
    const active=Number(change.active);if(![0,1].includes(active))throw new AppError('Active must be 0 or 1.');
    if(change.source==='LOCAL') {
     const gst=rate(Math.round(Number(change.gst)*100));
     this.erp.updateProduct(change.id,{name,mrpPrice:change.mrp,wholesalePrice:change.price,gstBps:gst});
     this.db.prepare('UPDATE products SET active=? WHERE id=?').run(active,Number(change.id));
    } else {
     this.db.prepare('INSERT INTO amul_product_overrides VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET name=excluded.name,mrp_paise=excluded.mrp_paise,selling_price_paise=excluded.selling_price_paise,active=excluded.active').run(String(change.id),name,mrp,price,active);
     this.db.prepare('UPDATE amul_products_local SET product_name=?,mrp_paise=?,selling_price_paise=?,active=? WHERE product_id=?').run(name,mrp,price,active,String(change.id));
    }
    this.erp.audit('UPDATE','ITEM_SHEET',null,{source:change.source,id:change.id,before:old,after:{name,mrp,price,active}});
   }
   return {saved:seen.size};
  });
 }
 routes() {
  const routes=this.db.prepare('SELECT route_id,route_code,route_name,active,source_json FROM amul_routes').all();
  const members=new Map(routes.map(r=>[r.route_id,new Set()]));
  for(const r of this.db.prepare("SELECT payload FROM amul_records WHERE run=(SELECT run FROM amul_active WHERE id=1) AND dataset='customer_routes'").all()) {
   const link=JSON.parse(r.payload);members.get(String(link.RMId))?.add(String(link.RtrId));
  }
  const retailers=this.db.prepare('SELECT retailer_id,retailer_name,retailer_code,mobile,address,route_id,active FROM amul_retailers WHERE local_deleted=0').all();
  return routes.map(r=>{const raw=JSON.parse(r.source_json || '{}');const ids=members.get(r.route_id);
   const customers=retailers.filter(c=>c.route_id===r.route_id || ids.has(c.retailer_id));
   return {id:r.route_id,code:r.route_code,name:r.route_name,active:r.active,days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].filter(d=>Number(raw['RM'+d])===1),customers};
  });
 }
}
module.exports={CatalogueAdmin};
