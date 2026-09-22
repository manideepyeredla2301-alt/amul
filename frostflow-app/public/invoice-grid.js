function productKeywordMatch(text,query){return query.toLowerCase().trim().split(/\s+/).every(word=>String(text).toLowerCase().includes(word));}
async function invoiceGrid(source,id){
 const isAmul=source==='AMUL',url=(isAmul?'/api/amul/invoices/':'/api/invoices/')+encodeURIComponent(id);
 const [detail,catalogue]=await Promise.all([api(url),api('/api/pos/catalogue')]);
 const products=catalogue.filter(p=>p.source===source),rows=[];
 const headerAdjustment=isAmul?detail.invoice.total_paise-detail.items.reduce((s,l)=>s+l.net_paise,0):0;
 formModal('Edit invoice — '+detail.invoice.invoice_number,'Search by any part of a name (butt → Butterscotch), SKU or barcode. Prices are per selected unit. Corrections stay local.',`<div class="invoice-grid-scroll"><table class="invoice-grid-table"><colgroup><col style="width:34%"><col style="width:15%"><col style="width:9%"><col style="width:11%"><col style="width:11%"><col style="width:15%"><col style="width:5%"></colgroup><thead><tr>${['Product / batch','Unit / packing','Quantity','Rate ₹','GST % / tax ₹','Stock consumed / total',''].map(x=>'<th>'+x+'</th>').join('')}</tr></thead><tbody id="invoice-grid-body"></tbody></table></div><button type="button" class="button secondary" id="invoice-grid-add">＋ Add item</button><p id="invoice-grid-total"></p><div class="field"><label>Reason for correction *</label><input name="reason" required></div>`,async(f)=>{
  if(rows.some(r=>!r.product || r.loading))throw new Error('Select a product for every row and wait for packing to load.');
  await api(url,{method:'PATCH',body:{reason:f.get('reason'),items:rows.map(r=>({productId:r.product.id,batchId:r.batch.value,unitCode:r.unit.value,unitFactor:r.units.find(u=>u.code===r.unit.value)?.factor,quantity:r.qty.value,unitPrice:r.price.value,freeQuantity:r.free.value,taxAmount:r.tax.value,gstBps:Math.round(Number(r.tax.value)*100),taxInclusive:r.inclusive,adjustment:r.adjust.value}))}});await refreshCatalogue();
 },true,'Save invoice');
 $('#entry-form').closest('.modal').classList.add('invoice-grid-modal');
 function update(){let total=headerAdjustment;for(const r of rows){const factor=r.units.find(u=>u.code===r.unit.value)?.factor || 1,q=Number(r.qty.value),gross=Math.round(q*Number(r.price.value)*100),tax=isAmul?Math.round(Number(r.tax.value)*100):r.inclusive?0:Math.round(gross*Number(r.tax.value)/100);r.total=gross+tax+Math.round(Number(r.adjust.value)*100);total+=r.total;r.output.textContent=`${q*factor+Number(r.free.value)} base units · ${money(r.total)}`;}$('#invoice-grid-total').textContent='Invoice total: '+money(total)+(headerAdjustment?' (includes retained header adjustment '+money(headerAdjustment)+')':'');}
 async function add(line={}){
  const tr=document.createElement('tr');tr.innerHTML=`<td class="invoice-product-cell"><input class="search-input" data-f="search" placeholder="Filter products by name / barcode" autocomplete="off"><select data-f="picker" aria-label="Select replacement product" ></select><small data-f="matches"></small><select data-f="batch" aria-label="Stock batch" ${isAmul?'':'hidden'}></select></td><td><select data-f="unit" aria-label="Unit"></select><button type="button" data-f="packing" class="button ghost small">Packing</button></td><td><input data-f="qty" aria-label="Quantity" type="number" min="0.000001" step=".000001" required style="width:85px"></td><td><input data-f="price" aria-label="Unit rate" type="number" min="0" step=".000001" required style="width:110px"><small data-f="basis"></small></td><td><input data-f="tax" aria-label="${isAmul?'Line tax amount':'GST percent'}" type="number" min="0" step=".01" required style="width:80px"><small>${isAmul?'Line tax ₹ (review)':'GST %'}</small></td><td data-f="output"></td><td><button type="button" data-f="remove" class="button danger small">×</button></td>`;
  $('#invoice-grid-body').append(tr);const r={units:[],inclusive:!!line.tax_inclusive,free:{value:0},adjust:{value:0}};tr.querySelectorAll('[data-f]').forEach(el=>r[el.dataset.f]=el);rows.push(r);
  const meta=isAmul?(JSON.parse(line.source_json || '{}').unit_details || {}):JSON.parse(line.unit_details || '{}');
  r.qty.value=meta.quantity ?? line.quantity ?? 1;r.price.value=meta.price ?? (line.unit_rate_paise ?? line.unit_price_paise ?? 0)/100;r.tax.value=isAmul?(line.tax_paise || 0)/100:(line.gst_bps || 0)/100;r.free.value=line.free_quantity || 0;
  r.adjust.value=isAmul&&line.net_paise!==undefined?((line.net_paise-line.tax_paise)-Math.round(Number(r.qty.value)*Number(r.price.value)*100))/100:0;
  async function select(p,initial=false){
   const selection=++r.selection;r.loading=true;r.product=p;r.search.value='';showProducts();r.picker.value=String(p.id);const units=await api('/api/product-units/'+source+'/'+encodeURIComponent(p.id));if(r.selection!==selection)return;r.units=units;
   r.unit.innerHTML=r.units.map(u=>`<option value="${esc(u.code)}">${esc(u.label)} (×${u.factor})</option>`).join('');r.unit.value=initial&&r.units.some(u=>u.code===meta.code)?meta.code:'BASE';r.factor=r.units.find(u=>u.code===r.unit.value).factor;
   r.batch.innerHTML=(detail.batches || []).filter(b=>String(b.product_id)===String(p.id)).map(b=>`<option value="${esc(b.batch_id)}">${esc(b.batch_code || b.batch_id)} · ${b.stock_qty} stock</option>`).join('');if(initial)r.batch.value=line.batch_id;
   if(!initial){r.inclusive=!isAmul&&detail.invoice.channel==='RETAIL';r.price.value=(r.inclusive?p.mrp:p.price)/100;r.tax.value=isAmul?0:(p.gst || 0)/100;r.adjust.value=0;r.free.value=0;}
   r.basis.textContent=r.inclusive?'MRP · GST included':'Before GST';r.taxRate=Number(r.qty.value)*Number(r.price.value)>0?Number(r.tax.value)/(Number(r.qty.value)*Number(r.price.value)):0;r.loading=false;update();
  }
  function showProducts(){
   const matches=products.filter(p=>productKeywordMatch(p.name+' '+p.code+' '+(p.barcode || ''),r.search.value));
   r.picker.innerHTML='<option value="">Select / change product…</option>'+matches.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.code)} · ${p.stock ?? 0} stock</option>`).join('');
   r.picker.value=matches.some(p=>String(p.id)===String(r.product?.id))?String(r.product.id):'';
   r.matches.textContent=matches.length?matches.length+' matching products — select from dropdown':'No matching products. Try another keyword.';
  }
  r.selection=0;
  r.search.oninput=showProducts;
  r.search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();r.picker.focus();}};
  r.picker.onchange=()=>{const p=products.find(p=>String(p.id)===r.picker.value);if(p)select(p).catch(e=>{r.loading=false;r.product=null;toast(e.message,'error');});};
  showProducts();
  r.unit.onchange=()=>{const factor=r.units.find(u=>u.code===r.unit.value).factor;r.price.value=Number((Number(r.price.value)/r.factor*factor).toFixed(6));r.qty.value=Number((Number(r.qty.value)*r.factor/factor).toFixed(6));r.factor=factor;update();};
  for(const key of ['qty','price','tax'])r[key].oninput=()=>{if(isAmul){if(key==='tax')r.taxRate=Number(r.tax.value)/(Number(r.qty.value)*Number(r.price.value)||1);else if(key==='qty'||key==='price')r.tax.value=(Number(r.qty.value)*Number(r.price.value)*(r.taxRate || 0)).toFixed(2);}update();};
  r.remove.onclick=()=>{rows.splice(rows.indexOf(r),1);tr.remove();update();};
  r.packing.onclick=async()=>{if(!r.product)return toast('Select a product first.','error');const text=prompt('Packing definitions: one LABEL=base stock units per line. Base stays 1. Confirm against packaging; never guess BOX/CRT factors.',r.units.map(u=>u.label+'='+u.factor).join('\n'));if(text===null)return;try{const units=text.split('\n').filter(x=>x.trim()).map((s,i)=>{const [label,factor]=s.split('=');return {code:i?'PACK:'+i:'BASE',label:label.trim(),factor:Number(factor)};});const reason=prompt('Reason for packing change');if(!reason)return;await api('/api/product-units/'+source+'/'+encodeURIComponent(r.product.id),{method:'PATCH',body:{units,reason}});r.price.value=Number((Number(r.price.value)/r.factor).toFixed(6));r.qty.value=Number(r.qty.value)*r.factor;await select(r.product,true);}catch(e){toast(e.message,'error');}};
  const p=products.find(p=>String(p.id)===String(line.product_id));if(p)await select(p,true);else {r.qty.value=1;update();}
 }
 for(const line of detail.items)await add(line);
 $('#invoice-grid-add').onclick=()=>add().catch(e=>toast(e.message,'error'));
}
