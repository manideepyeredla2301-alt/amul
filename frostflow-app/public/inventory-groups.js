function groupInventoryProducts(rows){
 const groups=new Map();
 for(const row of rows){const key=String(row.product_id);let group=groups.get(key);if(!group){group={product_id:key,product_name:row.product_name,sku:row.sku,barcode:row.barcode,stock_qty:0,unsaleable_qty:0,batchSearch:'',batches:[]};groups.set(key,group);}group.stock_qty+=Number(row.stock_qty || 0);group.unsaleable_qty+=Number(row.unsaleable_qty || 0);group.batches.push(row);group.batchSearch+=' '+(row.batch_code || '')+' '+(row.expiry_date || '')+' '+(row.location_id || '');}
 return [...groups.values()];
}
function inventoryProductTable(rows){
 const groups=groupInventoryProducts(rows);window.inventoryProductGroups=groups;
 return dataTable('amulInventorySearch',['Product / barcode','Total stock','Units'],groups,p=>`<tr><td class="wrap-cell"><strong>${esc(p.product_name)}</strong><div class="subtle">${esc(p.sku || '')} · ${esc(p.barcode || '')}</div></td><td>${count(p.stock_qty)} base units</td><td><button class="button secondary" data-stock-units="${esc(p.product_id)}">PC / BOX / CRT</button></td></tr>`,'Search product, barcode or SKU…');
}
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-stock-units]');if(!b)return;
 try {
 const p=window.inventoryProductGroups.find(p=>p.product_id===b.dataset.stockUnits);const url='/api/product-units/AMUL/'+encodeURIComponent(p.product_id);const units=await api(url);
 formModal('Stock units — '+p.product_name,'Set packing from the product label. No batch or expiry selection is required. This changes display conversions only, not stock.',`<p>Total: <strong>${count(p.stock_qty)} base stock units</strong></p><div class="notice">Confirm that one base stock unit is one PC before using PC as its name. BOX and CRT factors are measured in base units, not boxes per carton.</div><div class="form-grid"><div class="field"><label>Base unit name</label><input name="baseLabel" value="${esc(units[0].label)}" required></div><div class="field"><label>Base units in one BOX</label><input name="box" type="number" min="1" step="1" value="${units.find(u=>u.label.toUpperCase()==='BOX')?.factor || ''}"></div><div class="field"><label>Base units in one CRT</label><input name="crt" type="number" min="1" step="1" value="${units.find(u=>u.label.toUpperCase()==='CRT')?.factor || ''}"></div></div><div id="stock-unit-equivalents"></div><p class="hint">Saved source conversions: ${esc(units.map(u=>u.label+' = '+u.factor+' base units').join('; '))}</p><div class="field"><label>Reason for packing change</label><input name="reason" required value="Verified product packing"></div>`,async f=>{
 const updated=[{code:'BASE',label:f.get('baseLabel'),factor:1}];for(const [field,label] of [['box','BOX'],['crt','CRT']])if(f.get(field))updated.push({code:label,label,factor:Number(f.get(field))});
 await api(url,{method:'PATCH',body:{units:updated,reason:f.get('reason')}});
 },true,'Save unit conversions');
 const form=$('#entry-form');const draw=()=>{$('#stock-unit-equivalents').textContent=['box','crt'].map(key=>{const factor=Number(form.elements[key].value);return factor>0?Math.floor(p.stock_qty/factor)+' '+key.toUpperCase()+' + '+(p.stock_qty%factor)+' base units':'';}).filter(Boolean).join('  |  ');};form.addEventListener('input',draw);draw();
 }catch(error){toast(error.message,'error');}
});
