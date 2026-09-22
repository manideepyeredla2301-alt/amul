const { createHash, randomUUID } = require('node:crypto');
const { inTransaction } = require('../db');
const { AppError } = require('./erp-service');
const { readWorkbook, writeWorkbook } = require('../excel-codec');

// Excel is a transport format. The same application services post UI and imported transactions.
const SCHEMAS = {
  products: { sheet: 'Products', headers: ['SKU','Name','Barcode','Brand','Category','Unit','HSN','GST Percent','Purchase Price','Wholesale Price','Retail Price','Reorder Level'],
    notes: ['One row per SKU. Existing SKUs are updated; new SKUs are created. SKU is the permanent key.', 'All prices are INR per unit, excluding GST. GST Percent uses 18 for 18%.', 'Blank optional values preserve existing data. A numeric zero explicitly changes a price to zero.', 'Purchase Price is a default for future receipts. Historical batch costs and stock counts are unchanged.'] },
  stock: { sheet: 'Stock', headers: ['SKU','Batch','Expiry Date','Quantity','Unit Cost','Reason'],
    notes: ['This is a physical stock count: Quantity is the new absolute quantity for that SKU + batch + expiry.', 'Only listed batches change. Unlisted batches are preserved. The difference becomes an audited stock adjustment.', 'Unit Cost is INR per unit excluding GST; an existing batch must keep its original cost. Use a distinct batch for another cost lot.', 'Use Purchases for supplier receipts and payables. This stock count does not create a supplier bill. Reason is required.', 'Dates use YYYY-MM-DD. Blank expiry means no expiry recorded. Expired stock remains separate from saleable stock.'] },
  purchases: { sheet: 'Purchases', headers: ['Purchase Number','Supplier Code','Supplier Bill Number','Bill Date','SKU','Batch','Expiry Date','Quantity','Unit Cost','GST Percent','Notes'],
    notes: ['Repeat Purchase Number for the lines of one bill. It must be a new, unique document number.', 'Supplier and SKU must already exist. A purchase posts inventory, supplier payable and recorded input tax together.', 'Quantity is the quantity received, not a stock count. Costs exclude GST. Dates use YYYY-MM-DD.', 'All header fields must agree for lines sharing a Purchase Number. Distinct costs require distinct batches.'] },
  customers: { sheet: 'Customers', headers: ['Code','Name','Mobile','WhatsApp','GSTIN','Address','City','State Code','PIN Code','Credit Days','Credit Limit','Opening Balance','Opening Date'],
    notes: ['Code is the permanent customer key. New codes create customers; existing codes update contact and credit terms.', 'Opening Balance is INR due from the customer; negative means customer advance. Set it only once before any ledger transactions.', 'Leave Opening Balance blank when updating existing customers. Opening balances have no source invoice or due date.', 'State Code, mobile, PIN, codes and GSTIN are text identifiers. Credit days default to two. Dates use YYYY-MM-DD.'] },
  suppliers: { sheet: 'Suppliers', headers: ['Code','Name','Mobile','WhatsApp','GSTIN','Address','City','State Code','PIN Code','Credit Days','Credit Limit','Opening Balance','Opening Date'],
    notes: ['Code is the permanent supplier key. Positive Opening Balance is payable to supplier; negative is supplier advance.', 'Opening balances are allowed only before any ledger transaction. Leave blank for contact updates.', 'Prices and balances are INR. State Code, phone, PIN and GSTIN are text identifiers. Dates use YYYY-MM-DD.'] },
  payments: { sheet: 'Payments', headers: ['Receipt Number','Direction','Party Code','Payment Date','Method','Amount','Invoice Number','Purchase Number','Reference','Notes'],
    notes: ['One row per unique Receipt Number. Direction RECEIPT collects from a customer; PAYMENT pays a supplier.', 'Methods: CASH, UPI, CARD, BANK, OTHER. Amount is positive INR including the paid tax.', 'An optional Invoice Number or Purchase Number applies the payment to that document. Otherwise oldest open documents are settled first.', 'Overpayments without a selected document are retained as advance credits. Repeated document numbers are rejected.'] },
  invoices: { sheet: 'Invoices', headers: ['Invoice Number','Channel','Customer Code','Invoice Date','Delivery Date','SKU','Quantity','Unit Price','GST Percent','Paid Amount','Payment Method','Notes'],
    notes: ['Repeat Invoice Number for all lines of one sale. Channel is RETAIL or DISTRIBUTION.', 'Unit Price is INR per unit excluding GST. Default uses the current retail/wholesale price if blank.', 'Paid Amount is the invoice-level payment, repeated identically on each row, not a per-line payment.', 'Distribution requires an existing customer. A walk-in RETAIL invoice must be fully paid.', 'Posting immediately allocates shared stock. Previously posted invoices cannot be imported again.'] },
  expenses: { sheet: 'Expenses', headers: ['Expense Number','Date','Category','Payee','Method','Amount','GST Percent','Notes'],
    notes: ['One row per new Expense Number. Amount is INR including GST. GST Percent uses 18 for 18%.', 'Expense tax is a recorded figure for review; this file does not establish input-credit eligibility.', 'Dates use YYYY-MM-DD. Method is CASH, UPI, CARD, BANK, OTHER.'] },
};
const blank = value => value === null || value === undefined || String(value).trim() === '';
const text = value => blank(value) ? '' : String(value).trim();
const normalize = value => text(value).toLowerCase().replace(/[\s_()-]+/g, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const INR = value => Number(value || 0) / 100;
function required(row, field) { if (blank(row[field])) throw new AppError(`${field} is required.`); return text(row[field]); }
function number(row, field, options = {}) {
  if (blank(row[field])) { if ('default' in options) return options.default; throw new AppError(`${field} is required.`); }
  const s = text(row[field]);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) throw new AppError(`${field} must be a number with at most two decimal places (no currency symbols or commas).`);
  const n = Number(s);
  if (!Number.isSafeInteger(Math.round(n * 100)) || Math.abs(n) > 1000000000 || (!options.signed && n < 0) || (options.integer && !Number.isInteger(n))) throw new AppError(`${field} is outside the supported range.`);
  return n;
}
function date(row, field, optional = false) {
  if (optional && blank(row[field])) return undefined;
  const s = required(row, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10) !== s || s < '2000-01-01' || s > '2100-12-31') throw new AppError(`${field} must be a valid date in YYYY-MM-DD format (2000–2100).`);
  return s;
}
function gst(row) { const n = number(row, 'GST Percent', {default: undefined}); if (n === undefined) return undefined; if (n > 100) throw new AppError('GST Percent must be between 0 and 100.'); return Math.round(n * 100); }

