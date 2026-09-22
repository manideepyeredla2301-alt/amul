function retailerPercent(mrp,price){return Number(mrp)>0?Number(((1-Number(price)/Number(mrp))*100).toFixed(2)):'';}
let itemSheetState=null;
async function renderItemSheet() {
 setTitle('Item sheet','EXCEL-STYLE EDITING');
 if(!itemSheetState)itemSheetState={rows:await api('/api/pos/catalogue'),drafts:new Map(),query:'',page:0};
 const s=itemSheetState;
 const rows=s.rows.filter(r=>{const d=s.drafts.get(r.source+':'+r.id);return s.query.toLowerCase().trim().split(/\s+/).every(word=>((d?.name || r.name)+' '+r.code+' '+(r.barcode || '')+' '+r.source).toLowerCase().includes(word));});
 s.page=Math.min(s.page,Math.max(0,Math.ceil(rows.length/50)-1));
 const page=rows.slice(s.page*50,s.page*50+50);
 const fields=['name','mrp','price','retailerPercent','gst','active'];
 $('#view').innerHTML=heading('Edit items in rows and columns','Tab between cells or paste a block copied from Excel. Changes stay here until Save. Amul edits are local.',`<button class="button primary" id="sheet-save">Save ${s.drafts.size} changed rows</button><button class="button ghost" id="sheet-reload">Reload</button>`)+`<div class="pos-toolbar"><input class="search-input" id="sheet-query" value="${esc(s.query)}" placeholder="Type name, barcode or code — e.g. butt"><button class="button secondary" id="sheet-search">Search</button><button class="button ghost" id="sheet-prev" ${s.page===0?'disabled':''}>Previous</button><span>${rows.length? s.page*50+1:0}–${Math.min(rows.length,(s.page+1)*50)} / ${rows.length}</span><button class="button ghost" id="sheet-next" ${(s.page+1)*50>=rows.length?'disabled':''}>Next</button></div><div class="notice">MRP includes GST. Selling rate is the retailer/wholesale rate. Stock is shown for reference; use Inventory to adjust quantities. Active: 1 = yes, 0 = no. Retailer % = (MRP − listed retailer rate) ÷ MRP × 100. This is a discount from MRP, not a GST-adjusted profit margin. Changing % updates the rate; changing MRP or rate updates %. Amul GST cannot be changed here.</div><div class="table-wrap"><table class="item-sheet"><thead><tr><th>Source / code</th><th>Product name</th><th>MRP ₹</th><th>Retailer rate ₹</th><th>Retailer % off MRP</th><th>GST %</th><th>Active</th><th>Stock</th></tr></thead><tbody>${page.map((p,index)=>{const key=p.source+':'+p.id;const d=s.drafts.get(key)||{name:p.name,mrp:rupees(p.mrp),price:rupees(p.price),retailerPercent:retailerPercent(p.mrp,p.price),gst:p.gst==null?'':p.gst/100,active:p.active};return `<tr><td>${esc(p.source)}<div class="subtle">${esc(p.code)}</div></td>${fields.map((f,col)=>`<td><input data-row="${index}" data-col="${col}" data-field="${f}" value="${esc(d[f])}" ${f==='gst'&&p.source==='AMUL'?'readonly':''} style="min-width:${f==='name'?240:80}px;width:100%" aria-label="${esc(p.name+' '+f)}"></td>`).join('')}<td>${count(p.stock)}</td></tr>`;}).join('')}</tbody></table></div>`;
 const mark=input=>{const p=page[Number(input.dataset.row)],key=p.source+':'+p.id;
  const d=s.drafts.get(key)||{source:p.source,id:p.id,before:p,name:p.name,mrp:rupees(p.mrp),price:rupees(p.price),retailerPercent:retailerPercent(p.mrp,p.price),gst:p.gst==null?'':p.gst/100,active:p.active};
  d[input.dataset.field]=input.value;
  if(input.dataset.field==='retailerPercent'){
   const percent=Number(input.value),mrp=Number(d.mrp);
   input.setCustomValidity(input.value.trim()===''||!Number.isFinite(percent)||percent<0||percent>100||!Number.isFinite(mrp)||mrp<=0?'Enter 0–100% and a positive MRP.':'');
   if(input.validationMessage){input.reportValidity();return;}
   d.price=(Math.round(mrp*100*(1-percent/100))/100).toFixed(2);
  } else if(['mrp','price'].includes(input.dataset.field)){d.retailerPercent=retailerPercent(d.mrp,d.price);}
  for(const field of ['price','retailerPercent']){const cell=$('input[data-row="'+input.dataset.row+'"][data-field="'+field+'"]');if(cell!==input){cell.value=d[field];cell.setCustomValidity('');}}
  s.drafts.set(key,d);$('#sheet-save').textContent='Save '+s.drafts.size+' changed rows';
 };
 $('.item-sheet').addEventListener('input',e=>{if(e.target.matches('input[data-field]')&&!e.target.readOnly)mark(e.target);});
 $('.item-sheet').addEventListener('paste',e=>{
  if(!e.target.matches('input[data-field]'))return;
  const text=e.clipboardData.getData('text/plain');if(!/[\t\n]/.test(text))return;e.preventDefault();
  const values=text.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(r=>r.split('\t'));
  const row=Number(e.target.dataset.row),col=Number(e.target.dataset.col);
  if(row+values.length>page.length || values.some(r=>col+r.length>fields.length))return toast('Pasted block exceeds this page. Paste a smaller block.','error');
  values.forEach((r,i)=>r.forEach((value,j)=>{const cell=$(`input[data-row="${row+i}"][data-col="${col+j}"]`);if(!cell.readOnly){cell.value=value;mark(cell);}}));
 });
 const search=()=>{const input=$('#sheet-query'),position=input.selectionStart;s.query=input.value;s.page=0;renderItemSheet();const replacement=$('#sheet-query');replacement.focus();replacement.setSelectionRange(position,position);};
 $('#sheet-query').addEventListener('input',search);
 $('#sheet-search').onclick=search;
 $('#sheet-prev').onclick=()=>{s.page--;renderItemSheet();};
 $('#sheet-next').onclick=()=>{s.page++;renderItemSheet();};
 $('#sheet-reload').onclick=()=>{if(s.drafts.size&&!confirm('Discard unsaved cell edits and reload?'))return;itemSheetState=null;renderItemSheet();};
 $('#sheet-save').onclick=async()=>{
  if(!s.drafts.size)return;
  const invalid=$('.item-sheet input:invalid');if(invalid){invalid.reportValidity();return;}
  const button=$('#sheet-save');button.disabled=true;
  try {const result=await api('/api/pos/catalogue',{method:'PATCH',body:{rows:[...s.drafts.values()]}});itemSheetState=null;await refreshCatalogue();await renderItemSheet();toast(result.saved+' products saved.');}
  catch(error){toast(error.message,'error');button.disabled=false;}
 };
}
async function renderRoutes() {
 setTitle('Routes','RETAILER DELIVERY ROUTES');
 const routes=await api('/api/routes');
 $('#view').innerHTML=heading('Routes and retailers','All routes from the last successful Amul sync.',`<button class="button primary" data-action="amul-sync-now">Sync Amul</button>`)+dataTable('routes',['Route','Days','Status','Retailers'],routes,r=>`<tr><td><strong>${esc(r.name)}</strong><div class="subtle">${esc(r.code)}</div></td><td>${esc(r.days.join(', ') || 'Not specified')}</td><td>${badge(r.active?'ACTIVE':'INACTIVE')}</td><td><details><summary>${r.customers.length} retailers</summary>${r.customers.map(c=>`<div class="list-row"><div><strong>${esc(c.retailer_name)}</strong><small>${esc(c.retailer_code)} · ${esc(c.mobile || '')}</small><small>${esc(c.address || '')}</small></div><button class="button secondary small" data-action="amul-edit-retailer" data-id="${esc(c.retailer_id)}">Edit customer</button></div>`).join('')}</details></td></tr>`);
}
