const CART_KEY = 'amul-cafe-cart-v1';
const NAME_KEY = 'amul-cafe-name-v1';
const ORDER_KEY = 'amul-cafe-last-order-v1';
const MAX_QUANTITY = 20;

const art = {
  'cold-coffees': ['☕', '#e9dfd0', '#7a5541'],
  'coffee-frappes': ['🥤', '#e7d8ca', '#76513a'],
  'dessert-frappes': ['🥤', '#eed9de', '#9b6575'],
  milkshakes: ['🥛', '#e8e2ef', '#786292'],
  thickshakes: ['🍫', '#e5d9cc', '#755743'],
  'signature-sundaes': ['🍨', '#f0dfc8', '#976f54'],
  'build-your-own-sundae': ['🍨', '#eee0d8', '#a26870'],
  sandwiches: ['🥪', '#e7e5cc', '#777b44'],
  burgers: ['🍔', '#f0dfc3', '#966c3f'],
  fries: ['🍟', '#f3e2c2', '#a57336'],
  momos: ['🥟', '#ede6d9', '#8a7562'],
  nuggets: ['🍗', '#efe0cb', '#a17349'],
  maggi: ['🍜', '#f2e5c8', '#9d783d'],
  mojitos: ['🍹', '#d9ede4', '#4c8b71'],
};
const statusSteps = [
  ['RECEIVED', 'Received'],
  ['PREPARING', 'Preparing'],
  ['READY', 'Ready'],
  ['COMPLETED', 'Done'],
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const money = amount => `₹${Number(amount || 0).toLocaleString('en-IN')}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function readStorage(key, fallback) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); }
  catch { return fallback; }
}
function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3000);
}
function openDialog(id) { const dialog = document.getElementById(id); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = document.getElementById(id); if (dialog.open) dialog.close(); }
function validTable(value) { return /^[a-zA-Z0-9][a-zA-Z0-9 -]{0,15}$/.test(value); }

const state = {
  menu: null,
  selectedCategory: 'all',
  search: '',
  cart: readStorage(CART_KEY, []),
  selectedItem: null,
  selectedCategoryData: null,
  quantity: 1,
  options: {},
  trackingToken: null,
  trackingUrl: null,
  pollTimer: null,
  requestId: null,
  requestCartSignature: null,
  requestPayloadSignature: null,
  placing: false,
  table: new URL(location.href).searchParams.get('table')?.trim() || '',
};
if (!Array.isArray(state.cart)) state.cart = [];
if (!validTable(state.table)) state.table = '';

function categories() { return state.menu?.categories || []; }
function categoryFor(itemId) { return categories().find(category => category.items.some(item => item.id === itemId)); }
function itemFor(itemId) { for (const category of categories()) { const item = category.items.find(entry => entry.id === itemId); if (item) return item; } return null; }
function itemCount() { return state.cart.reduce((total, line) => total + line.quantity, 0); }
function linePrice(line) { return unitPrice(itemFor(line.item_id), line.options || {}) * line.quantity; }
function cartTotal() { return state.cart.reduce((total, line) => total + linePrice(line), 0); }

function unitPrice(item, options) {
  if (!item) return 0;
  let price = Number(item.price || 0);
  for (const groupId of item.optionGroups || []) {
    const group = state.menu?.optionGroups?.[groupId];
    if (!group) continue;
    const selected = options[groupId];
    if (group.type === 'checkbox' && selected === true) price += Number(group.priceDelta || 0);
    if (group.type === 'single') price += Number(group.choices.find(choice => choice.id === selected)?.priceDelta || 0);
    if (groupId === 'sundae-extras' && Array.isArray(selected)) {
      for (const choice of group.choices) if (selected.includes(choice.id)) price += Number(choice.priceDelta || 0);
    }
  }
  return price;
}

function choiceName(groupId, value) {
  const group = state.menu?.optionGroups?.[groupId];
  const choice = group?.choices?.find(entry => typeof entry === 'object' && entry.id === value);
  return choice?.name || value;
}
function optionSummary(item, options) {
  if (!item) return '';
  const parts = [];
  for (const groupId of item.optionGroups || []) {
    const group = state.menu?.optionGroups?.[groupId];
    const selected = options[groupId];
    if (!group || selected == null || selected === false) continue;
    if (group.type === 'checkbox' && selected) parts.push(group.name);
    else if (groupId === 'sundae-size' || groupId === 'sundae-serving') parts.push(choiceName(groupId, selected));
    else if (groupId === 'sundae-flavors' && Array.isArray(selected)) parts.push(selected.join(', '));
    else if (groupId === 'sundae-sauce' && Array.isArray(selected)) parts.push(`${selected.join(' + ')} sauce`);
    else if (groupId === 'sundae-topping' && Array.isArray(selected)) parts.push(`${selected.join(' + ')} topping`);
    else if (groupId === 'sundae-extras' && Array.isArray(selected) && selected.includes('whipped-cream')) parts.push('Whipped cream');
  }
  return parts.join(' · ');
}

function updateCartUI() {
  if (state.requestCartSignature && state.requestCartSignature !== JSON.stringify(state.cart)) {
    state.requestId = null;
    state.requestCartSignature = null;
    state.requestPayloadSignature = null;
  }
  const count = itemCount();
  $('#cart-count').textContent = String(count);
  $('#mobile-cart-count').textContent = String(count);
  $('#mobile-cart-total').textContent = money(cartTotal());
  $('#mobile-cart').hidden = count === 0;
  writeStorage(CART_KEY, state.cart);
}

function renderCategories() {
  const nav = $('#category-nav');
  const chips = [{ id: 'all', name: 'All favourites' }, ...categories()];
  nav.innerHTML = chips.map(category => `<button class="category-chip" type="button" role="tab" aria-selected="${state.selectedCategory === category.id}" data-category="${escapeHtml(category.id)}">${escapeHtml(category.name)}</button>`).join('');
  $$('[data-category]', nav).forEach(button => button.addEventListener('click', () => {
    state.selectedCategory = button.dataset.category;
    renderCategories(); renderMenu();
    $('#menu').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));
}

function renderMenu() {
  const selected = categories().find(category => category.id === state.selectedCategory);
  const query = state.search.toLocaleLowerCase().trim();
  const entries = (selected ? [selected] : categories()).flatMap(category => category.items.map(item => ({ item, category })));
  const filtered = entries.filter(({ item, category }) => !query || `${item.name} ${item.description || ''} ${category.name}`.toLocaleLowerCase().includes(query));
  $('#category-kicker').textContent = query ? 'YOUR SEARCH' : selected ? 'FROM OUR MENU' : 'ALL FAVOURITES';
  $('#category-title').textContent = query ? 'Search results' : selected?.name || 'Everything good';
  $('#category-description').textContent = query ? `For “${state.search.trim()}”` : selected?.description || selected?.serving || '';
  $('#result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'items'}`;
  const grid = $('#menu-grid');
  if (!filtered.length) { grid.innerHTML = `<div class="empty-state"><strong>Nothing found yet</strong><p>Try another craving or browse all favourites.</p></div>`; return; }
  grid.innerHTML = filtered.map(({ item, category }, index) => {
    const [icon, bg, color] = art[category.id] || ['✳', '#e8eadd', '#526e56'];
    return `<article class="menu-card"><div class="card-art" style="--art-bg:${bg};--art-color:${color}"><span class="art-number">${String(index + 1).padStart(2, '0')}</span><span aria-hidden="true">${icon}</span></div><div class="card-copy"><span class="card-label">${escapeHtml(category.name)}${item.optional ? ' · SPECIAL' : ''}</span><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description || category.description || category.serving || 'Made fresh for you')}</p><div class="card-bottom"><strong>${money(item.price)}</strong><button class="card-add" type="button" data-item="${escapeHtml(item.id)}" aria-label="${item.optionGroups?.length ? 'Customize' : 'Add'} ${escapeHtml(item.name)}">+</button></div></div></article>`;
  }).join('');
  $$('[data-item]', grid).forEach(button => button.addEventListener('click', () => {
    const item = itemFor(button.dataset.item);
    if (!item) return;
    if (item.optionGroups?.length) openItem(item);
    else addToCart(item, {}, 1);
  }));
}

