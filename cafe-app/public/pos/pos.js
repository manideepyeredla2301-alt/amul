'use strict';

(() => {
  const DRAFT_KEY = 'amul-cafe-pos-draft-v1';
  const PENDING_KEY = 'amul-cafe-pos-pending-v1';
  const QUEUE_KEY = 'amul-cafe-pos-unsynced-v1';
  const MAX_QTY = 20;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const money = (rupees) => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  }).format(Number(rupees) || 0);
  const makeId = () => crypto.randomUUID ? crypto.randomUUID() :
    Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const read = (key, fallback) => {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };
  const initialDraft = read(DRAFT_KEY, {});
  const state = {
    catalog: { categories: [], optionGroups: {} },
    products: new Map(),
    categories: new Map(),
    cart: Array.isArray(initialDraft.cart) ? initialDraft.cart : [],
    serviceType: ['DINE_IN', 'TAKEAWAY', 'COUNTER'].includes(initialDraft.serviceType) ? initialDraft.serviceType : 'DINE_IN',
    tableNumber: initialDraft.tableNumber || '',
    customerName: initialDraft.customerName || '',
    note: initialDraft.note || '',
    scope: 'ALL',
    categoryId: 'ALL',
    query: '',
    role: '',
    username: '',
    online: navigator.onLine,
    holds: [],
    selected: null,
    editIndex: -1,
    options: {},
    itemNote: '',
    quantity: 1,
    payment: 'UNPAID',
    paymentMethods: [],
    submitting: false,
    pending: read(PENDING_KEY, null),
    uncertain: false,
    lastOrder: null,
    queue: Array.isArray(read(QUEUE_KEY, [])) ? read(QUEUE_KEY, []) : [],
    selectedQueueId: null,
    scanner: null,
  };
  if (state.pending?.body?.request_id) {
    state.uncertain = true;
    if (!state.cart.length) state.cart = (state.pending.body.items || []).map(line => ({
      ...line, key: `${line.item_id}:${JSON.stringify(line.options || {})}:${line.note || ''}`,
    }));
  }

  function notice(message, error = false) {
    const node = $('#notice');
    node.textContent = message;
    node.classList.toggle('error', error);
    node.hidden = !message;
    clearTimeout(notice.timer);
    if (message) notice.timer = setTimeout(() => { node.hidden = true; }, 5500);
  }
  function setOnline(online) {
    state.online = online;
    const connection = $('#connection');
    connection.className = `connection ${online ? 'online' : 'offline'}`;
    connection.innerHTML = `<i></i>${online ? 'Connected' : 'Offline'}`;
    $('#offline-banner').hidden = online;
    updateCart();
    renderQueue();
  }
  async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      setOnline(true);
    } catch (error) {
      setOnline(false);
      throw new Error('Connection interrupted. Check the network and retry.');
    } finally { clearTimeout(timer); }
    let data = {};
    const raw = await response.text();
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function canUsePos(role) { return ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER'].includes(String(role).toUpperCase()); }
  function showLogin(message = '') {
    $('#login-view').hidden = false;
    $('#app-view').hidden = true;
    $('#login-error').hidden = !message;
    $('#login-error').textContent = message;
  }
  function showApp(session) {
    state.role = String(session.role || '').toUpperCase();
    state.username = session.username || 'Staff';
    $('#staff-name').textContent = state.username;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#discount-amount').disabled = !['OWNER', 'ADMIN', 'MANAGER'].includes(state.role);
    restoreFields();
    updateCart();
  }
  function persistDraft() {
    save(DRAFT_KEY, {
      cart: state.cart, serviceType: state.serviceType,
      tableNumber: state.tableNumber, customerName: state.customerName, note: state.note,
    });
  }
  function restoreFields() {
    $('#table-number').value = state.tableNumber;
    $('#customer-name').value = state.customerName;
    $('#order-note').value = state.note;
    $$('.service-choice').forEach(button => {
      const active = button.dataset.service === state.serviceType;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#table-label').textContent = state.serviceType === 'DINE_IN' ? 'Table number' : 'Order reference';
    $('#table-number').placeholder = state.serviceType === 'DINE_IN' ? 'e.g. 04' : 'Optional';
  }
  function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }
  function categories() { return state.catalog.categories || []; }
  function imageUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), location.href);
      if (url.origin === location.origin || url.protocol === 'https:') return url.href;
    } catch {}
    return '';
  }
  function categoryImage(category) { return imageUrl(category.image_url || `/images/${category.id}.jpg`); }
  function productImage(product, category) { return imageUrl(product.image_url || (product.id === 'classic-veg-burger' || product.id === 'classic-chicken-burger' ? `/images/${product.id}.jpg` : categoryImage(category))); }
  function productType(product) { return String(product.type || 'PREPARED').toUpperCase() === 'RETAIL' ? 'RETAIL' : 'PREPARED'; }
  function productPrice(product) {
    if (Number.isFinite(Number(product.price))) return Number(product.price);
    return Math.max(0, Number(product.selling_price_paise || 0) / 100);
  }
  function productAvailable(product) { return product?.available !== false && product?.active !== false && product?.sold_out !== true; }
  function unitPrice(product, options) {
    if (!product) return 0;
    let value = productPrice(product);
    for (const id of product.optionGroups || []) {
      const group = state.catalog.optionGroups[id];
      const selected = options?.[id];
      if (!group) continue;
      if (group.type === 'checkbox' && selected === true) value += Number(group.priceDelta || 0);
      if (group.type === 'single') value += Number(group.choices.find(choice => choice.id === selected)?.priceDelta || 0);
      if (id === 'sundae-extras' && Array.isArray(selected)) {
        for (const choice of group.choices) if (selected.includes(choice.id)) value += Number(choice.priceDelta || 0);
      }
    }
    return value;
  }
  function optionSummary(product, options) {
    if (!product) return '';
    const parts = [];
    for (const id of product.optionGroups || []) {
      const group = state.catalog.optionGroups[id];
      const value = options?.[id];
      if (!group || !value || (Array.isArray(value) && !value.length)) continue;
      if (group.type === 'checkbox') parts.push(group.name);
      else if (group.type === 'single') parts.push(group.choices.find(choice => choice.id === value)?.name || value);
      else if (id === 'sundae-flavors') parts.push(value.join(', '));
      else if (id === 'sundae-sauce') parts.push(`${value.join(' + ')} sauce`);
      else if (id === 'sundae-topping') parts.push(`${value.join(' + ')} topping`);
      else if (id === 'sundae-extras') parts.push(value.map(choice => group.choices.find(entry => entry.id === choice)?.name || choice).join(', '));
    }
    return parts.join(' · ');
  }
  function cartTotal() {
    return state.cart.reduce((sum, line) =>
      sum + unitPrice(state.products.get(line.item_id), line.options || {}) * Number(line.quantity || 0), 0);
  }
  function cartCount() { return state.cart.reduce((sum, line) => sum + Number(line.quantity || 0), 0); }
  function renderCategories() {
    const visible = categories().filter(category => state.scope === 'ALL' ||
      (category.items || []).some(item => productType(item) === state.scope));
    $('#category-list').innerHTML = [
      `<button type="button" class="category-chip ${state.categoryId === 'ALL' ? 'active' : ''}" data-category="ALL">All categories</button>`,
      ...visible.map(category => `<button type="button" class="category-chip ${state.categoryId === category.id ? 'active' : ''}" data-category="${escapeHtml(category.id)}">${escapeHtml(category.name)}</button>`),
    ].join('');
  }
  function renderProducts() {
    const query = state.query.trim().toLocaleLowerCase();
    let products = [];
    for (const category of categories()) {
      if (state.categoryId !== 'ALL' && state.categoryId !== category.id) continue;
      for (const item of category.items || []) {
        if (state.scope !== 'ALL' && productType(item) !== state.scope) continue;
        if (query && !`${item.name} ${item.sku || ''} ${item.barcode || ''} ${category.name}`.toLocaleLowerCase().includes(query)) continue;
        products.push({ item, category });
      }
    }
    $('#product-heading').textContent = state.categoryId === 'ALL' ?
      (state.scope === 'RETAIL' ? 'Packaged ice cream' : state.scope === 'PREPARED' ? 'Café menu' : 'All products') :
      (state.categories.get(state.categoryId)?.name || 'Products');
    $('#product-count').textContent = `${products.length} product${products.length === 1 ? '' : 's'}`;
    $('#product-empty').hidden = products.length > 0;
    $('#product-empty-copy').textContent = state.scope === 'RETAIL' && !query ?
      'Add packaged Amul products in the admin panel, then they will appear here.' : 'Try another search or category.';
    $('#product-grid').innerHTML = products.map(({ item, category }) => {
      const type = productType(item);
      const available = productAvailable(item);
      const image = productImage(item, category);
      const description = item.pack_size || category.serving || item.description || '';
      return `<button class="product-card ${available ? '' : 'unavailable'}" type="button" data-item="${escapeHtml(item.id)}" ${available ? '' : 'disabled'} aria-label="${escapeHtml(item.name)} ${money(productPrice(item))}">
        <div class="product-art" style="background:${type === 'RETAIL' ? '#dfe8ee' : '#f1e4d4'}">
          ${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">` : '<span class="art-fallback">🍦</span>'}
          <span class="product-kind ${type === 'RETAIL' ? 'retail' : ''}">${type === 'RETAIL' ? 'Retail' : 'Fresh'}</span>
          ${available ? '' : '<span class="sold-out">Sold out</span>'}
        </div>
        <div class="product-info"><div><span class="product-name">${escapeHtml(item.name)}</span><small class="product-meta">${escapeHtml(description)}</small></div>
          <div class="product-price-row"><b>${money(productPrice(item))}</b><span class="product-add">+</span></div>
        </div></button>`;
    }).join('');
  }
  function renderCart() {
    const count = cartCount();
    $('#cart-count').textContent = String(count);
    $('#mobile-cart-count').textContent = String(count);
    $('#cart-total').textContent = money(cartTotal());
    $('#mobile-cart-total').textContent = money(cartTotal());
    $('#mobile-cart-toggle').hidden = count === 0;
    $('#cart-empty').hidden = count > 0;
    $('#cart-items').hidden = count === 0;
    $('#clear-cart').disabled = !count || state.uncertain;
    $('#hold-cart').disabled = !count || !state.online || state.uncertain;
    $('#checkout').disabled = !count || (state.uncertain && !state.online) ||
      state.cart.some(line => !productAvailable(state.products.get(line.item_id)));
    $('#checkout').firstChild.textContent = !state.online ? 'Save unsynced ' : state.uncertain ? 'Retry order ' : 'Checkout ';
    $('#checkout').classList.toggle('button-queue', !state.online);
    $('#checkout').classList.toggle('button-primary', state.online);
    $('#cart-items').innerHTML = state.cart.map((line, index) => {
      const product = state.products.get(line.item_id);
      const name = product?.name || line.name || 'Unavailable item';
      const price = product ? unitPrice(product, line.options || {}) * line.quantity : 0;
      return `<div class="cart-line">
        <div class="cart-line-top"><div><div class="cart-line-name">${escapeHtml(name)}</div><div class="cart-line-detail">${escapeHtml(optionSummary(product, line.options))}</div>
        ${line.note ? `<div class="cart-line-note">“${escapeHtml(line.note)}”</div>` : ''}</div><span class="cart-line-price">${money(price)}</span></div>
        <div class="cart-line-actions"><div class="line-qty"><button type="button" data-qty="minus" data-index="${index}" aria-label="Remove one ${escapeHtml(name)}" ${state.uncertain ? 'disabled' : ''}>−</button><span>${line.quantity}</span><button type="button" data-qty="plus" data-index="${index}" aria-label="Add one ${escapeHtml(name)}" ${state.uncertain ? 'disabled' : ''}>+</button></div>
        <div><button type="button" class="remove-line" data-edit="${index}" ${state.uncertain ? 'disabled' : ''}>Edit</button><button type="button" class="remove-line" data-remove="${index}" ${state.uncertain ? 'disabled' : ''}>Remove</button></div></div>
      </div>`;
    }).join('');
  }
  function updateCart() { persistDraft(); renderCart(); }

  function defaultOptions(product) {
    const choices = {};
    for (const id of product.optionGroups || []) {
      const group = state.catalog.optionGroups[id];
      if (!group) continue;
      if (group.type === 'checkbox') choices[id] = false;
      else if (group.type === 'single') choices[id] = group.choices?.[0]?.id || '';
      else if (id === 'sundae-flavors') choices[id] = ['Vanilla'];
      else if (id === 'sundae-sauce' || id === 'sundae-topping') choices[id] = [group.choices?.[0]];
      else choices[id] = [];
    }
    return choices;
  }
  function normalizeSundae() {
    if (state.selected?.id !== 'build-your-own-sundae') return;
    const opts = state.options;
    const cone = opts['sundae-serving'] === 'waffle-cone';
    if (cone) opts['sundae-size'] = 'single';
    const scoopCount = { single: 1, double: 2, triple: 3 }[opts['sundae-size']] || 1;
    const flavors = Array.isArray(opts['sundae-flavors']) ? opts['sundae-flavors'] : [];
    while (flavors.length < scoopCount) flavors.push(flavors[0] || 'Vanilla');
    opts['sundae-flavors'] = flavors.slice(0, scoopCount);
    const extras = Array.isArray(opts['sundae-extras']) ? opts['sundae-extras'] : [];
    opts['sundae-extras'] = cone ? [] : extras;
    for (const [id, extra] of [['sundae-sauce', 'additional-sauce'], ['sundae-topping', 'additional-topping']]) {
      const selected = Array.isArray(opts[id]) ? opts[id] : [];
      if (!selected.length) selected.push(state.catalog.optionGroups[id]?.choices?.[0] || '');
      opts[id] = selected.slice(0, cone || !opts['sundae-extras'].includes(extra) ? 1 : 2);
      if (!cone && opts['sundae-extras'].includes(extra) && opts[id].length < 2) opts[id].push(opts[id][0]);
    }
    if (cone && opts['sundae-topping'][0] === 'Jelly') {
      opts['sundae-topping'][0] = state.catalog.optionGroups['sundae-topping']?.choices?.find(choice => choice !== 'Jelly') || 'Cashews';
    }
  }
  function renderOptionGroups() {
    normalizeSundae();
    const product = state.selected;
    const groups = (product?.optionGroups || []).map(id => {
      const group = state.catalog.optionGroups[id];
      if (!group) return '';
      const value = state.options[id];
      if (group.type === 'checkbox') {
        return `<section class="option-group"><h3>${escapeHtml(group.name)} <small>Optional</small></h3><div class="option-choices"><button type="button" class="option-choice ${value ? 'selected' : ''}" data-check="${escapeHtml(id)}">${value ? '✓ ' : '+ '}${escapeHtml(group.name)} <span>+${money(group.priceDelta)}</span></button></div></section>`;
      }
      if (group.type === 'single') {
        const cone = state.options['sundae-serving'] === 'waffle-cone';
        return `<section class="option-group"><h3>${escapeHtml(group.name)} ${group.required ? '<small>Required</small>' : ''}</h3><div class="option-choices">${(group.choices || []).map(choice => {
          const disabled = cone && id === 'sundae-size' && choice.id !== 'single';
          return `<button type="button" class="option-choice ${choice.id === value ? 'selected' : ''}" data-single="${escapeHtml(id)}" data-value="${escapeHtml(choice.id)}" ${disabled ? 'disabled' : ''}>${escapeHtml(choice.name)} ${choice.priceDelta ? `<span>+${money(choice.priceDelta)}</span>` : ''}</button>`;
        }).join('')}</div></section>`;
      }
      if (id === 'sundae-flavors') {
        return `<section class="option-group"><h3>Ice cream flavours <small>One per scoop</small></h3><div class="select-grid">${(value || []).map((flavor, index) => `<label>Scoop ${index + 1}<select data-flavor="${index}">${(group.choices || []).map(choice => `<option ${choice === flavor ? 'selected' : ''} value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`).join('')}</select></label>`).join('')}</div></section>`;
      }
      if (id === 'sundae-sauce' || id === 'sundae-topping') {
        const title = id === 'sundae-sauce' ? 'Sauce' : 'Topping';
        const cone = state.options['sundae-serving'] === 'waffle-cone';
        const available = (group.choices || []).filter(choice => !cone || id !== 'sundae-topping' || choice !== 'Jelly');
        return `<section class="option-group"><h3>${title} <small>One included</small></h3><div class="select-grid">${(value || []).map((selected, index) => `<label>${index === 0 ? 'Included' : 'Extra'} ${title.toLowerCase()}<select data-sundae-choice="${id}" data-choice-index="${index}">${available.map(choice => `<option ${choice === selected ? 'selected' : ''} value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`).join('')}</select></label>`).join('')}</div></section>`;
      }
      if (id === 'sundae-extras') {
        const cone = state.options['sundae-serving'] === 'waffle-cone';
        return `<section class="option-group"><h3>Extras <small>Optional</small></h3><div class="option-choices">${(group.choices || []).map(choice => `<button type="button" class="option-choice ${(value || []).includes(choice.id) ? 'selected' : ''}" data-extra="${escapeHtml(choice.id)}" ${cone ? 'disabled' : ''}>${escapeHtml(choice.name)} <span>+${money(choice.priceDelta)}</span></button>`).join('')}</div>${cone ? '<small>Waffle cones allow one scoop, one sauce and one dry topping.</small>' : ''}</section>`;
      }
      if (group.type === 'multi') {
        return `<section class="option-group"><h3>${escapeHtml(group.name)}</h3><div class="option-choices">${(group.choices || []).map(choice => {
          const idValue = typeof choice === 'string' ? choice : choice.id;
          const name = typeof choice === 'string' ? choice : choice.name;
          return `<button type="button" class="option-choice ${(value || []).includes(idValue) ? 'selected' : ''}" data-multi="${escapeHtml(id)}" data-value="${escapeHtml(idValue)}">${escapeHtml(name)}</button>`;
        }).join('')}</div></section>`;
      }
      return '';
    });
    $('#item-option-groups').innerHTML = groups.join('');
    $('#item-option-groups').hidden = !groups.some(Boolean);
    const price = unitPrice(product, state.options) * state.quantity;
    $('#item-price').textContent = money(price);
    $('#item-quantity').textContent = String(state.quantity);
    $('#item-minus').disabled = state.quantity <= 1;
    $('#item-plus').disabled = state.quantity >= MAX_QTY;
  }
  function openItem(product, editIndex = -1) {
    if (!productAvailable(product)) { notice('This product is currently unavailable.', true); return; }
    state.selected = product;
    state.editIndex = editIndex;
    const line = editIndex >= 0 ? state.cart[editIndex] : null;
    state.options = line ? structuredClone(line.options || {}) : defaultOptions(product);
    state.itemNote = line?.note || '';
    state.quantity = line?.quantity || 1;
    $('#item-kind').textContent = productType(product) === 'RETAIL' ? 'PACKAGED RETAIL' : 'FRESHLY PREPARED';
    $('#item-title').textContent = product.name;
    $('#item-description').textContent = product.description || product.pack_size || '';
    $('#item-description').hidden = !$('#item-description').textContent;
    $('#item-note').value = state.itemNote;
    $('#item-error').hidden = true;
    $('#add-item').firstChild.textContent = editIndex >= 0 ? 'Update ' : 'Add ';
    renderOptionGroups();
    $('#item-dialog').showModal();
  }
  function addItem(product, options = {}, quantity = 1, note = '', editIndex = -1) {
    if (!productAvailable(product)) { notice('This product is currently unavailable.', true); return; }
    const cleanNote = String(note || '').trim().slice(0, 300);
    const key = `${product.id}:${JSON.stringify(options)}:${cleanNote}`;
    if (editIndex >= 0) state.cart.splice(editIndex, 1);
    const match = state.cart.find(line => line.key === key);
    if (match) match.quantity = Math.min(MAX_QTY, match.quantity + quantity);
    else state.cart.push({ key, item_id: product.id, name: product.name,
      quantity: Math.min(MAX_QTY, quantity), options: structuredClone(options), note: cleanNote });
    updateCart();
    if ($('#item-dialog').open) $('#item-dialog').close();
    notice(`${product.name} added to cart`);
  }
  function changeQuantity(index, delta) {
    const line = state.cart[index];
    if (!line) return;
    line.quantity += delta;
    if (line.quantity < 1) state.cart.splice(index, 1);
    else line.quantity = Math.min(MAX_QTY, line.quantity);
    updateCart();
  }
  function clearCart(keepFields = false) {
    state.cart = [];
    if (!keepFields) {
      state.customerName = '';
      state.tableNumber = '';
      state.note = '';
      restoreFields();
    }
    updateCart();
  }
  function validateCart() {
    if (!state.cart.length) throw new Error('Add a product before checkout.');
    if (state.cart.length > 30 || cartCount() > 100) throw new Error('This order is too large. Keep it to 30 lines and 100 items.');
    if (state.serviceType === 'DINE_IN' && !state.tableNumber.trim()) throw new Error('Enter a table number for dine-in orders.');
    if (state.tableNumber && !/^[a-zA-Z0-9][a-zA-Z0-9 -]{0,15}$/.test(state.tableNumber)) throw new Error('Use a short table or order reference.');
    if (state.cart.some(line => !productAvailable(state.products.get(line.item_id)))) throw new Error('Remove unavailable products before checkout.');
  }

  function checkoutSummary() {
    $('#checkout-summary').innerHTML = state.cart.map(line => {
      const product = state.products.get(line.item_id);
      return `<div class="summary-line"><span>${line.quantity} × ${escapeHtml(product?.name || line.name || 'Item')}</span><b>${money(unitPrice(product, line.options) * line.quantity)}</b></div>`;
    }).join('');
    $('#checkout-total').textContent = money(cartTotal());
  }
  function methodEnabled(method) { return state.paymentMethods.includes(method); }
  function renderPaymentMethods() {
    if (state.payment !== 'UNPAID' && state.payment !== 'SPLIT' && !methodEnabled(state.payment)) state.payment = 'UNPAID';
    if (state.payment === 'SPLIT' && state.paymentMethods.length < 2) state.payment = 'UNPAID';
    $$('.payment-choice').forEach(button => {
      const method = button.dataset.payment;
      button.hidden = method !== 'UNPAID' && (method === 'SPLIT' ? state.paymentMethods.length < 2 : !methodEnabled(method));
    });
    $('#later-payment-method').innerHTML = state.paymentMethods.map(method =>
      `<option value="${method}">${method === 'UPI' ? 'UPI' : method === 'CARD' ? 'Card' : 'Cash'}</option>`).join('');
    $('#record-payment').hidden = !state.paymentMethods.length;
    if (state.lastOrder) $('#record-payment').disabled = !state.paymentMethods.length ||
      String(state.lastOrder.payment_status || '').toUpperCase() === 'PAID';
    setPayment(state.payment);
  }
  function setPayment(method) {
    if (method !== 'UNPAID' && (method === 'SPLIT' ? state.paymentMethods.length < 2 : !methodEnabled(method))) method = 'UNPAID';
    state.payment = method;
    $$('.payment-choice').forEach(button => {
      button.classList.toggle('active', button.dataset.payment === method);
      button.setAttribute('aria-pressed', String(button.dataset.payment === method));
    });
    const fields = $('#payment-fields');
    fields.hidden = method === 'UNPAID';
    if (method === 'SPLIT') {
      fields.innerHTML = `<div class="split-row">${state.paymentMethods.map(allowed => `<label>${allowed === 'UPI' ? 'UPI' : allowed === 'CARD' ? 'Card' : 'Cash'} received<input data-split="${allowed}" type="number" min="0" step=".01" inputmode="decimal" placeholder="₹0"></label>`).join('')}</div><label>UPI / card reference<input id="split-reference" type="text" maxlength="100" placeholder="Optional"></label>`;
    } else if (method === 'UPI' || method === 'CARD') {
      fields.innerHTML = `<label>${method} reference <small>(optional)</small><input id="payment-reference" type="text" maxlength="100" placeholder="Transaction or terminal reference"></label>`;
    } else {
      fields.innerHTML = `<p class="muted">Record the payment after confirming it at the counter.</p>`;
    }
  }
  function openCheckout() {
    try { validateCart(); }
    catch (error) { notice(error.message, true); return; }
    checkoutSummary();
    setPayment(state.payment);
    $('#checkout-error').hidden = true;
    $('#checkout-error').textContent = '';
    $('#place-order').firstChild.textContent = state.uncertain ? 'Retry order ' : 'Create order ';
    if (state.uncertain) {
      $('#checkout-error').textContent = 'The previous checkout may have reached the server. Retry this same order to check safely.';
      $('#checkout-error').hidden = false;
      $$('.payment-choice').forEach(button => { button.disabled = true; });
    } else $$('.payment-choice').forEach(button => { button.disabled = false; });
    $('#checkout-dialog').showModal();
  }
  function rupeesToPaise(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error('Enter a valid payment amount.');
    return Math.round(amount * 100);
  }
  function paymentLines(discountPaise) {
    const method = state.payment;
    if (method === 'UNPAID') return [];
    if (method === 'SPLIT' ? state.paymentMethods.length < 2 : !methodEnabled(method)) throw new Error('This payment method is no longer available. Choose another method.');
    const estimated = Math.max(0, Math.round(cartTotal() * 100) - discountPaise);
    if (method === 'SPLIT') {
      const lines = $$('[data-split]').map(input => ({
        method: input.dataset.split, amount_paise: rupeesToPaise(input.value || 0),
      })).filter(line => line.amount_paise > 0);
      if (lines.some(line => !methodEnabled(line.method))) throw new Error('A split payment method is no longer available.');
      const total = lines.reduce((sum, line) => sum + line.amount_paise, 0);
      if (!total) throw new Error('Enter at least one split payment amount.');
      if (total > estimated) throw new Error('Payments cannot exceed the estimated total.');
      const reference = $('#split-reference')?.value.trim() || '';
      for (const line of lines) if (line.method !== 'CASH' && reference) line.reference = reference;
      return lines;
    }
    if (estimated <= 0) return [];
    const line = { method, amount_paise: estimated };
    const reference = $('#payment-reference')?.value.trim() || '';
    if (reference && method !== 'CASH') line.reference = reference;
    return [line];
  }
  function payloadForCheckout() {
    const discountPaise = $('#discount-amount').disabled ? 0 : rupeesToPaise($('#discount-amount').value || 0);
    if (discountPaise > Math.round(cartTotal() * 100)) throw new Error('Discount cannot exceed the estimated total.');
    return {
      request_id: makeId(),
      customer_name: state.customerName.trim(),
      service_type: state.serviceType,
      table_number: state.tableNumber.trim(),
      note: state.note.trim(),
      items: state.cart.map(line => ({
        item_id: line.item_id, quantity: Number(line.quantity), options: line.options || {}, note: line.note || '',
      })),
      payments: paymentLines(discountPaise),
      ...(discountPaise ? { discount_paise: discountPaise } : {}),
    };
  }
  function showReceipt(order) {
    state.lastOrder = order;
    const number = order.order_number || order.id || 'Order';
    $('#receipt-title').textContent = number;
    const total = Number(order.total_paise || 0) / 100;
    $('#receipt-subtitle').textContent = `${money(total)} · ${String(order.payment_status || 'UNPAID').replaceAll('_', ' ')}`;
    $('#record-payment').disabled = !state.paymentMethods.length || String(order.payment_status || '').toUpperCase() === 'PAID';
    $('#receipt-state').textContent = (order.has_prepared || state.cart.some(line => productType(state.products.get(line.item_id) || {}) === 'PREPARED')) ?
      'Fresh items have been sent to the kitchen. Print the bill when you are ready.' :
      'Retail sale saved. Stock is updated on the server. Print the bill when you are ready.';
    const url = `/api/cafe/pos/orders/${encodeURIComponent(order.id)}/receipt`;
    $('#print-receipt').disabled = true;
    $('#receipt-frame').src = url;
    $('#receipt-dialog').showModal();
  }

  async function saveLaterPayment() {
    const order = state.lastOrder;
    if (!order?.id) return;
    const errorNode = $('#later-payment-error');
    setError(errorNode, '');
    let amount;
    try {
      amount = rupeesToPaise($('#later-payment-amount').value);
      if (amount < 1) throw new Error('Enter an amount greater than zero.');
    } catch (error) { setError(errorNode, error.message); return; }
    const method = $('#later-payment-method').value;
    if (!methodEnabled(method)) { setError(errorNode, 'This payment method is no longer available.'); return; }
    const reference = $('#later-payment-reference').value.trim();
    const button = $('#save-payment');
    button.disabled = true;
    try {
      const result = await api(`/api/cafe/pos/orders/${encodeURIComponent(order.id)}/payments`, {
        method: 'POST', body: { method, amount_paise: amount, ...(reference && method !== 'CASH' ? { reference } : {}) },
      });
      const updated = result.order || result;
      state.lastOrder = { ...order, ...updated };
      $('#receipt-subtitle').textContent = `${money(Number(state.lastOrder.total_paise || 0) / 100)} · ${String(state.lastOrder.payment_status || 'PARTIAL').replaceAll('_', ' ')}`;
      $('#record-payment').disabled = String(state.lastOrder.payment_status || '').toUpperCase() === 'PAID';
      $('#receipt-state').textContent = 'Payment recorded. The receipt has been updated.';
      $('#receipt-frame').src = `/api/cafe/pos/orders/${encodeURIComponent(order.id)}/receipt?v=${Date.now()}`;
      $('#payment-dialog').close();
      notice('Payment recorded.');
    } catch (error) { setError(errorNode, error.message); }
    finally { button.disabled = false; }
  }

  async function submitCheckout() {
    if (state.submitting) return;
    let body;
    try {
      validateCart();
      body = state.uncertain && state.pending?.body ? state.pending.body : payloadForCheckout();
    } catch (error) {
      $('#checkout-error').textContent = error.message;
      $('#checkout-error').hidden = false;
      return;
    }
    state.pending = { body };
    save(PENDING_KEY, state.pending);
    state.submitting = true;
    const button = $('#place-order');
    button.disabled = true;
    button.firstChild.textContent = 'Saving order ';
    try {
      const order = await api('/api/cafe/pos/orders', { method: 'POST', body });
      localStorage.removeItem(PENDING_KEY);
      state.pending = null;
      state.uncertain = false;
      $('#checkout-dialog').close();
      showReceipt(order);
      clearCart();
      state.payment = 'UNPAID';
      setPayment('UNPAID');
      notice(`Order ${order.order_number || ''} saved successfully.`);
    } catch (error) {
      if (!error.status || error.status >= 500) {
        state.uncertain = true;
        $('#checkout-error').textContent = 'Could not confirm whether the order was saved. Please reconnect and retry this same order; it will not create a duplicate.';
      } else {
        state.pending = null;
        state.uncertain = false;
        localStorage.removeItem(PENDING_KEY);
        $('#checkout-error').textContent = error.message;
        if (error.status === 401 || error.status === 403) {
          $('#checkout-dialog').close();
          showLogin(error.status === 403 ? 'This account cannot use the counter.' : 'Session expired. Sign in to continue.');
        }
      }
      $('#checkout-error').hidden = false;
      updateCart();
    } finally {
      state.submitting = false;
      button.disabled = false;
      button.firstChild.textContent = state.uncertain ? 'Retry order ' : 'Create order ';
    }
  }
  function holdPayload() {
    return {
      cart: state.cart.map(({ item_id, quantity, options, note }) => ({ item_id, quantity, options, note })),
      customer_name: state.customerName.trim(),
      service_type: state.serviceType,
      table_number: state.tableNumber.trim(),
      note: state.note.trim(),
    };
  }
  async function loadHolds() {
    try {
      const result = await api('/api/cafe/pos/holds');
      state.holds = Array.isArray(result.holds) ? result.holds : [];
      $('#hold-count').textContent = String(state.holds.length);
      renderHolds();
    } catch (error) {
      if (error.status === 401 || error.status === 403) showLogin('Sign in to continue.');
      else notice(error.message, true);
    }
  }
  function renderHolds() {
    const list = $('#holds-list');
    if (!state.holds.length) {
      list.innerHTML = '<div class="holds-empty">No held carts yet. Hold an order here and resume it later on this or another device.</div>';
      return;
    }
    list.innerHTML = state.holds.map(hold => {
      const lines = Array.isArray(hold.cart) ? hold.cart : [];
      const details = lines.map(line => `${Number(line.quantity || 0)} × ${state.products.get(line.item_id)?.name || line.item_id}`).join(', ');
      const date = hold.created_at ? new Date(String(hold.created_at).replace(' ', 'T') + (String(hold.created_at).includes('Z') ? '' : 'Z')).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
      return `<div class="hold-row"><div class="hold-row-header"><strong>${escapeHtml(hold.table_number || hold.customer_name || 'Untitled cart')}</strong><small>${escapeHtml(date)}</small></div><p>${escapeHtml(details || 'Empty cart')}</p><div class="hold-row-actions"><button class="button button-primary" type="button" data-resume="${escapeHtml(hold.id)}">Resume</button><button class="button button-outline" type="button" data-delete-hold="${escapeHtml(hold.id)}">Remove</button></div></div>`;
    }).join('');
  }
  async function holdCurrentCart() {
    try {
      validateCart();
      const result = await api('/api/cafe/pos/holds', { method: 'POST', body: holdPayload() });
      clearCart();
      await loadHolds();
      notice(`Cart held${result.hold?.id ? ' and ready to resume' : ''}.`);
    } catch (error) { notice(error.message, true); }
  }
  async function resumeHold(id) {
    const hold = state.holds.find(entry => entry.id === id);
    if (!hold) return;
    if (state.cart.length && !confirm('Replace the current cart with this held cart?')) return;
    state.cart = Array.isArray(hold.cart) ? hold.cart.map(line => ({
      item_id: line.item_id, quantity: Number(line.quantity || 1),
      options: line.options || {}, note: line.note || '',
      name: state.products.get(line.item_id)?.name || line.item_id,
      key: `${line.item_id}:${JSON.stringify(line.options || {})}:${line.note || ''}`,
    })) : [];
    state.customerName = hold.customer_name || '';
    state.serviceType = ['DINE_IN', 'TAKEAWAY', 'COUNTER'].includes(hold.service_type) ? hold.service_type : 'DINE_IN';
    state.tableNumber = hold.table_number || '';
    state.note = hold.note || '';
    restoreFields();
    updateCart();
    $('#holds-dialog').close();
    try {
      await api(`/api/cafe/pos/holds/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadHolds();
      notice('Held cart resumed.');
    } catch (error) { notice('Cart restored, but its saved hold could not be removed. Remove the hold later.', true); }
  }
  async function deleteHold(id) {
    if (!confirm('Remove this held cart?')) return;
    try {
      await api(`/api/cafe/pos/holds/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadHolds();
      notice('Held cart removed.');
    } catch (error) { notice(error.message, true); }
  }
  async function loadCatalog() {
    const result = await api('/api/cafe/pos/catalog');
    state.catalog = { categories: Array.isArray(result.categories) ? result.categories : [], optionGroups: result.optionGroups || {} };
    state.paymentMethods = Array.isArray(result.payment_methods) ?
      ['CASH', 'UPI', 'CARD'].filter(method => result.payment_methods.includes(method)) : [];
    renderPaymentMethods();
    state.products.clear();
    state.categories.clear();
    for (const category of categories()) {
      state.categories.set(category.id, category);
      for (const product of category.items || []) state.products.set(product.id, product);
    }
    if (state.categoryId !== 'ALL' && !state.categories.has(state.categoryId)) state.categoryId = 'ALL';
    renderCategories();
    renderProducts();
    updateCart();
  }

  function persistQueue() {
    let saved = true;
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); }
    catch { saved = false; }
    renderQueue();
    return saved;
  }
  function queueLabel(status) {
    return { UNSYNCED: 'Not sent', UNCONFIRMED: 'Checking', NEEDS_REVIEW: 'Needs review', SYNCED: 'On server' }[status] || 'Not sent';
  }
  function renderQueue() {
    const pending = state.queue.filter(entry => entry.status !== 'SYNCED').length;
    $('#queue-count').textContent = String(pending);
    $('#queued-orders').classList.toggle('has-pending', pending > 0);
    const list = $('#queue-list');
    if (!state.queue.length) {
      list.innerHTML = '<div class="holds-empty">No unsynced orders. Offline orders saved on this device will appear here for manual review.</div>';
      return;
    }
    list.innerHTML = state.queue.slice().reverse().map(entry => {
      const itemCount = (entry.body?.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const date = new Date(entry.created_at || 0).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
      });
      const statusClass = entry.status === 'UNCONFIRMED' ? 'unconfirmed' :
        entry.status === 'NEEDS_REVIEW' ? 'review' : entry.status === 'SYNCED' ? 'synced' : '';
      return `<div class="hold-row"><div class="hold-row-header"><strong>${escapeHtml(entry.body?.table_number || entry.body?.customer_name || 'Walk-in order')}</strong><span class="queue-status ${statusClass}">${queueLabel(entry.status)}</span></div>
        <div class="queue-row-meta"><small>${escapeHtml(date)} · ${itemCount} item${itemCount === 1 ? '' : 's'} · ${money(Number(entry.expected_total_paise || 0) / 100)} estimated</small></div>
        <p>${escapeHtml(entry.last_error || (entry.status === 'SYNCED' ? entry.server_order?.order_number || 'Accepted by server' : 'Awaiting staff review and send.'))}</p>
        <div class="hold-row-actions">${entry.status === 'SYNCED' ?
          `<button class="button button-primary" type="button" data-queue-receipt="${escapeHtml(entry.id)}">Receipt</button><button class="button button-outline" type="button" data-queue-remove="${escapeHtml(entry.id)}">Dismiss</button>` :
          `<button class="button button-primary" type="button" data-queue-review="${escapeHtml(entry.id)}">Review ${state.online ? '& send' : ''}</button>${entry.status === 'UNCONFIRMED' ? '' : `<button class="button button-outline" type="button" data-queue-remove="${escapeHtml(entry.id)}">Remove</button>`}`}
        </div></div>`;
    }).join('');
  }
  function queueConflict(entry) {
    const issues = [];
    let blocking = false;
    for (const [index, line] of (entry.body?.items || []).entries()) {
      const product = state.products.get(line.item_id);
      const saved = entry.snapshot?.[index];
      if (!product) { issues.push(`${saved?.name || line.item_id} is no longer in the catalogue.`); blocking = true; continue; }
      if (!productAvailable(product)) { issues.push(`${product.name} is sold out or unavailable.`); blocking = true; continue; }
      const current = Math.round(unitPrice(product, line.options || {}) * 100);
      if (saved && current !== saved.unit_price_paise) {
        issues.push(`${product.name} changed from ${money(saved.unit_price_paise / 100)} to ${money(current / 100)} per item.`);
      }
    }
    return { issues, blocking };
  }
  function renderQueueReview() {
    const entry = state.queue.find(row => row.id === state.selectedQueueId);
    if (!entry) return;
    const conflict = queueConflict(entry);
    const body = entry.body || {};
    const context = body.service_type === 'DINE_IN' ? 'Dine in' : body.service_type === 'TAKEAWAY' ? 'Takeaway' : 'Counter sale';
    const name = body.customer_name || 'Walk-in';
    $('#queue-review-title').textContent = entry.status === 'UNCONFIRMED' ? 'Check this order' : 'Review offline order';
    $('#queue-review-content').innerHTML = `<h3>${escapeHtml(context)} · ${escapeHtml(body.table_number || name)}</h3>
      <p>Saved ${escapeHtml(new Date(entry.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}. No payment was recorded while offline. The server will calculate current prices, offers and stock.</p>
      ${(body.items || []).map((line, index) => {
        const saved = entry.snapshot?.[index];
        const product = state.products.get(line.item_id);
        return `<div class="queue-review-item"><span>${Number(line.quantity)} × ${escapeHtml(product?.name || saved?.name || line.item_id)}</span><b>${money((product ? unitPrice(product, line.options || {}) * line.quantity : Number(saved?.unit_price_paise || 0) * line.quantity / 100))}</b></div>`;
      }).join('')}
      <p><b>Original estimate: ${money(Number(entry.expected_total_paise || 0) / 100)}</b></p>
      ${conflict.issues.map(issue => `<p class="queue-warning">${escapeHtml(issue)}</p>`).join('')}
      ${entry.status === 'UNCONFIRMED' ? '<p class="queue-warning">A previous send may have succeeded. This retries the exact same request ID, so it cannot make a second order.</p>' : ''}
      ${entry.last_error && entry.status === 'NEEDS_REVIEW' ? `<p class="queue-warning">Last server response: ${escapeHtml(entry.last_error)}</p>` : ''}`;
    $('#queue-review-send').disabled = !state.online || conflict.blocking || entry.status === 'SYNCED';
    $('#queue-review-send').textContent = entry.status === 'UNCONFIRMED' ? 'Check & retry safely' : 'Send order now';
    $('#queue-review-edit').disabled = entry.status === 'UNCONFIRMED' || entry.status === 'SYNCED';
    setError($('#queue-review-error'), '');
  }
  function openQueueReview(id) {
    state.selectedQueueId = id;
    renderQueueReview();
    $('#queue-review-dialog').showModal();
  }
  function queueCurrentCart() {
    if (state.online) { openCheckout(); return; }
    if (state.uncertain) { notice('Resolve the prior checkout before saving another order.', true); return; }
    try { validateCart(); }
    catch (error) { notice(error.message, true); return; }
    if (state.queue.filter(entry => entry.status !== 'SYNCED').length >= 30) {
      notice('This device has 30 unsynced orders. Review and send them before saving another.', true); return;
    }
    if (!confirm('Save this order on this device only? It will not reach the kitchen, record payment or create a receipt until you review and send it online.')) return;
    const items = state.cart.map(line => ({ item_id: line.item_id, quantity: line.quantity, options: line.options || {}, note: line.note || '' }));
    const entry = {
      id: makeId(), created_at: new Date().toISOString(), status: 'UNSYNCED', last_error: '',
      body: { request_id: makeId(), customer_name: state.customerName.trim(), service_type: state.serviceType,
        table_number: state.tableNumber.trim(), note: state.note.trim(), items, payments: [] },
      snapshot: state.cart.map(line => ({
        item_id: line.item_id, name: state.products.get(line.item_id)?.name || line.name || line.item_id,
        unit_price_paise: Math.round(unitPrice(state.products.get(line.item_id), line.options || {}) * 100),
        type: productType(state.products.get(line.item_id) || {}),
      })),
      expected_total_paise: Math.round(cartTotal() * 100),
    };
    state.queue.push(entry);
    if (!persistQueue()) { state.queue.pop(); renderQueue(); notice('Could not save locally. Keep this page open and try again.', true); return; }
    clearCart();
    notice('Saved locally as unsynced. Review and send when connected.');
    $('#queue-dialog').showModal();
  }
  async function reconcileQueue() {
    if (!state.online || !state.queue.some(entry => entry.status !== 'SYNCED')) return;
    try {
      const result = await api('/api/cafe/pos/orders');
      const byRequest = new Map((result.orders || []).map(order => [order.request_id, order]));
      let changed = false;
      for (const entry of state.queue) {
        const matched = byRequest.get(entry.body?.request_id);
        if (matched && entry.status !== 'SYNCED') {
          entry.status = 'SYNCED';
          entry.server_order = matched;
          entry.last_error = '';
          changed = true;
        }
      }
      if (changed) { persistQueue(); if ($('#queue-review-dialog').open) renderQueueReview(); }
    } catch (error) { if (error.status === 401) showLogin('Sign in to continue.'); }
  }
  async function sendQueued() {
    const entry = state.queue.find(row => row.id === state.selectedQueueId);
    if (!entry || !state.online || entry.status === 'SYNCED') return;
    const button = $('#queue-review-send');
    const previousStatus = entry.status;
    let attempted = false;
    button.disabled = true;
    setError($('#queue-review-error'), '');
    try {
      await loadCatalog();
      const conflict = queueConflict(entry);
      if (conflict.blocking) {
        entry.status = 'NEEDS_REVIEW';
        entry.last_error = conflict.issues.join(' ');
        persistQueue();
        renderQueueReview();
        return;
      }
      await reconcileQueue();
      if (entry.status === 'SYNCED') {
        $('#queue-review-dialog').close();
        $('#queue-dialog').close();
        showReceipt({ ...entry.server_order, has_prepared: entry.snapshot?.some(item => item.type === 'PREPARED') });
        return;
      }
      entry.status = 'UNCONFIRMED';
      entry.last_error = 'Sending; keep this order until the server confirms it.';
      persistQueue();
      attempted = true;
      const result = await api('/api/cafe/pos/orders', { method: 'POST', body: entry.body });
      entry.status = 'SYNCED';
      entry.server_order = result;
      entry.last_error = '';
      persistQueue();
      $('#queue-review-dialog').close();
      $('#queue-dialog').close();
      showReceipt({ ...result, has_prepared: entry.snapshot?.some(item => item.type === 'PREPARED') });
      notice(`${result.order_number || 'Order'} accepted by server and sent to kitchen.`);
    } catch (error) {
      entry.status = !attempted ? previousStatus :
        !error.status || error.status >= 500 || error.status === 409 && /request ID/i.test(error.message) ? 'UNCONFIRMED' : 'NEEDS_REVIEW';
      entry.last_error = entry.status === 'UNCONFIRMED' ?
        'Server outcome is unknown. Check and retry this same order ID; do not create a new one.' : error.message;
      persistQueue();
      renderQueueReview();
      setError($('#queue-review-error'), entry.last_error);
    } finally { if ($('#queue-review-dialog').open) renderQueueReview(); }
  }
  function editQueued() {
    const index = state.queue.findIndex(row => row.id === state.selectedQueueId);
    const entry = state.queue[index];
    if (!entry || entry.status === 'UNCONFIRMED' || entry.status === 'SYNCED') return;
    if (state.cart.length && !confirm('Replace the current cart with this offline order?')) return;
    state.cart = (entry.body.items || []).map(line => ({
      ...line, name: state.products.get(line.item_id)?.name || line.item_id,
      key: `${line.item_id}:${JSON.stringify(line.options || {})}:${line.note || ''}`,
    }));
    state.serviceType = entry.body.service_type;
    state.tableNumber = entry.body.table_number;
    state.customerName = entry.body.customer_name;
    state.note = entry.body.note;
    state.queue.splice(index, 1);
    persistQueue();
    restoreFields();
    updateCart();
    $('#queue-review-dialog').close();
    $('#queue-dialog').close();
    notice('Loaded for editing. A changed order will receive a new request ID.');
  }
  function removeQueued(id) {
    const index = state.queue.findIndex(row => row.id === id);
    const entry = state.queue[index];
    if (!entry || entry.status === 'UNCONFIRMED') return;
    if (!confirm(entry.status === 'SYNCED' ? 'Dismiss this synchronized order from this device?' : 'Delete this unsynced order from this device?')) return;
    state.queue.splice(index, 1);
    persistQueue();
  }

  async function lookupBarcode(barcode) {
    if (!barcode) return;
    try {
      const result = await api(`/api/cafe/pos/lookup?barcode=${encodeURIComponent(barcode)}`);
      const product = result.product;
      if (!product?.id) throw new Error('No product found for this barcode.');
      state.products.set(product.id, product);
      if (!productAvailable(product)) throw new Error('This product is sold out.');
      if (product.optionGroups?.length) openItem(product);
      else addItem(product);
      $('#product-search').value = '';
      state.query = '';
      renderProducts();
    } catch (error) { notice(error.message, true); }
  }
  async function stopScanner() {
    if (!state.scanner) return;
    clearInterval(state.scanner.timer);
    for (const track of state.scanner.stream.getTracks()) track.stop();
    state.scanner = null;
    $('#scanner-wrap').hidden = true;
  }
  async function startScanner() {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
      $('#product-search').focus();
      notice('Camera scanning is unavailable here. Use a Bluetooth scanner or type the barcode.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = $('#scanner-video');
      video.srcObject = stream;
      await video.play();
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      $('#scanner-wrap').hidden = false;
      const timer = setInterval(async () => {
        try {
          const found = await detector.detect(video);
          if (found.length) {
            const barcode = found[0].rawValue;
            await stopScanner();
            await lookupBarcode(barcode);
          }
        } catch {}
      }, 350);
      state.scanner = { stream, timer };
    } catch {
      notice('Camera access was blocked. Type the barcode or use a scanner keyboard.', true);
    }
  }

  function closeMobileCart() { $('#cart-panel').classList.remove('open'); }
  function setError(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#login-form button[type="submit"]');
    button.disabled = true;
    setError($('#login-error'), '');
    try {
      const session = await api('/api/cafe/staff/login', {
        method: 'POST', body: { username: $('#username').value.trim(), password: $('#password').value },
      });
      $('#password').value = '';
      if (!canUsePos(session.role)) throw new Error('This account cannot use counter POS.');
      showApp(session);
      await Promise.all([loadCatalog(), loadHolds()]);
      if (state.uncertain && state.cart.length) openCheckout();
    } catch (error) { showLogin(error.message); }
    finally { button.disabled = false; }
  });
  $('#sign-out').addEventListener('click', async () => {
    if (state.cart.length && !confirm('Sign out? The current cart will remain saved on this device.')) return;
    try { await api('/api/cafe/staff/logout', { method: 'POST' }); }
    catch {}
    showLogin();
  });
  $$('.service-choice').forEach(button => button.addEventListener('click', () => {
    if (state.uncertain) { notice('Retry the pending checkout first.', true); return; }
    state.serviceType = button.dataset.service;
    restoreFields();
    persistDraft();
  }));
  $$('.scope-tab').forEach(button => button.addEventListener('click', () => {
    state.scope = button.dataset.scope;
    state.categoryId = 'ALL';
    $$('.scope-tab').forEach(tab => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    renderCategories();
    renderProducts();
  }));
  $('#category-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.categoryId = button.dataset.category;
    renderCategories();
    renderProducts();
  });
  $('#product-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderProducts();
  });
  $('#product-search').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = event.target.value.trim();
    if (value.length >= 6 && /^[A-Za-z0-9_-]+$/.test(value)) lookupBarcode(value);
  });
  $('#scan-button').addEventListener('click', startScanner);
  $('#scanner-close').addEventListener('click', stopScanner);
  $('#product-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-item]');
    if (!button || state.uncertain) return;
    const product = state.products.get(button.dataset.item);
    if (!product) return;
    if (product.optionGroups?.length) openItem(product);
    else addItem(product);
  });
  $('#cart-items').addEventListener('click', (event) => {
    if (state.uncertain) return;
    const qty = event.target.closest('[data-qty]');
    if (qty) { changeQuantity(Number(qty.dataset.index), qty.dataset.qty === 'plus' ? 1 : -1); return; }
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const index = Number(edit.dataset.edit);
      const product = state.products.get(state.cart[index]?.item_id);
      if (product) openItem(product, index);
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (remove) { state.cart.splice(Number(remove.dataset.remove), 1); updateCart(); }
  });
  $('#clear-cart').addEventListener('click', () => {
    if (state.uncertain) return;
    if (confirm('Clear this cart?')) clearCart();
  });
  for (const [selector, key] of [['#table-number', 'tableNumber'], ['#customer-name', 'customerName'], ['#order-note', 'note']]) {
    $(selector).addEventListener('input', (event) => {
      if (state.uncertain) { event.target.value = state[key]; return; }
      state[key] = event.target.value;
      persistDraft();
    });
  }
  $('#item-minus').addEventListener('click', () => {
    state.quantity = Math.max(1, state.quantity - 1); renderOptionGroups();
  });
  $('#item-plus').addEventListener('click', () => {
    state.quantity = Math.min(MAX_QTY, state.quantity + 1); renderOptionGroups();
  });
  $('#item-option-groups').addEventListener('click', (event) => {
    const button = event.target.closest('.option-choice');
    if (!button) return;
    if (button.dataset.check) state.options[button.dataset.check] = !state.options[button.dataset.check];
    else if (button.dataset.single) state.options[button.dataset.single] = button.dataset.value;
    else if (button.dataset.extra) {
      const current = new Set(state.options['sundae-extras'] || []);
      if (current.has(button.dataset.extra)) current.delete(button.dataset.extra); else current.add(button.dataset.extra);
      state.options['sundae-extras'] = [...current];
    } else if (button.dataset.multi) {
      const current = new Set(state.options[button.dataset.multi] || []);
      if (current.has(button.dataset.value)) current.delete(button.dataset.value); else current.add(button.dataset.value);
      state.options[button.dataset.multi] = [...current];
    }
    renderOptionGroups();
  });
  $('#item-option-groups').addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.flavor !== undefined) state.options['sundae-flavors'][Number(target.dataset.flavor)] = target.value;
    if (target.dataset.sundaeChoice) state.options[target.dataset.sundaeChoice][Number(target.dataset.choiceIndex)] = target.value;
    renderOptionGroups();
  });
  $('#item-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.selected) return;
    if (state.selected.id === 'build-your-own-sundae') {
      normalizeSundae();
      const opts = state.options;
      const size = { single: 1, double: 2, triple: 3 }[opts['sundae-size']];
      if ((opts['sundae-flavors'] || []).length !== size || !(opts['sundae-sauce'] || []).length || !(opts['sundae-topping'] || []).length) {
        setError($('#item-error'), 'Choose a flavour for every scoop, one sauce and one topping.');
        return;
      }
    }
    addItem(state.selected, state.options, state.quantity, $('#item-note').value, state.editIndex);
  });
  $('#item-dialog').addEventListener('close', () => { state.selected = null; state.editIndex = -1; });
  $('#hold-cart').addEventListener('click', holdCurrentCart);
  $('#held-orders').addEventListener('click', async () => {
    $('#holds-dialog').showModal();
    await loadHolds();
  });
  $('#holds-list').addEventListener('click', (event) => {
    const resume = event.target.closest('[data-resume]');
    const remove = event.target.closest('[data-delete-hold]');
    if (resume) resumeHold(resume.dataset.resume);
    if (remove) deleteHold(remove.dataset.deleteHold);
  });
  $('#checkout').addEventListener('click', () => {
    closeMobileCart();
    if (state.online) openCheckout();
    else queueCurrentCart();
  });
  $('#queued-orders').addEventListener('click', () => {
    renderQueue();
    $('#queue-dialog').showModal();
    if (state.online) reconcileQueue();
  });
  $('#queue-list').addEventListener('click', (event) => {
    const review = event.target.closest('[data-queue-review]');
    const receipt = event.target.closest('[data-queue-receipt]');
    const remove = event.target.closest('[data-queue-remove]');
    if (review) openQueueReview(review.dataset.queueReview);
    if (remove) removeQueued(remove.dataset.queueRemove);
    if (receipt) {
      const entry = state.queue.find(row => row.id === receipt.dataset.queueReceipt);
      if (!entry?.server_order?.id) return;
      $('#queue-dialog').close();
      showReceipt({ ...entry.server_order, has_prepared: entry.snapshot?.some(item => item.type === 'PREPARED') });
    }
  });
  $('#queue-review-send').addEventListener('click', sendQueued);
  $('#queue-review-edit').addEventListener('click', editQueued);
  $$('.payment-choice').forEach(button => button.addEventListener('click', () => {
    if (state.uncertain) return;
    setPayment(button.dataset.payment);
  }));
  $('#checkout-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCheckout();
  });
  $('#discount-amount').addEventListener('input', () => {
    const discount = Number($('#discount-amount').value || 0);
    $('#checkout-total').textContent = money(Math.max(0, cartTotal() - discount));
  });
  $('#receipt-frame').addEventListener('load', () => { $('#print-receipt').disabled = false; });
  $('#record-payment').addEventListener('click', () => {
    const order = state.lastOrder;
    if (!order?.id) return;
    const remaining = Math.max(0, Number(order.total_paise || 0) - Number(order.paid_paise || 0));
    $('#later-payment-amount').value = remaining ? (remaining / 100).toFixed(2) : '';
    $('#later-payment-reference').value = '';
    setError($('#later-payment-error'), '');
    $('#payment-dialog').showModal();
  });
  $('#later-payment-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveLaterPayment();
  });
  $('#print-receipt').addEventListener('click', () => {
    const frame = $('#receipt-frame');
    try { frame.contentWindow.print(); }
    catch { window.open(frame.src, '_blank', 'noopener'); }
  });
  $('#new-order').addEventListener('click', () => {
    $('#receipt-dialog').close();
    $('#product-search').focus();
  });
  $('#mobile-cart-toggle').addEventListener('click', () => $('#cart-panel').classList.add('open'));
  $('#close-mobile-cart').addEventListener('click', closeMobileCart);
  $('#cart-panel .cart-head').addEventListener('click', (event) => {
    if (window.innerWidth <= 820 && !event.target.closest('button')) closeMobileCart();
  });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => {
    const dialog = document.getElementById(button.dataset.close);
    if (dialog.open) dialog.close();
  }));
  window.addEventListener('online', () => {
    setOnline(true);
    loadCatalog().then(() => reconcileQueue()).catch(() => {});
    if (state.queue.some(entry => entry.status !== 'SYNCED')) notice('Offline orders need your review before sending.');
  });
  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('pagehide', stopScanner);
  setInterval(async () => {
    if ($('#app-view').hidden) return;
    try {
      await api('/api/cafe/health', { timeout: 8000 });
      if (!$('#item-dialog').open && !$('#checkout-dialog').open) await loadCatalog();
    } catch {}
  }, 45000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  async function start() {
    showLogin();
    setOnline(navigator.onLine);
    try {
      const session = await api('/api/cafe/staff/session');
      if (!canUsePos(session.role)) { showLogin('This account cannot use counter POS.'); return; }
      showApp(session);
      await Promise.all([loadCatalog(), loadHolds()]);
      if (state.uncertain && state.cart.length) {
        notice('Your last checkout needs confirmation. Retry it using the same order request.', true);
        openCheckout();
      }
    } catch (error) {
      if (!error.status) showLogin('Could not connect. Your cart is saved on this device; sign in when online.');
      else showLogin();
    }
  }
  start();
})();