class ExcelService {
  constructor(erp) {
    this.erp = erp; this.db = erp.db; this.previews = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY, import_type TEXT NOT NULL, content_hash TEXT NOT NULL, filename TEXT NOT NULL,
      row_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(import_type,content_hash));`);
  }
  revision() { return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS revision FROM audit_log').get().revision); }
  history() { return this.db.prepare('SELECT id, import_type AS type, filename, row_count, created_at FROM import_batches ORDER BY id DESC LIMIT 100').all(); }
  schema(type) { if (!SCHEMAS[type]) throw new AppError('Unknown import type.'); return SCHEMAS[type]; }
  findProduct(sku) { const p = this.db.prepare('SELECT * FROM products WHERE sku = ? AND active = 1').get(text(sku).toUpperCase()); if (!p) throw new AppError(`Unknown SKU: ${text(sku)}. Import Products first.`); return p; }
  findParty(code, type) { const p = this.db.prepare("SELECT * FROM parties WHERE code = ? AND active = 1 AND party_type IN (?, 'BOTH')").get(text(code).toUpperCase(),type); if (!p) throw new AppError(`Unknown ${type.toLowerCase()} code: ${text(code)}. Import contacts first.`); return p; }

  async preview({type, filename, base64}) {
    const schema = this.schema(type);
    if (typeof base64 !== 'string' || base64.length > 7_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new AppError('Choose a valid XLSX or CSV file under 5 MB.');
    const bytes = Buffer.from(base64,'base64');
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new AppError('File must contain data and be no larger than 5 MB.');
    let sheets;
    try { sheets = await readWorkbook(bytes, filename); }
    catch (error) { throw new AppError(error.message, 400, 'EXCEL_ERROR'); }
    const sheet = sheets.find(s => s.name.toLowerCase() === schema.sheet.toLowerCase()) || (sheets.length === 1 ? sheets[0] : null);
    if (!sheet) throw new AppError(`The workbook must contain a sheet named ${schema.sheet}.`);
    const headerIndex = sheet.rows.findIndex(r => r.some(c => !blank(c)));
    if (headerIndex < 0) throw new AppError('The selected worksheet is empty.');
    const header = sheet.rows[headerIndex].map(normalize);
    const errors = []; const warnings = [];
    const known = new Map(schema.headers.map(h => [normalize(h),h]));
    const repeated = header.filter((h,i) => h && header.indexOf(h) !== i);
    if (repeated.length) throw new AppError(`Duplicate columns: ${repeated.join(', ')}.`);
    const unknown = header.filter(h => h && !known.has(h));
    if (unknown.length) throw new AppError(`Unrecognized columns: ${unknown.join(', ')}. Use the downloaded ${schema.sheet} template.`);
    for (let i=headerIndex+1;i<sheet.rows.length;i++) {
      if (sheet.rows[i].some((value,j)=>!blank(value) && !header[j])) throw new AppError(`Row ${i+1} has a value under a blank column heading. Add the correct template heading or remove that column.`);
    }
    const records = sheet.rows.slice(headerIndex+1).map((values,i) => ({ row: headerIndex+i+2, data: Object.fromEntries(header.map((h,j) => [known.get(h) || '',values[j] ?? ''])) }))
      .filter(r => Object.entries(r.data).some(([k,v])=>k && !blank(v)));
    if (!records.length) throw new AppError('The worksheet has headers but no data rows.');
    if (records.length > 5000) throw new AppError('Import at most 5,000 rows per file.');
    for (const record of records) {
      for (const [field,value] of Object.entries(record.data)) if (String(value).length > 2000) errors.push({row:record.row,field,message:'Cell text must be no longer than 2,000 characters.'});
    }
    const contentHash = hash(JSON.stringify(records.map(r=>r.data)));
    if (this.db.prepare('SELECT id FROM import_batches WHERE import_type = ? AND content_hash = ?').get(type,contentHash)) throw new AppError('This data has already been imported. Export fresh data or supply new transaction numbers.',409,'DUPLICATE_IMPORT');
    const revision = this.revision();
    const plan = this.makePlan(type, records, errors);
    const rows = [];
    const before = this.db.prepare('SELECT COALESCE(SUM(quantity_available),0) AS units, COALESCE(SUM(quantity_available*cost_paise),0) AS cost FROM inventory_batches').get();
    let after = before;
    // Validate using actual posting rules and inspect the outcome, then rollback every preview write.
    this.db.exec('SAVEPOINT excel_preview');
    try {
      for (const entry of plan) {
        try {
          const result = inTransaction(this.db,()=>this.apply(type,entry));
          rows.push({row:entry.row,action:result.action || 'POST',summary:result.summary || entry.key});
        } catch (error) { errors.push({row:entry.row,field:'',message:error.message}); }
      }
      after = this.db.prepare('SELECT COALESCE(SUM(quantity_available),0) AS units, COALESCE(SUM(quantity_available*cost_paise),0) AS cost FROM inventory_batches').get();
    } finally { this.db.exec('ROLLBACK TO excel_preview'); this.db.exec('RELEASE excel_preview'); }
    if (type==='stock') warnings.push('Quantity replaces the count of each listed batch. Review stock-unit and cost-value changes below.');
    if (['products','purchases','invoices'].includes(type)) warnings.push('Product prices and unit costs are INR excluding GST.');
    if (['customers','suppliers'].includes(type)) warnings.push('Opening balances do not have invoice due dates; they appear separately from invoice aging.');
    const valid = errors.length === 0;
    const token = valid ? randomUUID() : null;
    const expiresAt = new Date(Date.now()+15*60*1000).toISOString();
    for (const [id,p] of this.previews) if (p.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value);
    if (valid) this.previews.set(token,{type,filename:text(filename).slice(0,200),contentHash,plan,revision,rowCount:records.length,expires:Date.parse(expiresAt)});
    return {token,valid,rowCount:records.length,documentCount:plan.length,rows:rows.slice(0,200),errors:errors.slice(0,200),errorCount:errors.length,warnings,
      totals:{stockUnitsBefore:before.units,stockUnitsAfter:after.units,stockValueBeforePaise:before.cost,stockValueAfterPaise:after.cost,stockUnitChange:after.units-before.units,stockValueChangePaise:after.cost-before.cost},expiresAt};
  }

  makePlan(type,records,errors) {
    const grouped = ['purchases','invoices'].includes(type);
    const keyField = {products:'SKU',stock:'SKU',customers:'Code',suppliers:'Code',payments:'Receipt Number',expenses:'Expense Number',purchases:'Purchase Number',invoices:'Invoice Number'}[type];
    const seen = new Map();
    for (const record of records) {
      let key = text(record.data[keyField]).toUpperCase();
      if (!key) { errors.push({row:record.row,field:keyField,message:`${keyField} is required.`}); continue; }
      if (type==='stock') key += `|${text(record.data.Batch)}|${text(record.data['Expiry Date'])}`;
      if (seen.has(key)) {
        if (grouped) seen.get(key).lines.push(record);
        else errors.push({row:record.row,field:keyField,message:`Duplicate ${keyField} in file: ${key}.`});
      } else seen.set(key,{...record,key,lines:[record]});
    }
    return [...seen.values()];
  }
  commit(token) {
    const p = this.previews.get(token);
    if (!p || p.expires < Date.now()) throw new AppError('The preview expired or was already committed. Preview the file again.',409,'PREVIEW_EXPIRED');
    const result = inTransaction(this.db,()=>{
      if (this.revision()!==p.revision) throw new AppError('Business data changed after this preview. Preview the file again to check against current stock and balances.',409,'STALE_PREVIEW');
      if (this.db.prepare('SELECT id FROM import_batches WHERE import_type=? AND content_hash=?').get(p.type,p.contentHash)) throw new AppError('This file was already imported.',409,'DUPLICATE_IMPORT');
      for (const entry of p.plan) this.apply(p.type,entry);
      const insert=this.db.prepare('INSERT INTO import_batches(import_type,content_hash,filename,row_count) VALUES (?,?,?,?)').run(p.type,p.contentHash,p.filename,p.rowCount);
      this.erp.audit('IMPORT','EXCEL_IMPORT',Number(insert.lastInsertRowid),{type:p.type,filename:p.filename,rows:p.rowCount,documents:p.plan.length,hash:p.contentHash});
      return {id:Number(insert.lastInsertRowid),rowCount:p.rowCount,documentCount:p.plan.length,type:p.type};
    });
    this.previews.delete(token); return result;
  }

  apply(type,entry) {
    const r=entry.data;
    if (type==='products') {
      const sku=required(r,'SKU').toUpperCase();
      const old=this.db.prepare('SELECT * FROM products WHERE sku=?').get(sku);
      const fields={sku};
      for (const [column,key] of Object.entries({Name:'name',Barcode:'barcode',Brand:'brand',Category:'category',Unit:'unit',HSN:'hsnCode'})) if (!blank(r[column])) fields[key]=text(r[column]);
      for (const [column,key] of Object.entries({'Purchase Price':'purchasePrice','Wholesale Price':'wholesalePrice','Retail Price':'retailPrice','Reorder Level':'reorderLevel'})) if (!blank(r[column])) fields[key]=number(r,column,{integer:column==='Reorder Level'});
      if (!blank(r['GST Percent'])) fields.gstBps=gst(r);
      if (!old) { required(r,'Name'); this.erp.createProduct(fields); }
      else this.erp.updateProduct(old.id,fields);
      return {action:old?'UPDATE':'CREATE',summary:`${sku}: ${fields.name || old?.name}`};
    }
    if (type==='stock') {
      const product=this.findProduct(required(r,'SKU'));
      const result=this.erp.setBatchStock({productId:product.id,batchNumber:required(r,'Batch'),expiryDate:date(r,'Expiry Date',true),quantity:number(r,'Quantity',{integer:true}),unitCost:number(r,'Unit Cost'),reason:required(r,'Reason')});
      return {action:'STOCK COUNT',summary:`${product.sku} / ${text(r.Batch)} → ${r.Quantity} units`};
    }
    if (['customers','suppliers'].includes(type)) return this.upsertParty(type,r);
    if (type==='purchases') {
      this.sameHeaders(entry,['Supplier Code','Supplier Bill Number','Bill Date','Notes']);
      const supplier=this.findParty(required(r,'Supplier Code'),'SUPPLIER');
      const billNumber=required(r,'Purchase Number');
      if (this.db.prepare('SELECT id FROM purchase_bills WHERE bill_number=?').get(billNumber)) throw new AppError(`Purchase ${billNumber} already exists.`);
      this.erp.receivePurchase({billNumber,supplierId:supplier.id,supplierBillNumber:text(r['Supplier Bill Number']),billDate:date(r,'Bill Date'),notes:text(r.Notes),items:entry.lines.map(({data:l})=>({productId:this.findProduct(required(l,'SKU')).id,quantity:number(l,'Quantity',{integer:true}),unitCost:number(l,'Unit Cost'),batchNumber:required(l,'Batch'),expiryDate:date(l,'Expiry Date',true),gstBps:gst(l)}))});
      return {summary:`${billNumber}: ${entry.lines.length} lines for ${supplier.name}`};
    }
    if (type==='invoices') {
      this.sameHeaders(entry,['Channel','Customer Code','Invoice Date','Delivery Date','Paid Amount','Payment Method','Notes']);
      const invoiceNumber=required(r,'Invoice Number');
      if (this.db.prepare('SELECT id FROM invoices WHERE invoice_number=?').get(invoiceNumber)) throw new AppError(`Invoice ${invoiceNumber} already exists.`);
      const customer=blank(r['Customer Code'])?null:this.findParty(r['Customer Code'],'CUSTOMER');
      const paid=number(r,'Paid Amount',{default:0});
      this.erp.createInvoice({invoiceNumber,channel:required(r,'Channel').toUpperCase(),customerId:customer?.id,invoiceDate:date(r,'Invoice Date'),deliveryDate:date(r,'Delivery Date',true),notes:text(r.Notes),payments:paid?[{method:required(r,'Payment Method').toUpperCase(),amount:paid}]:[],items:entry.lines.map(({data:l})=>({productId:this.findProduct(required(l,'SKU')).id,quantity:number(l,'Quantity',{integer:true}),unitPrice:number(l,'Unit Price',{default:undefined}),gstBps:gst(l)}))});
      return {summary:`${invoiceNumber}: ${entry.lines.length} lines for ${customer?.name || 'Walk-in'}`};
    }
    if (type==='payments') {
      const direction=required(r,'Direction').toUpperCase();
      if (!['RECEIPT','PAYMENT'].includes(direction)) throw new AppError('Direction must be RECEIPT or PAYMENT.');
      const supplier=direction==='PAYMENT';
      const party=this.findParty(required(r,'Party Code'),supplier?'SUPPLIER':'CUSTOMER');
      const receiptNumber=required(r,'Receipt Number');
      if (this.db.prepare('SELECT id FROM payments WHERE receipt_number=?').get(receiptNumber)) throw new AppError(`Receipt ${receiptNumber} already exists.`);
      const fields={receiptNumber,partyId:party.id,amount:number(r,'Amount'),method:required(r,'Method').toUpperCase(),paymentDate:date(r,'Payment Date'),referenceNumber:text(r.Reference),notes:text(r.Notes)};
      if (!blank(r['Invoice Number'])) {
        if (supplier) throw new AppError('A supplier payment cannot select a sales invoice.');
        const invoice=this.db.prepare('SELECT id FROM invoices WHERE invoice_number=? AND customer_id=?').get(text(r['Invoice Number']),party.id);
        if (!invoice) throw new AppError('Invoice Number does not belong to this customer.'); fields.invoiceId=invoice.id;
      }
      if (!blank(r['Purchase Number'])) {
        if (!supplier) throw new AppError('A customer receipt cannot select a purchase bill.');
        const purchase=this.db.prepare('SELECT id FROM purchase_bills WHERE bill_number=? AND supplier_id=?').get(text(r['Purchase Number']),party.id);
        if (!purchase) throw new AppError('Purchase Number does not belong to this supplier.'); fields.purchaseBillId=purchase.id;
      }
      (supplier?this.erp.recordSupplierPayment(fields):this.erp.recordReceipt(fields));
      return {summary:`${receiptNumber}: ₹${fields.amount} ${supplier?'to':'from'} ${party.name}`};
    }
    if (type==='expenses') {
      const expenseNumber=required(r,'Expense Number');
      if (this.db.prepare('SELECT id FROM expenses WHERE expense_number=?').get(expenseNumber)) throw new AppError(`Expense ${expenseNumber} already exists.`);
      this.erp.recordExpense({expenseNumber,expenseDate:date(r,'Date'),category:required(r,'Category'),payee:text(r.Payee),method:required(r,'Method').toUpperCase(),amount:number(r,'Amount'),gstBps:gst(r) ?? 0,notes:text(r.Notes)});
      return {summary:`${expenseNumber}: ${text(r.Category)} ₹${r.Amount}`};
    }
    throw new AppError('Unsupported import type.');
  }
  sameHeaders(entry,headers) { for (const line of entry.lines) for(const h of headers) if(text(line.data[h])!==text(entry.data[h])) throw new AppError(`Row ${line.row}: ${h} differs within ${entry.key}. Repeat the same invoice-level value on all its lines.`); }
  upsertParty(type,r) {
    const partyType=type==='customers'?'CUSTOMER':'SUPPLIER';
    const code=required(r,'Code').toUpperCase();
    let old=this.db.prepare('SELECT * FROM parties WHERE code=?').get(code);
    const existed=Boolean(old);
    if(old && old.party_type!==partyType && old.party_type!=='BOTH') throw new AppError(`Code ${code} is already assigned to a different party type.`);
    const fields={partyType,code};
    const mapping={Name:'name',Mobile:'mobile',WhatsApp:'whatsappNumber',GSTIN:'gstin',Address:'address',City:'city','State Code':'stateCode','PIN Code':'pincode'};
    for(const [column,key] of Object.entries(mapping)) if(!blank(r[column])) fields[key]=text(r[column]);
    if(fields.stateCode && !/^\d{2}$/.test(fields.stateCode)) throw new AppError('State Code must contain two digits. Format its Excel column as text.');
    if(!blank(r['Credit Days'])) fields.creditDays=number(r,'Credit Days',{integer:true});
    if(!blank(r['Credit Limit'])) fields.creditLimit=number(r,'Credit Limit');
    if(!old) { required(r,'Name'); old=this.erp.createParty(fields); }
    else {
      const columns={name:'name',mobile:'mobile',whatsappNumber:'whatsapp_number',gstin:'gstin',address:'address',city:'city',stateCode:'state_code',pincode:'pincode',creditDays:'credit_days',creditLimit:'credit_limit_paise'};
      const entries=Object.entries(fields).filter(([k])=>columns[k]);
      if(fields.stateCode && !/^\d{2}$/.test(fields.stateCode)) throw new AppError('State Code must contain two digits. Format its Excel column as text.');
      if(entries.length) this.db.prepare(`UPDATE parties SET ${entries.map(([k])=>`${columns[k]}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([k,v])=>k==='creditLimit'?Math.round(v*100):v),old.id);
      this.erp.audit('UPDATE','PARTY',old.id,{code,fields});
    }
    if(!blank(r['Opening Balance'])) {
      const amount=number(r,'Opening Balance',{signed:true});
      if(amount!==0) {
        if(this.db.prepare('SELECT id FROM party_ledger_entries WHERE party_id=? LIMIT 1').get(old.id)) throw new AppError(`Opening Balance cannot be changed after transactions exist for ${code}. Leave it blank.`);
        const balance=Math.round(amount*100)*(partyType==='CUSTOMER'?1:-1);
        this.db.prepare("INSERT INTO party_ledger_entries(party_id,entry_date,entry_type,debit_paise,credit_paise,reference_type,reference_id,narration) VALUES (?,?,'OPENING_ADJUSTMENT',?,?,'PARTY',?,'Opening balance imported from Excel')").run(old.id,date(r,'Opening Date'),Math.max(balance,0),Math.max(-balance,0),old.id);
        this.erp.audit('OPENING_BALANCE','PARTY',old.id,{code,amountPaise:balance});
      }
    }
    return {action:existed?'UPDATE':'CREATE',summary:`${code}: ${fields.name || old.name}`};
  }

  template(type) { const s=this.schema(type); return writeWorkbook([{name:s.sheet,headers:s.headers,rows:[],formats:s.headers.map(h=>/Price|Cost|Limit|Balance|Amount/.test(h)?'money':/Quantity|Days|Level/.test(h)?'integer':'text')},{name:'Guide',headers:['How to use this file'],rows:[['Fill the first sheet, save, upload to Excel Center and inspect the preview before committing.'],...s.notes.map(n=>[n]),['Formulas are not imported. Paste Special → Values before uploading calculated cells.'],['Supported files: .xlsx or UTF-8 .csv. Dates: YYYY-MM-DD. Up to 5,000 rows and 5 MB.']],widths:[100]}]); }

  exportSheets(type) {
    const s=SCHEMAS[type];
    if(type==='products') return [{name:s.sheet,headers:s.headers,rows:this.erp.listProducts().map(p=>[p.sku,p.name,p.barcode,p.brand,p.category,p.unit,p.hsn_code,p.gst_bps/100,INR(p.purchase_price_paise),INR(p.wholesale_price_paise),INR(p.retail_price_paise),p.reorder_level])}];
    if(type==='stock') return [{name:s.sheet,headers:s.headers,rows:this.db.prepare('SELECT b.*,p.sku FROM inventory_batches b JOIN products p ON p.id=b.product_id ORDER BY p.sku,b.id').all().map(b=>[b.sku,b.batch_number,b.expiry_date,b.quantity_available,INR(b.cost_paise),''])}];
    if(type==='inventory') {
      const summary=this.erp.inventorySummary();
      return [{name:'Stock Value',headers:['Valuation','INR / units'],rows:[['Physical stock units',summary.stock_units],['Saleable units',summary.saleable_units],['Expired units',summary.expired_units],['Inventory at historical cost (INR)',INR(summary.cost_value_paise)],['At current wholesale prices, excluding GST (INR)',INR(summary.wholesale_value_paise)],['At current retail prices, excluding GST (INR)',INR(summary.retail_value_paise)]]},
        {name:'Inventory',headers:['SKU','Product','Physical Quantity','Saleable Quantity','Expired Quantity','Default Purchase Price','Wholesale Price','Retail Price','Historical Cost Value','Wholesale Value','Retail Value','Reorder Level'],rows:this.erp.listProducts().map(p=>[p.sku,p.name,p.stock_qty,p.saleable_qty,p.expired_qty,INR(p.purchase_price_paise),INR(p.wholesale_price_paise),INR(p.retail_price_paise),INR(p.stock_value_paise),INR(p.wholesale_value_paise),INR(p.retail_value_paise),p.reorder_level])},...this.exportSheets('stock')];
    }
    if(['customers','suppliers'].includes(type)) return [{name:s.sheet,headers:s.headers,rows:this.erp.listParties(type==='customers'?'CUSTOMER':'SUPPLIER').map(p=>[p.code,p.name,p.mobile,p.whatsapp_number,p.gstin,p.address,p.city,p.state_code,p.pincode,p.credit_days,INR(p.credit_limit_paise),'',''])}];
    if(type==='purchases') return [{name:s.sheet,headers:s.headers,rows:this.db.prepare(`SELECT b.*,p.code,pi.*,prod.sku FROM purchase_items pi JOIN purchase_bills b ON b.id=pi.purchase_bill_id JOIN parties p ON p.id=b.supplier_id JOIN products prod ON prod.id=pi.product_id ORDER BY b.id,pi.id`).all().map(r=>[r.bill_number,r.code,r.supplier_bill_number,r.bill_date,r.sku,r.batch_number,r.expiry_date,r.quantity,INR(r.unit_cost_paise),r.gst_bps/100,r.notes])}];
    if(type==='payments') return [{name:s.sheet,headers:s.headers,rows:this.db.prepare(`SELECT pay.*,p.code,i.invoice_number FROM payments pay LEFT JOIN parties p ON p.id=pay.party_id LEFT JOIN invoices i ON i.id=pay.invoice_id ORDER BY pay.id`).all().map(r=>[r.receipt_number,r.direction,r.code || 'WALK-IN',r.payment_date,r.method,INR(r.amount_paise),r.invoice_number,'',r.reference_number,r.notes])}];
    if(type==='invoices') return [{name:'Invoices',headers:['Invoice Number','Channel','Customer','Invoice Date','Due Date','Taxable Value','CGST','SGST','IGST','Total','Collected','Returned Credit','Outstanding','Payment Status'],rows:this.erp.invoices().map(r=>[r.invoice_number,r.channel,r.customer_name || 'Walk-in',r.invoice_date,r.due_date,INR(r.subtotal_paise),INR(r.cgst_paise),INR(r.sgst_paise),INR(r.igst_paise),INR(r.total_paise),INR(r.paid_paise),INR(r.returned_paise ?? r.return_credit_paise),INR(r.outstanding_paise ?? Math.max(0,r.total_paise-r.paid_paise)),r.payment_status])}];
    if(type==='expenses') return [{name:s.sheet,headers:s.headers,rows:this.erp.expenses().map(r=>[r.expense_number,r.expense_date,r.category,r.payee,r.method,INR(r.amount_paise),r.gst_bps/100,r.notes])}];
    if(type==='receivables') { const r=this.erp.receivables(); return [{name:'Receivables',headers:['Code','Customer','Mobile','Net Ledger Balance','Amount Receivable','Advance Credit','Overdue','Not Yet Due','1–7 Days','8–30 Days','31+ Days','Opening / Unallocated Balance'],rows:r.customers.map(c=>[c.code,c.name,c.mobile,INR(c.balance_paise),INR(c.receivable_paise),INR(c.credit_paise),INR(c.overdue_paise),INR(c.current_paise),INR(c.aging_1_7_paise),INR(c.aging_8_30_paise),INR(c.aging_31_plus_paise),INR(c.unallocated_balance_paise)])},{name:'Outstanding Invoices',headers:['Invoice','Customer','Date','Due Date','Days Overdue','Outstanding'],rows:r.invoices.map(i=>[i.invoice_number,i.customer_name,i.invoice_date,i.due_date,i.days_overdue,INR(i.outstanding_paise)])}]; }
    if(type==='ledger') return [{name:'Ledger',headers:['Party Code','Party','Type','Date','Entry','Reference Type','Reference ID','Narration','Debit','Credit','Running Balance'],rows:this.db.prepare(`SELECT p.code,p.name,p.party_type,l.*,SUM(l.debit_paise-l.credit_paise) OVER (PARTITION BY l.party_id ORDER BY l.entry_date,l.id) AS balance_paise FROM party_ledger_entries l JOIN parties p ON p.id=l.party_id ORDER BY p.code,l.entry_date,l.id`).all().map(r=>[r.code,r.name,r.party_type,r.entry_date,r.entry_type,r.reference_type,r.reference_id,r.narration,INR(r.debit_paise),INR(r.credit_paise),INR(r.balance_paise)])}];
    if(type==='all') return ['inventory','products','customers','suppliers','purchases','invoices','payments','receivables','ledger','expenses'].flatMap(t=>this.exportSheets(t));
    throw new AppError('Unknown export type.');
  }
  export(type) {
    const sheets=this.exportSheets(type);
    for(const s of sheets) s.formats=s.headers.map((h,i)=> {
      if(/Date$/.test(h))return 'date';
      if(/(?:Code|SKU|Barcode|HSN|GSTIN|Mobile|WhatsApp|Number|Reference ID)$/.test(h))return 'text';
      if(s.rows.some(r=>typeof r[i]==='number')) {
        if(/Price|Cost|Value|Amount|Balance|Credit|Debit|Collected|Outstanding|Total|CGST|SGST|IGST|Receivable|Overdue$|Due$|^\d.*Days$/.test(h) && !/Quantity|Days Overdue/.test(h))return 'money';
        if(/Quantity|Level|Days/.test(h))return 'integer';
        return undefined;
      }
      return 'text';
    });
    return writeWorkbook(sheets);
  }
}

module.exports = {ExcelService,SCHEMAS};