function defaultOptions(item) {
  const options = {};
  for (const groupId of item.optionGroups || []) {
    const group = state.menu?.optionGroups?.[groupId];
    if (!group) continue;
    if (group.type === 'checkbox') options[groupId] = false;
    else if (group.type === 'single') options[groupId] = group.choices[0].id;
    else if (groupId === 'sundae-flavors') options[groupId] = ['Vanilla'];
    else if (groupId === 'sundae-sauce') options[groupId] = [group.choices[0]];
    else if (groupId === 'sundae-topping') options[groupId] = [group.choices[0]];
    else options[groupId] = [];
  }
  return options;
}
function updateItemPrice() {
  $('#item-total').textContent = money(unitPrice(state.selectedItem, state.options) * state.quantity);
  $('#item-quantity').textContent = String(state.quantity);
  $('#item-minus').disabled = state.quantity <= 1;
  $('#item-plus').disabled = state.quantity >= MAX_QUANTITY;
}

function renderSundaeFlavors(group) {
  const size = state.options['sundae-size'] || 'single';
  const count = { single: 1, double: 2, triple: 3 }[size] || 1;
  const flavors = state.options['sundae-flavors'] || [];
  while (flavors.length < count) flavors.push(flavors[0] || group.choices[0]);
  flavors.length = count;
  state.options['sundae-flavors'] = flavors;
  return `<fieldset class="option-group"><legend>Choose ${count} ${count === 1 ? 'flavor' : 'flavors'}</legend>${flavors.map((flavor, index) => `<label class="flavor-row"><span>Scoop ${index + 1}</span><select data-flavor-index="${index}">${group.choices.map(choice => `<option value="${escapeHtml(choice)}" ${choice === flavor ? 'selected' : ''}>${escapeHtml(choice)}</option>`).join('')}</select></label>`).join('')}</fieldset>`;
}
function renderSundaeChoice(groupId, group) {
  const selected = state.options[groupId] || [group.choices[0]];
  const extras = state.options['sundae-extras'] || [];
  const extraKey = groupId === 'sundae-sauce' ? 'additional-sauce' : 'additional-topping';
  const hasExtra = extras.includes(extraKey);
  const title = groupId === 'sundae-sauce' ? 'Sauce' : 'Topping';
  return `<fieldset class="option-group"><legend>${title}</legend><small>One ${title.toLowerCase()} included. Add another if you like.</small><div class="extra-choice"><label>Included<select data-sundae-choice="${groupId}" data-choice-index="0">${group.choices.map(choice => `<option value="${escapeHtml(choice)}" ${choice === selected[0] ? 'selected' : ''}>${escapeHtml(choice)}</option>`).join('')}</select></label>${hasExtra ? `<label>Extra ${title.toLowerCase()}<select data-sundae-choice="${groupId}" data-choice-index="1">${group.choices.map(choice => `<option value="${escapeHtml(choice)}" ${choice === selected[1] ? 'selected' : ''}>${escapeHtml(choice)}</option>`).join('')}</select></label>` : ''}</div></fieldset>`;
}
function renderOptions() {
  const item = state.selectedItem;
  const html = [];
  for (const groupId of item.optionGroups || []) {
    const group = state.menu?.optionGroups?.[groupId];
    if (!group) continue;
    if (group.type === 'checkbox') {
      html.push(`<fieldset class="option-group"><legend>Extras</legend><label class="option-choice"><input type="checkbox" data-check-group="${groupId}" ${state.options[groupId] ? 'checked' : ''}><span>${escapeHtml(group.name)}</span><em>+${money(group.priceDelta)}</em></label></fieldset>`);
    } else if (group.type === 'single') {
      html.push(`<fieldset class="option-group"><legend>${escapeHtml(group.name)}</legend><div class="option-grid">${group.choices.map(choice => `<label class="option-choice"><input type="radio" name="${groupId}" data-single-group="${groupId}" value="${escapeHtml(choice.id)}" ${state.options[groupId] === choice.id ? 'checked' : ''}><span>${escapeHtml(choice.name)}</span>${choice.priceDelta ? `<em>+${money(choice.priceDelta)}</em>` : ''}</label>`).join('')}</div></fieldset>`);
    } else if (groupId === 'sundae-flavors') html.push(renderSundaeFlavors(group));
    else if (groupId === 'sundae-sauce' || groupId === 'sundae-topping') html.push(renderSundaeChoice(groupId, group));
    else if (groupId === 'sundae-extras') html.push(`<fieldset class="option-group"><legend>Make it extra special</legend><div class="option-grid">${group.choices.map(choice => `<label class="option-choice"><input type="checkbox" data-extra="${escapeHtml(choice.id)}" ${(state.options[groupId] || []).includes(choice.id) ? 'checked' : ''}><span>${escapeHtml(choice.name)}</span><em>+${money(choice.priceDelta)}</em></label>`).join('')}</div></fieldset>`);
  }
  $('#item-options').innerHTML = html.join('');
  updateItemPrice();
}
function openItem(item) {
  state.selectedItem = item;
  state.selectedCategoryData = categoryFor(item.id);
  state.quantity = 1;
  state.options = defaultOptions(item);
  const [icon, bg, color] = art[state.selectedCategoryData?.id] || ['✳', '#e8eadd', '#526e56'];
  $('#item-visual').style.cssText = `--art-bg:${bg};--art-color:${color}`;
  $('#item-icon').textContent = icon;
  $('#item-title').textContent = item.name;
  $('#item-category').textContent = `${state.selectedCategoryData?.name || ''}${item.optional ? ' · Special' : ''}`;
  $('#item-base-price').textContent = money(item.price);
  $('#item-description').textContent = item.description || state.selectedCategoryData?.description || '';
  $('#item-description').hidden = !$('#item-description').textContent;
  $('#item-error').textContent = '';
  renderOptions(); openDialog('item-dialog');
}

