const {inTransaction}=require('../db');
const {AppError,whole,paise,dateOnly,businessToday,multiply,sum}=require('../domain');
const {randomUUID}=require('node:crypto');
class PosCheckout {
 constructor(db,erp,amul,catalogue){Object.assign(this,{db,erp,amul,catalogue});db.exec('CREATE TABLE IF NOT EXISTS pos_receipts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');}
 post(input){return inTransaction(this.db,()=>{
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>200)throw new AppError('Add 1–200 items to the cart.');
  if(!['CASH','UPI','CARD'].includes(input.method))throw new AppError('Choose Cash, UPI or Card.');
  const catalogue=new Map(this.catalogue.rows().map(p=>[p.source+':'+p.id,p])),seen=new Set();
  const items=input.items.map(l=>{const key=l.source+':'+l.productId,p=catalogue.get(key);if(!p||!p.active||seen.has(key))throw new AppError('Invalid, inactive or duplicate cart product.');seen.add(key);const quantity=whole(l.quantity,'Quantity');if(!Number.isSafeInteger(p.mrp)||p.mrp<=0)throw new AppError('Set MRP for '+p.name);if(l.unitPricePaise!==p.mrp)throw new AppError('MRP changed for '+p.name+'. Refresh the catalogue and review your cart.',409);if(quantity>p.stock)throw new AppError('Insufficient stock for '+p.name);return {...p,quantity,total:multiply(quantity,p.mrp)};});
  const total=sum(items.map(l=>l.total));if(paise(input.amount,'Payment')!==total)throw new AppError('Payment must equal the cart total. Enter the amount applied, excluding cash change.');
  const date=dateOnly(input.saleDate || businessToday(),'Sale date'),id='POS-'+randomUUID(),documents=[];
  const local=items.filter(l=>l.source==='LOCAL');if(local.length){const result=this.erp.createInvoice({channel:'RETAIL',priceMode:'MRP',invoiceDate:date,notes:id,items:local.map(l=>({productId:l.id,quantity:l.quantity})),payments:[{method:input.method,amount:sum(local.map(l=>l.total))/100}]});documents.push({source:'LOCAL',...result});}
  for(const l of items.filter(l=>l.source==='AMUL'))documents.push({source:'AMUL',...this.amul.createAmulPosSale({productId:l.id,quantity:l.quantity,unitPrice:l.mrp/100,saleDate:date,method:input.method,notes:id})});
  const receipt={id,date,method:input.method,total_paise:total,items:items.map(l=>({source:l.source,productId:l.id,name:l.name,quantity:l.quantity,unitPricePaise:l.mrp,totalPaise:l.total})),documents};
  this.db.prepare('INSERT INTO pos_receipts(id,payload) VALUES(?,?)').run(id,JSON.stringify(receipt));this.erp.audit('POST','POS_CHECKOUT',null,receipt);return receipt;
 });}
}
module.exports={PosCheckout};
