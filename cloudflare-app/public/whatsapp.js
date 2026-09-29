const state={orders:[],customers:[],loaded:false,seenOrders:new Set(readArray('frostflow-seen-orders')),selectedOrder:null};
const $=selector=>document.querySelector(selector);
const query=new URLSearchParams(location.search);
const escapeHtml=value=>{const node=document.createElement('span');node.textContent=String(value??'');return node.innerHTML};
const normal=value=>String(value||'').toLocaleLowerCase();
const form=$('#chat-form');

function readArray(key){try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value:[]}catch{return[]}}
function saveSeen(){localStorage.setItem('frostflow-seen-orders',JSON.stringify([...state.seenOrders].slice(-1000)))}
async function api(path){const response=await fetch(path),raw=await response.text();let body;try{body=JSON.parse(raw)}catch{body={error:raw}}if(!response.ok)throw new Error(body.error||`HTTP ${response.status}`);return body}
function toast(message){const box=$('#toast');box.textContent=message;box.classList.add('show');setTimeout(()=>box.classList.remove('show'),2800)}
function formatDate(value){if(!value)return'—';const date=new Date(String(value).length===10?`${value}T00:00:00`:String(value).replace(' ','T')+'Z');return Number.isNaN(date.getTime())?'—':date.toLocaleDateString('en-IN')}
function normalizePhone(value){const digits=String(value||'').replace(/\D/g,'');return digits.length===10?`91${digits}`:digits}
function whatsappUrl(phone,message=''){const number=normalizePhone(phone);if(number.length<11)throw new Error('Enter a valid WhatsApp number with country code.');const url=new URL(`https://wa.me/${number}`);if(message.trim())url.searchParams.set('text',message.trim());return url.toString()}
function preparedMessage(type,name,reference,date){const customer=name||'Customer',ref=reference||'your order',when=date||'As scheduled';const messages={
  custom:`Hi ${customer},`,
  order_received:`Hi ${customer}, we received your order ${ref}. We will confirm stock and delivery shortly.\nExpected delivery: ${when}\n– MR Enterprises`,
  packed:`Hi ${customer}, your order ${ref} is packed and ready for dispatch.\nExpected delivery: ${when}\n– MR Enterprises`,
  out_for_delivery:`Hi ${customer}, your order ${ref} is out for delivery.\nExpected delivery: ${when}\n– MR Enterprises`,
  delivered:`Hi ${customer}, your order ${ref} has been delivered. Thank you for ordering from MR Enterprises.`,
  payment:`Hi ${customer}, this is a payment reminder for invoice ${ref}.\nDue date: ${when}\nPlease share the payment details after completion.\n– MR Enterprises`
};return messages[type]||messages.custom}
function refreshMessage(){const data=new FormData(form);form.elements.message.value=preparedMessage(data.get('message_type'),data.get('customer_name'),data.get('reference'),data.get('date'))}
function selectContact({name='',phone='',reference='',date='',type='custom'}={}){form.elements.customer_name.value=name;form.elements.phone.value=phone;form.elements.reference.value=reference;form.elements.date.value=date||'';form.elements.message_type.value=type;refreshMessage();form.scrollIntoView({behavior:'smooth',block:'start'})}

async function showSystemNotification(title,body,url){
  if(localStorage.getItem('frostflow-notifications-enabled')!=='true'||!('Notification'in window)||Notification.permission!=='granted')return;
  try{const registration=await navigator.serviceWorker.ready;await registration.showNotification(title,{body,tag:`frostflow-order-${url}`,renotify:true,data:{url}})}catch{}
}
function notificationUi(){const button=$('#enable-notifications'),status=$('#notification-status');if(!('Notification'in window)){button.disabled=true;button.textContent='Alerts unavailable';status.textContent='This browser does not expose notifications.';return}const enabled=localStorage.getItem('frostflow-notifications-enabled')==='true'&&Notification.permission==='granted';button.textContent=enabled?'Order alerts on':'Enable order alerts';button.classList.toggle('secondary',enabled);status.textContent=Notification.permission==='denied'?'Alerts are blocked in browser settings.':enabled?'New online orders are checked every 15 seconds while this page is running.':'Tap Enable order alerts and choose Allow.'}
async function toggleNotifications(){if(!('Notification'in window))return;if(localStorage.getItem('frostflow-notifications-enabled')==='true'&&Notification.permission==='granted'){localStorage.setItem('frostflow-notifications-enabled','false');notificationUi();toast('Order alerts turned off');return}const permission=await Notification.requestPermission();if(permission!=='granted'){notificationUi();toast('Notification permission was not allowed');return}localStorage.setItem('frostflow-notifications-enabled','true');await navigator.serviceWorker.register('/sw.js');notificationUi();await showSystemNotification('FrostFlow order alerts are ready','New online orders will open the customer chat.','/whatsapp/')}