function addToCart(item, options, quantity) {
  const key = `${item.id}:${JSON.stringify(options)}`;
  const existing = state.cart.find(line => line.key === key);
  if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
  else state.cart.push({ key, item_id: item.id, options: JSON.parse(JSON.stringify(options)), quantity });
  updateCartUI();
  closeDialog('item-dialog');
  toast(`${item.name} added to cart`);
}

function renderCart() {
  const container = $('#cart-lines');
  if (!state.cart.length) {
    container.innerHTML = `<div class="empty-state"><strong>Your cart is waiting</strong><p>Add something delicious from the menu.</p></div>`;
  } else {
    container.innerHTML = state.cart.map((line, index) => {
      const item = itemFor(line.item_id);
      if (!item) return '';
      return `<div class="cart-line"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(optionSummary(item, line.options || {}))}</p></div><strong>${money(linePrice(line))}</strong><div class="cart-line-actions"><div class="cart-quantity"><button type="button" data-cart-minus="${index}" aria-label="Remove one ${escapeHtml(item.name)}">−</button><output>${line.quantity}</output><button type="button" data-cart-plus="${index}" aria-label="Add one ${escapeHtml(item.name)}">+</button></div><button type="button" class="remove-line" data-cart-remove="${index}">Remove</button></div></div>`;
    }).join('');
  }
  $('#cart-total').textContent = money(cartTotal());
  $('#checkout-button').disabled = !state.cart.length;
  $$('[data-cart-minus]', container).forEach(button => button.addEventListener('click', () => changeLine(Number(button.dataset.cartMinus), -1)));
  $$('[data-cart-plus]', container).forEach(button => button.addEventListener('click', () => changeLine(Number(button.dataset.cartPlus), 1)));
  $$('[data-cart-remove]', container).forEach(button => button.addEventListener('click', () => { state.cart.splice(Number(button.dataset.cartRemove), 1); updateCartUI(); renderCart(); }));
}
function changeLine(index, change) {
  const line = state.cart[index];
  if (!line) return;
  line.quantity += change;
  if (line.quantity <= 0) state.cart.splice(index, 1);
  else line.quantity = Math.min(MAX_QUANTITY, line.quantity);
  updateCartUI(); renderCart();
}
function openCart() { renderCart(); openDialog('cart-dialog'); }
function updateServiceForm() {
  const dineIn = $('input[name="service-type"]:checked')?.value === 'DINE_IN';
  $('#table-field').hidden = !dineIn;
  $('#table-number').required = dineIn;
}
function openCheckout() {
  if (!state.cart.length) return;
  closeDialog('cart-dialog');
  $('#customer-name').value = readStorage(NAME_KEY, '');
  $('#table-number').value = state.table;
  $('input[name="service-type"][value="DINE_IN"]').checked = true;
  updateServiceForm();
  $('#checkout-total').textContent = money(cartTotal());
  $('#checkout-error').textContent = '';
  if (!state.requestId) {
    state.requestId = randomId();
    state.requestCartSignature = JSON.stringify(state.cart);
  }
  openDialog('checkout-dialog');
}

async function submitOrder(event) {
  event.preventDefault();
  if (state.placing) return;
  const serviceType = $('input[name="service-type"]:checked')?.value || 'DINE_IN';
  const name = $('#customer-name').value.trim();
  const table = $('#table-number').value.trim();
  if (!name) { $('#checkout-error').textContent = 'Please enter your name.'; return; }
  if (serviceType === 'DINE_IN' && !validTable(table)) { $('#checkout-error').textContent = 'Please enter a table number (letters or numbers).'; return; }
  const body = {
    request_id: state.requestId || randomId(),
    customer_name: name,
    service_type: serviceType,
    table_number: serviceType === 'DINE_IN' ? table : undefined,
    note: $('#order-note').value.trim(),
    items: state.cart.map(line => ({ item_id: line.item_id, quantity: line.quantity, options: line.options || {} })),
  };
  const payloadSignature = JSON.stringify({ ...body, request_id: undefined });
  if (state.requestPayloadSignature && state.requestPayloadSignature !== payloadSignature) {
    state.requestId = randomId();
    body.request_id = state.requestId;
  }
  state.requestPayloadSignature = payloadSignature;
  state.placing = true;
  $('#place-order').disabled = true;
  $('#place-order').textContent = 'Placing your order…';
  $('#checkout-error').textContent = '';
  try {
    const response = await fetch('/api/cafe/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'We could not place your order. Please try again.');
    const token = result.tracking_token;
    if (!token) throw new Error('Your order may have been saved, but its tracking link was not returned. Please ask the café team for help before trying again.');
    writeStorage(NAME_KEY, name);
    if (serviceType === 'DINE_IN') state.table = table;
    state.cart = [];
    state.requestId = null;
    state.requestCartSignature = null;
    state.requestPayloadSignature = null;
    updateCartUI();
    closeDialog('checkout-dialog');
    writeStorage(ORDER_KEY, token);
    $('#latest-order').hidden = false;
    state.trackingToken = token;
    state.trackingUrl = result.tracking_url || `${location.origin}/?order=${encodeURIComponent(token)}`;
    const currentPage = new URL('/', location.origin);
    currentPage.searchParams.set('order', token);
    if (state.table) currentPage.searchParams.set('table', state.table);
    history.replaceState(null, '', currentPage);
    await showTracking(token);
  } catch (error) {
    $('#checkout-error').textContent = error.message || 'Something went wrong. Please try again.';
  } finally {
    state.placing = false;
    $('#place-order').disabled = false;
    $('#place-order').innerHTML = 'Place order <span aria-hidden="true">→</span>';
  }
}

function renderTracking(order) {
  const status = String(order.status || 'RECEIVED').toUpperCase();
  const labels = {
    RECEIVED: ['WE’VE GOT IT', 'Order received', 'Your order has reached the kitchen.'],
    PREPARING: ['IN THE MAKING', 'Being prepared', 'The kitchen is preparing your order.'],
    READY: ['COME & GET IT', 'Ready to enjoy', 'Your order is ready. Please collect it or wait at your table.'],
    COMPLETED: ['ENJOY!', 'All served', 'Thanks for ordering with us.'],
    CANCELLED: ['ORDER UPDATE', 'Order cancelled', 'Please speak to the café team if you have a question.'],
  };
  const [kicker, title, message] = labels[status] || labels.RECEIVED;
  $('#tracking-kicker').textContent = kicker;
  $('#tracking-title').innerHTML = `${escapeHtml(title)}<span class="title-dot">.</span>`;
  $('#tracking-message').textContent = message;
  $('#tracking-number').textContent = order.order_number || '—';
  $('#tracking-service').textContent = order.service_type === 'DINE_IN' ? `Table ${order.table_number || ''}` : 'Takeaway';
  $('#tracking-total').textContent = money(Number(order.total_paise || 0) / 100);
  const reached = statusSteps.findIndex(([key]) => key === status);
  $('#tracking-status').innerHTML = statusSteps.map(([key, label], index) => {
    const done = status === 'CANCELLED' ? false : index <= reached;
    const current = status === 'CANCELLED' ? false : index === reached;
    return `<div class="status-step ${done ? 'done' : ''} ${current ? 'current' : ''}"><span>${status === 'CANCELLED' && index === 0 ? '×' : done ? '✓' : index + 1}</span><small>${label}</small></div>`;
  }).join('');
  if (status === 'CANCELLED') $('.status-step')?.classList.add('cancelled');
}
async function loadTracking(token) {
  const response = await fetch(`/api/cafe/orders/${encodeURIComponent(token)}`, { cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'We could not load the order status.');
  renderTracking(result.order || result);
  $('#tracking-error').textContent = '';
}
async function showTracking(token) {
  state.trackingToken = token;
  state.trackingUrl = `${location.origin}/?order=${encodeURIComponent(token)}`;
  $('#tracking-error').textContent = '';
  openDialog('tracking-dialog');
  try { await loadTracking(token); }
  catch (error) { $('#tracking-error').textContent = error.message; }
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if ($('#tracking-dialog').open && state.trackingToken) loadTracking(state.trackingToken).catch(() => {}); }, 15000);
}