function orderTrackingUrl(order){return order.public_token?`${location.origin}/order/?token=${encodeURIComponent(order.public_token)}`:''}
function orderMessage(order){const tracking=orderTrackingUrl(order),invoice=order.invoice_number?`\nInvoice: ${order.invoice_number}`:'';return `${preparedMessage('order_received',order.customer_name,order.order_number,order.delivery_date)}${invoice}${tracking?`\nTrack order and view invoice: ${tracking}`:''}`}
async function processOrderNotifications(orders){const fresh=[];for(const order of orders){if(state.loaded&&!state.seenOrders.has(order.id))fresh.push(order);state.seenOrders.add(order.id)}saveSeen();for(const order of fresh.slice(0,5)){let url='/whatsapp/';try{url=whatsappUrl(order.phone,orderMessage(order))}catch{}await showSystemNotification(`New order · ${order.order_number}`,order.customer_name||'A customer placed an order',url)}}

function renderOrders(){const term=normal($('#order-search').value.trim()),rows=state.orders.filter(order=>!term||normal(`${order.order_number} ${order.customer_name} ${order.phone} ${order.route_name}`).includes(term));$('#order-count').textContent=rows.length;$('#order-list').innerHTML=rows.map(order=>`<article class="launcher-row"><div><strong>${escapeHtml(order.customer_name||'Customer')}</strong><span>${escapeHtml(order.order_number||'Online order')} · ${escapeHtml(order.phone||'No number')}</span><small>${escapeHtml(order.route_name||'Unassigned route')} · Delivery ${escapeHtml(formatDate(order.delivery_date))}</small></div><button type="button" data-order-id="${escapeHtml(order.id)}" ${order.phone?'':'disabled'}>Prepare chat</button></article>`).join('')||'<p class="empty">No matching online orders.</p>'}
function renderCustomers(){const term=normal($('#customer-search').value.trim()),rows=state.customers.filter(customer=>!term||normal(`${customer.name} ${customer.mobile} ${customer.whatsapp_number} ${customer.route_name}`).includes(term));$('#customer-count').textContent=rows.length;$('#customer-list').innerHTML=rows.map(customer=>{const phone=customer.whatsapp_number||customer.mobile||'';return `<article class="launcher-row"><div><strong>${escapeHtml(customer.name)}</strong><span>${escapeHtml(phone||'No phone')}</span><small>${escapeHtml(customer.route_name||'Unassigned route')}</small></div><button type="button" data-customer-id="${escapeHtml(customer.id)}" ${phone?'':'disabled'}>Select</button></article>`}).join('')||'<p class="empty">No matching customers.</p>'}

async function loadData({quiet=false}={}){try{const [orderData,customerData]=await Promise.all([api('/api/orders'),api('/api/customers?limit=500')]);await processOrderNotifications(orderData.orders||[]);state.orders=orderData.orders||[];state.customers=customerData.customers||[];state.loaded=true;renderOrders();renderCustomers();$('#sync-status').textContent=`Live · checked ${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`;if(!quiet)toast('Orders and customers refreshed')}catch(error){$('#sync-status').textContent=`Could not refresh: ${error.message}`;if(!quiet)toast(error.message)}}

$('#order-search').addEventListener('input',renderOrders);
$('#customer-search').addEventListener('input',renderCustomers);
$('#order-list').addEventListener('click',event=>{const button=event.target.closest('[data-order-id]');if(!button)return;const order=state.orders.find(item=>item.id===button.dataset.orderId);if(order){selectContact({name:order.customer_name,phone:order.phone,reference:order.order_number,date:order.delivery_date,type:'order_received'});form.elements.message.value=orderMessage(order)}});
$('#customer-list').addEventListener('click',event=>{const button=event.target.closest('[data-customer-id]');if(!button)return;const customer=state.customers.find(item=>item.id===button.dataset.customerId);if(customer)selectContact({name:customer.name,phone:customer.whatsapp_number||customer.mobile,type:'custom'})});
form.elements.message_type.addEventListener('change',refreshMessage);
for(const name of ['customer_name','reference','date'])form.elements[name].addEventListener('change',refreshMessage);
form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);try{window.open(whatsappUrl(data.get('phone'),data.get('message')),'_blank','noopener');$('#chat-result').textContent='WhatsApp opened. Review the message and tap Send.'}catch(error){$('#chat-result').textContent=error.message}});
$('#refresh-whatsapp').addEventListener('click',()=>loadData());
$('#enable-notifications').addEventListener('click',()=>toggleNotifications().catch(error=>toast(error.message)));

if(query.get('name'))form.elements.customer_name.value=query.get('name');
if(query.get('phone'))form.elements.phone.value=query.get('phone');
if(query.get('message'))form.elements.message.value=query.get('message');else refreshMessage();
notificationUi();
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
await loadData({quiet:true});
setInterval(()=>loadData({quiet:true}),15_000);