function wireEvents() {
  $('#menu-search').addEventListener('input', event => { state.search = event.target.value; if (state.search) { state.selectedCategory = 'all'; renderCategories(); } renderMenu(); });
  $('#header-cart').addEventListener('click', openCart);
  $('#mobile-cart').addEventListener('click', openCart);
  $('#checkout-button').addEventListener('click', openCheckout);
  $('#checkout-form').addEventListener('submit', submitOrder);
  $$('input[name="service-type"]').forEach(input => input.addEventListener('change', updateServiceForm));
  $('#item-minus').addEventListener('click', () => { state.quantity = Math.max(1, state.quantity - 1); updateItemPrice(); });
  $('#item-plus').addEventListener('click', () => { state.quantity = Math.min(MAX_QUANTITY, state.quantity + 1); updateItemPrice(); });
  $('#add-item').addEventListener('click', () => { if (state.selectedItem) addToCart(state.selectedItem, state.options, state.quantity); });
  $('#item-options').addEventListener('change', event => {
    const target = event.target;
    if (target.dataset.checkGroup) state.options[target.dataset.checkGroup] = target.checked;
    if (target.dataset.singleGroup) state.options[target.dataset.singleGroup] = target.value;
    if (target.dataset.flavorIndex !== undefined) state.options['sundae-flavors'][Number(target.dataset.flavorIndex)] = target.value;
    if (target.dataset.extra) {
      const extras = state.options['sundae-extras'] || [];
      if (target.checked && !extras.includes(target.dataset.extra)) extras.push(target.dataset.extra);
      if (!target.checked) extras.splice(extras.indexOf(target.dataset.extra), 1);
      state.options['sundae-extras'] = extras;
      const mapping = { 'additional-sauce': 'sundae-sauce', 'additional-topping': 'sundae-topping' };
      const groupId = mapping[target.dataset.extra];
      if (groupId) {
        const choices = state.options[groupId];
        if (target.checked) choices[1] = choices[0];
        else choices.length = 1;
      }
    }
    if (target.dataset.sundaeChoice) state.options[target.dataset.sundaeChoice][Number(target.dataset.choiceIndex)] = target.value;
    if (target.dataset.singleGroup === 'sundae-size' || target.dataset.extra) renderOptions();
    else updateItemPrice();
  });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.close)));
  $$('.sheet-dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  $('#tracking-dialog').addEventListener('close', () => clearInterval(state.pollTimer));
  $('#refresh-status').addEventListener('click', async () => { if (!state.trackingToken) return; $('#refresh-status').disabled = true; try { await loadTracking(state.trackingToken); toast('Status updated'); } catch (error) { $('#tracking-error').textContent = error.message; } finally { $('#refresh-status').disabled = false; } });
  $('#copy-tracking').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.trackingUrl || location.href); toast('Tracking link copied'); } catch { toast('You can copy the link from your browser'); } });
  $('#latest-order').addEventListener('click', () => { const token = readStorage(ORDER_KEY, null); if (token) showTracking(token); });
}

async function init() {
  wireEvents();
  updateCartUI();
  if (state.table) { $('#table-badge').textContent = `Dining at table ${state.table}`; $('#table-badge').hidden = false; }
  const latest = readStorage(ORDER_KEY, null);
  if (latest) $('#latest-order').hidden = false;
  try {
    const response = await fetch('/api/cafe/menu', { cache: 'no-store' });
    if (!response.ok) throw new Error('Menu temporarily unavailable');
    state.menu = await response.json();
    state.cart = state.cart.filter(line => itemFor(line?.item_id) && Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= MAX_QUANTITY && line.options && typeof line.options === 'object' && !Array.isArray(line.options));
    renderCategories(); renderMenu(); updateCartUI();
  } catch {
    $('#menu-grid').innerHTML = `<div class="empty-state"><strong>We couldn’t load the menu</strong><p>Please refresh this page in a moment.</p></div>`;
    return;
  }
  const token = new URL(location.href).searchParams.get('order');
  if (token && /^[a-f0-9]{48}$/i.test(token)) showTracking(token);
}

init();
