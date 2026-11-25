(() => {
  'use strict';

  const main = document.querySelector('#main');
  const appView = document.querySelector('#app-view');
  const toastNode = document.querySelector('#toast');
  let cartObserver = null;
  const state = { user: '', role: '', orders: [], cart: [], customers: [], products: [], categories: [], selectedCategory: '', productRequest: 0, productHasMore: false, selectedCustomer: null, currentOrder: null, currentDraft: null, customerTimer: null, productTimer: null };
  const statuses = { NEW: 'New', PICKING: 'Picking', HOLD: 'On hold', READY: 'Ready for draft', DRAFTED: 'Draft prepared', COMPLETED: 'Billed & closed', CANCELLED: 'Cancelled' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0) / 100);
  const rupees = value => (Number(value || 0) / 100).toFixed(2);
  const dateLabel = value => {
    if (!value) return '—';
    const text = String(value).replace(' ', 'T');
    const date = new Date(text.endsWith('Z') || /[+-]\d\d:\d\d$/.test(text) ? text : text + 'Z');
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function toast(message, error = false) {
    toastNode.textContent = String(message);
    toastNode.classList.toggle('error', error);
    toastNode.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toastNode.hidden = true; }, 5000);
  }
  function showApp(session) {
    state.user = session.user || '';
    state.role = session.role || 'STAFF';
    document.querySelector('#signed-in-as').textContent = state.user;
    document.querySelector('#back-to-frostflow').hidden = state.role !== 'OWNER';
    appView.hidden = false;
  }
  function setNav(view) {
    document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === view));
  }
  function setMain(html) {
    cartObserver?.disconnect();
    cartObserver = null;
    document.body.classList.remove('cart-jump-visible');
    main.innerHTML = html;
    window.scrollTo(0, 0);
  }
  function pageHead(kicker, title, description, actions = '') {
    return `<div class="page-head"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
  }
  function statusBadge(status) {
    const s = String(status || 'NEW').toUpperCase();
    return `<span class="pill ${esc(s)}">${esc(statuses[s] || s)}</span>`;
  }

  async function showOrders() {
    setNav('orders');
    setMain(pageHead('ORDER QUEUE', 'Orders to prepare', 'Phone and online requests, ready for your picking team.') + '<div class="empty">Loading orders…</div>');
    const rows = await api('/api/wholesale/orders');
    state.orders = Array.isArray(rows) ? rows : rows.orders || [];
    const counts = {
      active: state.orders.filter(o => ['NEW', 'PICKING'].includes(o.status)).length,
      hold: state.orders.filter(o => o.status === 'HOLD').length,
      ready: state.orders.filter(o => o.status === 'READY').length,
      drafted: state.orders.filter(o => o.status === 'DRAFTED').length,
    };
    const actions = '<button class="button secondary" type="button" data-action="import-online">Add existing online orders</button><button class="button primary" type="button" data-action="new-order">＋ Take an order</button>';
    setMain(pageHead('ORDER QUEUE', 'Orders to prepare', 'Work through each order, then prepare a draft from the items picked.', actions) +
      `<div class="summary-bar"><div class="summary-tile"><strong>${counts.active}</strong><span>To pick</span></div><div class="summary-tile"><strong>${counts.hold}</strong><span>On hold</span></div><div class="summary-tile"><strong>${counts.ready}</strong><span>Ready</span></div><div class="summary-tile"><strong>${counts.drafted}</strong><span>Drafts made</span></div></div>` +
      (state.orders.length ? `<div class="order-grid">${state.orders.map(orderCard).join('')}</div>` : '<div class="empty"><h2>No orders yet</h2><p>Take a phone order or add an existing FrostFlow Online order.</p><button class="button primary" type="button" data-action="new-order">Take an order</button></div>'));
  }

  function orderCard(o) {
    const total = Number(o.lineCount || 0), checked = Number(o.checkedCount || 0);
    const source = o.source === 'ONLINE' ? 'ONLINE' : 'PHONE';
    const hasDraft = o.draftId && state.role === 'OWNER';
    const action = hasDraft ? `<button class="button secondary" type="button" data-action="view-draft" data-id="${esc(o.draftId)}">${o.status === 'CANCELLED' ? 'View cancelled draft' : 'View invoice draft'}</button>` : `<button class="button secondary" type="button" data-action="open-order" data-id="${esc(o.id)}">${['DRAFTED', 'COMPLETED', 'CANCELLED'].includes(o.status) ? 'View checklist' : 'Open picking checklist'}</button>`;
    return `<article class="card order-card"><div class="order-card-top"><div><h3>${esc(o.customerName || 'Customer')}</h3><div class="order-number">${esc(o.orderNumber || `Order ${o.id}`)} · ${dateLabel(o.createdAt)}</div></div>${statusBadge(o.status)}</div><div class="order-meta"><span class="pill source ${source}">${source === 'ONLINE' ? 'Online' : 'Phone'}</span>${o.phone ? `<span class="pill source">${esc(o.phone)}</span>` : ''}</div><div class="progress-line">${checked} of ${total} items checked<div class="progress"><span style="width:${total ? Math.round(checked / total * 100) : 0}%"></span></div></div>${action}</article>`;
  }

  function openNew() {
    state.cart = []; state.selectedCustomer = null; state.products = []; state.customers = []; state.categories = []; state.selectedCategory = ''; state.productHasMore = false; state.productRequest += 1;
    setNav('new'); renderNew();
    document.querySelector('#customer-search')?.focus();
    void loadCategories().catch(error => toast(error.message, true));
    void searchProducts().catch(error => toast(error.message, true));
  }
  function renderNew() {
    const actions = '<button class="button secondary" type="button" data-action="back-orders">← Orders</button>';
    setMain(pageHead('PHONE ORDER', 'Take an order', 'Choose an existing retailer or enter customer details, then tap products to add them.', actions) +
      `<form id="order-form"><div class="split-layout"><div>
        <section class="card card-pad"><div class="card-header"><h2>1. Customer</h2></div>
          <div class="field"><label for="customer-search">Find an existing customer</label><input id="customer-search" autocomplete="off" placeholder="Name, code or phone"><p class="hint">Select a match to use its MR Enterprises details.</p></div>
          <div id="customer-results" class="search-results"></div><div id="selected-customer">${selectedCustomerHTML()}</div>
          <div id="manual-customer" ${state.selectedCustomer ? 'hidden' : ''}><p class="subtle">Or enter a new customer for this order</p><div class="field-grid">
            <div class="field"><label for="customer-name">Customer name *</label><input id="customer-name" name="customerName" maxlength="120"></div>
            <div class="field"><label for="customer-phone">Phone</label><input id="customer-phone" name="phone" type="tel" maxlength="20"></div>
            <div class="field full"><label for="customer-address">Address</label><textarea id="customer-address" name="address" maxlength="500"></textarea></div>
            <div class="field"><label for="customer-gstin">GSTIN</label><input id="customer-gstin" name="gstin" maxlength="15" autocapitalize="characters"></div>
          </div></div>
        </section>
        <section class="card card-pad products-panel"><div class="card-header"><h2>2. Products</h2><span class="subtle">Tap to add</span></div>
          <div class="field"><label for="product-search">Find a product</label><input id="product-search" type="search" autocomplete="off" placeholder="Search name, SKU or product ID"><p class="hint">Products and prices are from the latest FrostFlow Online catalogue.</p></div>
          <div id="product-categories" class="product-categories" aria-label="Product categories"></div>
          <div id="product-results" class="product-tiles" aria-live="polite"><p class="hint">Loading products…</p></div>
          <p id="product-results-note" class="hint results-note"></p><div id="product-load-more" class="load-more-area"></div>
        </section>
      </div><div class="sticky-card" id="order-cart"><section class="card card-pad"><div class="card-header"><h2>3. Order list</h2><span id="cart-count" class="subtle"></span></div><div id="cart-list" class="cart-list"></div><div id="cart-total"></div><div class="field" style="margin-top:15px"><label for="order-notes">Order notes</label><textarea id="order-notes" name="notes" placeholder="Delivery instructions or details from the phone call"></textarea></div><button id="save-order" class="button primary wide" type="submit">Save order & start picking</button></section></div></div></form><button id="mobile-cart-jump" class="mobile-cart-jump" data-action="jump-to-cart" type="button" aria-controls="order-cart"><span>Order list · <strong id="mobile-cart-count">0 items</strong></span><span aria-hidden="true">↓</span></button>`);
    renderCart();
    renderCategoryChips();
    document.body.classList.add('cart-jump-visible');
    if ('IntersectionObserver' in window) {
      cartObserver = new IntersectionObserver(([entry]) => {
        const jump = document.querySelector('#mobile-cart-jump');
        if (jump) jump.hidden = entry.isIntersecting;
        document.body.classList.toggle('cart-jump-visible', !entry.isIntersecting);
      }, { rootMargin: '0px 0px -64px 0px' });
      cartObserver.observe(document.querySelector('#order-cart'));
    }
  }
  function selectedCustomerHTML() {
    const c = state.selectedCustomer;
    return c ? `<div class="selection"><div><strong>${esc(c.name)}</strong><small>${esc([c.code, c.routeName, c.phone].filter(Boolean).join(' · '))}</small></div><button class="button small" type="button" data-action="clear-customer">Change</button></div>` : '';
  }
  function renderCustomerMatches(rows) {
    const target = document.querySelector('#customer-results'); if (!target) return;
    state.customers = Array.isArray(rows) ? rows : rows.customers || [];
    target.innerHTML = state.customers.length ? state.customers.slice(0, 20).map(c => `<button class="search-result" type="button" data-action="select-customer" data-key="${esc(c.key)}"><strong>${esc(c.name)}</strong><small>${esc([c.code, c.routeName, c.phone].filter(Boolean).join(' · '))}</small></button>`).join('') : '<p class="hint">No matching customers. Enter the customer details above.</p>';
  }
  function renderCategoryChips() {
    const target = document.querySelector('#product-categories'); if (!target) return;
    const categories = [{ id: '', name: 'All products' }, ...state.categories];
    target.innerHTML = categories.map(category => `<button class="category-chip ${state.selectedCategory === category.id ? 'active' : ''}" type="button" data-action="select-category" data-category="${esc(category.id)}" aria-pressed="${state.selectedCategory === category.id}">${esc(category.name)}${category.count == null ? '' : `<span>${esc(category.count)}</span>`}</button>`).join('');
  }
  function renderProductMatches(rows, append = false) {
    const target = document.querySelector('#product-results'); if (!target) return;
    const page = Array.isArray(rows) ? rows : rows.products || [];
    state.products = append ? state.products.concat(page) : page;
    state.productHasMore = page.length === 60;
    target.innerHTML = state.products.length ? state.products.map(product => {
      const baseUnit = product.units?.[0]?.label || 'unit';
      const price = Number(product.pricePaise) > 0 ? money(product.pricePaise) : 'Set price';
      return `<button class="product-tile" type="button" data-action="add-product" data-key="${esc(product.key)}" aria-label="Add ${esc(product.name)} to order">
        <span class="product-tile-top"><span class="product-category">${esc(product.category || 'Product')}</span><span class="product-tile-add" aria-hidden="true">＋</span></span>
        <span class="product-tile-name">${esc(product.name)}</span>
        <span class="product-tile-sku">${esc(product.sku || product.key)}</span>
        <span class="product-tile-bottom"><span class="product-tile-rate">${price}<small> / ${esc(baseUnit)}</small></span><span class="product-tile-stock">${product.stockQty == null ? 'Stock —' : `Stock ${esc(product.stockQty)}`}</span></span>
      </button>`;
    }).join('') : '<p class="empty product-empty">No matching products. Try another search or category.</p>';
    const note = document.querySelector('#product-results-note');
    if (note) note.textContent = `${state.products.length} product${state.products.length === 1 ? '' : 's'} shown${state.productHasMore ? '. Load more or search by name or code.' : ''}`;
    const loadMore = document.querySelector('#product-load-more');
    if (loadMore) loadMore.innerHTML = state.productHasMore ? '<button class="button secondary wide" type="button" data-action="load-more-products">Load more products</button>' : '';
  }
  function renderCart() {
    const list = document.querySelector('#cart-list'), count = document.querySelector('#cart-count'), total = document.querySelector('#cart-total');
    if (!list) return;
    count.textContent = `${state.cart.length} item${state.cart.length === 1 ? '' : 's'}`;
    const mobileCount = document.querySelector('#mobile-cart-count');
    if (mobileCount) mobileCount.textContent = count.textContent;
    list.innerHTML = state.cart.length ? state.cart.map((line, index) => {
      const units = line.product.units?.length ? line.product.units : [{ code: 'BASE', label: 'PC', factor: 1 }];
      const unit = units.find(u => u.code === line.unitCode) || units[0];
      const rate = line.manualRatePaise == null ? Number(line.product.pricePaise || 0) * Number(unit.factor || 1) : line.manualRatePaise;
      return `<div class="cart-item"><div class="cart-item-top"><div><h3>${esc(line.product.name)}</h3><small>${esc(line.product.sku || line.product.key)}</small></div><button class="remove" type="button" data-action="remove-cart" data-index="${index}">Remove</button></div><div class="cart-item-grid"><div class="field"><label for="cart-qty-${index}">Qty</label><input id="cart-qty-${index}" data-cart-field="quantity" data-index="${index}" type="number" min="1" step="1" value="${esc(line.quantity)}"></div><div class="field"><label for="cart-unit-${index}">Unit</label><select id="cart-unit-${index}" data-cart-field="unitCode" data-index="${index}">${units.map(u => `<option value="${esc(u.code)}" ${u.code === line.unitCode ? 'selected' : ''}>${esc(u.label)}${Number(u.factor) > 1 ? ` (${esc(u.factor)} stock units)` : ""}</option>`).join('')}</select></div><div class="field"><label for="cart-rate-${index}">Rate ₹ / unit</label><input id="cart-rate-${index}" data-cart-field="rate" data-index="${index}" type="number" min="0" step=".01" value="${rupees(rate)}"></div></div>${Number(rate) <= 0 ? '<p class="price-note">Price is missing. Set the rate before preparing an invoice draft.</p>' : ''}</div>`;
    }).join('') : '<p class="empty">Search and add products to this order.</p>';
    const subtotal = state.cart.reduce((sum, line) => {
      const unit = line.product.units?.find(u => u.code === line.unitCode) || { factor: 1 };
      const rate = line.manualRatePaise == null ? Number(line.product.pricePaise || 0) * Number(unit.factor || 1) : line.manualRatePaise;
      return sum + rate * Number(line.quantity || 0);
    }, 0);
    total.innerHTML = `<div class="totals-line"><span>Estimated before tax</span><strong>${money(subtotal)}</strong></div><p class="hint">Final draft uses only the quantities you check as picked.</p>`;
    document.querySelector('#save-order').disabled = !state.cart.length;
  }

  async function showOrder(id, nextUnchecked = false) {
    setNav('orders');
    setMain(pageHead('PICKING CHECKLIST', 'Loading order…', ''));
    const order = await api(`/api/wholesale/orders/${encodeURIComponent(id)}`);
    state.currentOrder = order;
    renderOrder(order);
    if (nextUnchecked) document.querySelector('.pick-card[data-checked="false"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function renderOrder(order) {
    const lines = order.lines || [], checked = lines.filter(line => line.pickedQuantity !== null && line.pickedQuantity !== undefined).length;
    const picked = lines.filter(line => Number(line.pickedQuantity) > 0).length;
    const finished = ['DRAFTED', 'COMPLETED', 'CANCELLED'].includes(order.status);
    const readOnly = finished || order.status === 'READY';
    const topActions = `<button class="button secondary" type="button" data-action="back-orders">← Orders</button>`;
    const owner = state.role === 'OWNER';
    const draftButton = owner && order.draftId ? `<button class="button secondary" type="button" data-action="view-draft" data-id="${esc(order.draftId)}">View invoice draft</button>` : '';
    const cancelButton = owner ? `<button class="button danger" type="button" data-action="cancel-order" data-id="${esc(order.id)}">Cancel order</button>` : '';
    const completeButton = owner ? `<button class="button primary" type="button" data-action="complete-order" data-id="${esc(order.id)}">Record final invoice & close</button>` : '';
    const closeoutHelp = order.source === 'ONLINE'
      ? 'Use this only after the final invoice is issued in Windows billing and its stock sync has run. Recording it here releases the original online stock reservation; it does not create an invoice.'
      : 'Use this only after the final invoice is issued in Windows billing and its stock sync has run. Recording it here closes the checklist; it does not create an invoice.';
    let actions = '';
    if (order.status === 'COMPLETED') actions = `${draftButton}<p class="hint">Final invoice ${esc(order.externalInvoiceNumber || 'recorded')} was issued in Windows billing. This checklist is closed.</p>`;
    else if (order.status === 'CANCELLED') actions = `${draftButton}<p class="hint">Cancelled: ${esc(order.cancelReason || 'No reason recorded.')}</p>`;
    else if (order.status === 'DRAFTED') actions = `${draftButton || '<p class="hint">The owner has prepared the invoice draft.</p>'}${completeButton}${cancelButton}${owner ? `<p class="hint">${closeoutHelp}</p>` : ''}`;
    else if (order.status === 'READY') actions = `${owner ? `<button class="button primary" type="button" data-action="prepare-draft" data-id="${esc(order.id)}">Prepare invoice draft</button>` : '<p class="hint">The order is ready. The owner can prepare its invoice draft.</p>'}<button class="button secondary" type="button" data-action="set-status" data-id="${esc(order.id)}" data-status="PICKING">Return to picking</button>${cancelButton}`;
    else actions = `${order.status === 'HOLD' ? `<button class="button secondary" type="button" data-action="set-status" data-id="${esc(order.id)}" data-status="PICKING">Resume picking</button>` : `<button class="button secondary" type="button" data-action="set-status" data-id="${esc(order.id)}" data-status="HOLD">Put on hold</button>`}<button class="button primary" type="button" data-action="set-status" data-id="${esc(order.id)}" data-status="READY" ${checked < lines.length || picked === 0 ? 'disabled' : ''}>Mark ready for draft</button>${cancelButton}`;
    setMain(pageHead(order.source === 'ONLINE' ? 'ONLINE ORDER' : 'PHONE ORDER', order.customerName || 'Customer order', `${order.orderNumber || `Order ${order.id}`} · ${dateLabel(order.createdAt)}`, topActions) +
      `<div class="split-layout"><div><section class="card card-pad detail-head"><div class="status-row">${statusBadge(order.status)}<span class="pill source ${order.source === 'ONLINE' ? 'ONLINE' : 'PHONE'}">${esc(order.source === 'ONLINE' ? 'Online' : 'Phone')}</span></div><div class="detail-stats"><div><small>Items checked</small><strong>${checked} / ${lines.length}</strong></div><div><small>Picked items</small><strong>${picked}</strong></div><div><small>Phone</small><strong>${esc(order.phone || '—')}</strong></div><div><small>Address</small><strong>${esc(order.address || '—')}</strong></div></div>${order.notes ? `<p class="subtle"><strong>Order note:</strong> ${esc(order.notes)}</p>` : ''}</section><div class="section-heading"><div><h2>Pick one item at a time</h2><p class="subtle">Check the full amount or enter what you actually picked.</p></div></div><div class="checklist">${lines.map(line => pickCard(line, readOnly)).join('')}</div></div><div class="sticky-card"><section class="card card-pad"><h2>Finish this order</h2><p class="subtle">${checked < lines.length ? `${lines.length - checked} item${lines.length - checked === 1 ? '' : 's'} still need a pick count.` : 'All items have a pick count.'}</p><div class="progress"><span style="width:${lines.length ? Math.round(checked / lines.length * 100) : 0}%"></span></div><div class="detail-actions" style="margin-top:18px">${actions}</div>${order.status === 'READY' ? '<p class="hint" style="margin-top:12px">The draft will show picked quantities only. It does not post an invoice to the billing database.</p>' : ''}</section></div></div>`);
  }
  function pickCard(line, readOnly) {
    const picked = line.pickedQuantity, checked = picked !== null && picked !== undefined;
    const partial = checked && Number(picked) < Number(line.requestedQuantity);
    return `<article class="card card-pad pick-card ${checked ? partial ? 'partial' : 'checked' : ''}" data-line-card="${esc(line.id)}" data-checked="${checked}">
      <div class="card-header"><div><h3>${esc(line.name)}</h3><div class="subtle">${esc(line.sku || line.productKey)} · ${esc(line.unitLabel || 'PC')}</div></div><span class="pill ${checked ? partial ? 'PICKING' : 'READY' : 'NEW'}">${checked ? partial ? 'Partial' : 'Checked' : 'Not checked'}</span></div>
      <p class="requested">Requested: <strong>${esc(line.requestedQuantity)} ${esc(line.unitLabel || 'PC')}</strong> · Rate ${money(line.unitPricePaise)} / ${esc(line.unitLabel || 'PC')}</p>
      <div class="pick-form">
        <label class="pick-all"><input data-pick-all type="checkbox" ${checked && Number(picked) === Number(line.requestedQuantity) ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>Picked all ${esc(line.requestedQuantity)} ${esc(line.unitLabel || 'PC')}</label>
        <div class="field"><label for="picked-${esc(line.id)}">Picked quantity</label><input id="picked-${esc(line.id)}" data-picked-input type="number" min="0" max="${esc(line.requestedQuantity)}" step="1" value="${checked ? esc(picked) : ''}" placeholder="0 to ${esc(line.requestedQuantity)}" ${readOnly ? 'disabled' : ''}></div>
        <div class="field"><label for="rate-${esc(line.id)}">Unit rate ₹</label><input id="rate-${esc(line.id)}" data-rate-input type="number" min="0" step=".01" value="${rupees(line.unitPricePaise)}" ${readOnly ? 'disabled' : ''}></div>
        <div class="field reason"><label for="shortage-${esc(line.id)}">Shortage / skip reason ${partial ? '*' : '(if needed)'}</label><input id="shortage-${esc(line.id)}" data-shortage-input value="${esc(line.shortageReason || '')}" placeholder="Out of stock, damaged pack, customer changed order…" maxlength="250" ${readOnly ? 'disabled' : ''}></div>
        <button class="button secondary" type="button" data-action="save-pick" data-line="${esc(line.id)}" ${readOnly ? 'disabled' : ''}>Save item</button>
      </div>${Number(line.unitPricePaise || 0) <= 0 ? '<p class="pick-warning">No rate is recorded. Enter one before preparing a draft.</p>' : ''}
    </article>`;
  }

  async function showDraft(id, supplied) {
    setNav('orders');
    setMain(pageHead('INVOICE DRAFT', 'Loading draft…', ''));
    const draft = supplied || await api(`/api/wholesale/drafts/${encodeURIComponent(id)}`);
    state.currentDraft = draft;
    renderDraft(draft);
  }
  function renderDraft(draft) {
    const owner = state.role === 'OWNER';
    const canClose = owner && draft.orderStatus === 'DRAFTED';
    const actions = '<button class="button secondary" type="button" data-action="back-orders">← Orders</button><button class="button primary" type="button" data-action="print-draft">Print / save PDF</button>' +
      (canClose ? `<button class="button secondary" type="button" data-action="complete-order" data-id="${esc(draft.orderId)}">Record final invoice & close</button><button class="button danger" type="button" data-action="cancel-order" data-id="${esc(draft.orderId)}">Cancel order</button>` : '');
    const statusBanner = draft.orderStatus === 'CANCELLED'
      ? `<p class="draft-screen-note review-banner cancelled"><strong>Cancelled order</strong>${esc(draft.cancelReason || 'This order was cancelled.')}. This draft is void for billing.</p>`
      : draft.orderStatus === 'COMPLETED'
        ? `<p class="draft-screen-note review-banner"><strong>Final invoice recorded</strong>${esc(draft.externalInvoiceNumber || '')} was issued in Windows billing. This page remains a draft copy.</p>`
        : `<p class="draft-screen-note review-banner"><strong>Draft only</strong>This document does not create a tax invoice or deduct stock.${draft.taxReviewNeeded ? ' GST rates on Amul items still need confirmation.' : ''}${canClose ? ' Issue the final invoice in Windows billing, wait for stock sync, then record its number here.' : ''}</p>`;
    const ribbon = draft.orderStatus === 'CANCELLED' ? 'CANCELLED DRAFT · DO NOT BILL' : 'INVOICE DRAFT · NOT POSTED';
    const footerNote = draft.orderStatus === 'CANCELLED'
      ? `Cancelled order: ${draft.cancelReason || 'no reason recorded'}. This draft must not be used as a bill.`
      : draft.orderStatus === 'COMPLETED'
        ? `Final invoice ${draft.externalInvoiceNumber || ''} was issued in Windows billing. This document remains a draft copy.`
        : 'Confirm prices and GST in the billing system before issuing a final invoice.';
    setMain(pageHead('INVOICE DRAFT', 'Invoice draft', `From order ${draft.orderNumber || draft.orderId}. Review before entering it in your billing system.`, actions) +
      `${statusBanner}<section class="invoice-sheet" id="invoice-sheet"><div class="draft-ribbon">${esc(ribbon)}</div><div class="invoice-top"><div><h2>${esc(draft.companyName || 'MR ENTERPRISES')}</h2><p>${draft.companyGstin ? `GSTIN: ${esc(draft.companyGstin)}<br>` : ''}${esc(draft.companyAddress || 'Wholesale order picking summary')}${draft.companyPhone ? `<br>${esc(draft.companyPhone)}` : ''}</p></div><div class="invoice-number"><strong>${esc(draft.draftNumber || `Draft ${draft.id}`)}</strong><br>Prepared ${esc(dateLabel(draft.createdAt))}<br>Order ${esc(draft.orderNumber || draft.orderId)}</div></div><div class="invoice-address"><div><small>BILL TO</small><strong>${esc(draft.customerName || 'Customer')}</strong><p>${esc(draft.address || '')}</p><p>${esc(draft.phone || '')}</p>${draft.gstin ? `<p>GSTIN: ${esc(draft.gstin)}</p>` : ''}</div><div><small>PREPARED FROM</small><strong>Picked items only</strong><p>The order checklist records requested quantities and any shortages.</p></div></div><div class="invoice-table-wrap"><table class="invoice-table"><thead><tr><th>Item</th><th class="numeric">Qty</th><th class="numeric">Rate</th><th class="numeric">GST</th><th>Amount</th></tr></thead><tbody>${(draft.lines || []).map(line => `<tr><td><strong>${esc(line.name)}</strong><br><span class="subtle">${esc(line.sku || '')}</span></td><td class="numeric">${esc(line.quantity)} ${esc(line.unitLabel || 'PC')}</td><td class="numeric">${money(line.unitPricePaise)}</td><td class="numeric">${(Number(line.gstBps || 0) / 100).toFixed(2)}%</td><td>${money(line.totalPaise)}</td></tr>`).join('')}</tbody></table></div><div class="invoice-totals"><div><span>Subtotal</span><strong>${money(draft.subtotalPaise)}</strong></div><div><span>${draft.taxReviewNeeded ? 'Provisional GST' : 'Estimated GST'}</span><strong>${money(draft.taxPaise)}</strong></div><div class="grand"><span>Provisional draft total</span><strong>${money(draft.totalPaise)}</strong></div></div><p class="draft-note">${esc(footerNote)}</p></section>`);
  }

  async function searchCustomers() {
    const q = document.querySelector('#customer-search')?.value.trim(); if (q === undefined) return;
    const rows = await api(`/api/wholesale/customers?q=${encodeURIComponent(q)}`);
    if (document.querySelector('#customer-search')?.value.trim() === q) renderCustomerMatches(rows);
  }
  async function loadCategories() {
    const rows = await api('/api/wholesale/categories');
    state.categories = Array.isArray(rows) ? rows : rows.categories || [];
    renderCategoryChips();
  }
  async function searchProducts({ append = false } = {}) {
    const q = document.querySelector('#product-search')?.value.trim(); if (q === undefined) return;
    const category = state.selectedCategory;
    const offset = append ? state.products.length : 0;
    const request = ++state.productRequest;
    const rows = await api(`/api/wholesale/catalog?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&offset=${offset}`);
    if (request === state.productRequest && document.querySelector('#product-search')?.value.trim() === q && state.selectedCategory === category) renderProductMatches(rows, append);
  }

  async function handleMainClick(event) {
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    const { action, id, line, index, key, status } = button.dataset;
    try {
      if (action === 'back-orders') return await showOrders();
      if (action === 'new-order') return openNew();
      if (action === 'jump-to-cart') return document.querySelector('#order-cart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (action === 'import-online') {
        button.disabled = true; button.textContent = 'Importing synced orders…';
        const result = await api('/api/wholesale/import-online', { method: 'POST', body: {} });
        toast(`${result.imported || 0} online order${result.imported === 1 ? '' : 's'} added.${result.moreAvailable ? ' Tap Add existing online orders again for the rest.' : ''}`);
        return await showOrders();
      }
      if (action === 'select-customer') {
        state.selectedCustomer = state.customers.find(c => c.key === key) || null;
        document.querySelector('#selected-customer').innerHTML = selectedCustomerHTML();
        document.querySelector('#manual-customer').hidden = !!state.selectedCustomer;
        document.querySelector('#customer-results').innerHTML = '';
        return;
      }
      if (action === 'clear-customer') {
        state.selectedCustomer = null;
        document.querySelector('#selected-customer').innerHTML = '';
        document.querySelector('#manual-customer').hidden = false;
        document.querySelector('#customer-search').focus();
        return;
      }
      if (action === 'select-category') {
        if (state.selectedCategory === button.dataset.category) return;
        state.selectedCategory = button.dataset.category || '';
        state.productRequest += 1;
        renderCategoryChips();
        state.products = [];
        document.querySelector('#product-results').innerHTML = '<p class="hint">Loading products…</p>';
        document.querySelector('#product-results-note').textContent = '';
        document.querySelector('#product-load-more').innerHTML = '';
        return await searchProducts();
      }
      if (action === 'load-more-products') {
        button.disabled = true;
        button.textContent = 'Loading more…';
        return await searchProducts({ append: true });
      }
      if (action === 'add-product') {
        const product = state.products.find(p => p.key === key); if (!product) return;
        const existing = state.cart.find(line => line.product.key === key);
        if (existing) existing.quantity += 1;
        else state.cart.push({ product, quantity: 1, unitCode: product.units?.[0]?.code || 'BASE', manualRatePaise: null });
        renderCart(); toast(`${product.name} added.`); return;
      }
      if (action === 'remove-cart') { state.cart.splice(Number(index), 1); renderCart(); return; }
      if (action === 'open-order') return await showOrder(id);
      if (action === 'view-draft') return await showDraft(id);
      if (action === 'print-draft') return window.print();
      if (action === 'complete-order') {
        if (state.role !== 'OWNER') throw new Error('Only the owner can close an order.');
        const entered = window.prompt('After issuing the final invoice in Windows billing and waiting for stock sync, enter that invoice number:');
        if (entered === null) return;
        const invoiceNumber = entered.trim();
        if (!invoiceNumber) throw new Error('Enter the final invoice number.');
        const lookup = await api(`/api/wholesale/orders/${encodeURIComponent(id)}/invoice-lookup?number=${encodeURIComponent(invoiceNumber)}`);
        const current = String(state.currentDraft?.orderId) === String(id) ? state.currentDraft : state.currentOrder;
        const confirmation = [
          `Check final invoice ${lookup.invoiceNumber} before closing this order.`,
          `Order customer: ${current?.customerName || 'Unknown'}`,
          `Invoice customer: ${lookup.customerName || 'Unknown'}`,
          `Invoice amount: ${money(lookup.totalPaise)} · Date: ${dateLabel(lookup.invoiceDate)}`,
          lookup.customerMatch ? 'Customer records match.' : 'Customer match could not be confirmed automatically. Check the Windows invoice carefully.',
          'Confirm this invoice belongs to this customer and order, was issued in Windows billing, and the stock sync has finished. Recording it will close this order and release any original online reservation.',
        ].join('\n\n');
        if (!window.confirm(confirmation)) return;
        button.disabled = true;
        await api(`/api/wholesale/orders/${encodeURIComponent(id)}/complete`, { method: 'POST', body: { invoiceNumber: lookup.invoiceNumber, invoiceId: lookup.invoiceId } });
        toast('Final invoice recorded. Order closed.');
        return await showOrder(id);
      }
      if (action === 'cancel-order') {
        if (state.role !== 'OWNER') throw new Error('Only the owner can cancel an order.');
        const entered = window.prompt('Enter a reason for cancelling this order. Any original online stock reservation will be released:');
        if (entered === null) return;
        const reason = entered.trim();
        if (!reason) throw new Error('Enter a cancellation reason.');
        button.disabled = true;
        await api(`/api/wholesale/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason } });
        toast('Order cancelled.');
        return await showOrder(id);
      }
      if (action === 'save-pick') {
        const card = button.closest('[data-line-card]');
        const input = card.querySelector('[data-picked-input]');
        const pickedQuantity = Number(input.value);
        if (input.value === '' || !Number.isSafeInteger(pickedQuantity) || pickedQuantity < 0 || pickedQuantity > Number(input.max)) throw new Error('Enter a whole picked quantity within the requested amount.');
        const shortageReason = card.querySelector('[data-shortage-input]').value.trim();
        if (pickedQuantity < Number(input.max) && !shortageReason) throw new Error('Enter a reason for a short or skipped item.');
        const priceText = card.querySelector('[data-rate-input]').value;
        const unitPricePaise = Math.round(Number(priceText) * 100);
        if (priceText === '' || !Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) throw new Error('Enter a valid unit rate.');
        button.disabled = true;
        await api(`/api/wholesale/orders/${encodeURIComponent(state.currentOrder.id)}/lines/${encodeURIComponent(line)}`, { method: 'PATCH', body: { pickedQuantity, shortageReason, unitPricePaise } });
        toast('Item saved.'); return await showOrder(state.currentOrder.id, true);
      }
      if (action === 'set-status') {
        button.disabled = true;
        await api(`/api/wholesale/orders/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status } });
        toast(status === 'READY' ? 'Order is ready for an invoice draft.' : status === 'HOLD' ? 'Order put on hold.' : 'Picking resumed.');
        return await showOrder(id);
      }
      if (action === 'prepare-draft') {
        if (state.role !== 'OWNER') throw new Error('Only the owner can prepare invoice drafts.');
        button.disabled = true; button.textContent = 'Preparing draft…';
        const draft = await api(`/api/wholesale/orders/${encodeURIComponent(id)}/draft`, { method: 'POST', body: {} });
        toast('Invoice draft prepared.'); return await showDraft(draft.id, draft);
      }
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  function handleMainInput(event) {
    if (event.target.id === 'customer-search') {
      clearTimeout(state.customerTimer);
      document.querySelector('#customer-results').innerHTML = '<p class="hint">Searching customers…</p>';
      state.customerTimer = setTimeout(() => searchCustomers().catch(error => toast(error.message, true)), 220);
    } else if (event.target.id === 'product-search') {
      clearTimeout(state.productTimer);
      state.productRequest += 1;
      state.products = [];
      document.querySelector('#product-results').innerHTML = '<p class="hint">Searching products…</p>';
      document.querySelector('#product-results-note').textContent = '';
      document.querySelector('#product-load-more').innerHTML = '';
      state.productTimer = setTimeout(() => searchProducts().catch(error => toast(error.message, true)), 220);
    } else if (event.target.matches('[data-picked-input]')) {
      const card = event.target.closest('[data-line-card]');
      const full = Number(event.target.value) === Number(event.target.max) && event.target.value !== '';
      card.querySelector('[data-pick-all]').checked = full;
    }
  }
  function handleMainChange(event) {
    if (event.target.matches('[data-pick-all]')) {
      const card = event.target.closest('[data-line-card]');
      card.querySelector('[data-picked-input]').value = event.target.checked ? card.querySelector('[data-picked-input]').max : '';
      return;
    }
    const field = event.target.dataset.cartField;
    if (!field) return;
    const line = state.cart[Number(event.target.dataset.index)]; if (!line) return;
    if (field === 'quantity') {
      const qty = Number(event.target.value);
      if (!Number.isSafeInteger(qty) || qty < 1) { toast('Quantity must be a whole number above zero.', true); return renderCart(); }
      line.quantity = qty;
    } else if (field === 'unitCode') { line.unitCode = event.target.value; line.manualRatePaise = null; }
    else if (field === 'rate') {
      const rate = Math.round(Number(event.target.value) * 100);
      if (event.target.value === '' || !Number.isSafeInteger(rate) || rate < 0) { toast('Enter a valid unit rate.', true); return renderCart(); }
      line.manualRatePaise = rate;
    }
    renderCart();
  }
  async function handleMainSubmit(event) {
    if (event.target.id !== 'order-form') return;
    event.preventDefault();
    const form = event.target, button = form.querySelector('#save-order');
    const data = new FormData(form);
    const items = state.cart.map(line => ({ productKey: line.product.key, quantity: line.quantity, unitCode: line.unitCode, ...(line.manualRatePaise == null ? {} : { unitPricePaise: line.manualRatePaise }) }));
    if (!items.length) return toast('Add at least one product.', true);
    const body = { notes: String(data.get('notes') || '').trim(), items };
    if (state.selectedCustomer) body.customerKey = state.selectedCustomer.key;
    else {
      body.customerName = String(data.get('customerName') || '').trim();
      body.phone = String(data.get('phone') || '').trim();
      body.address = String(data.get('address') || '').trim();
      body.gstin = String(data.get('gstin') || '').trim().toUpperCase();
      if (!body.customerName) return toast('Select a customer or enter a customer name.', true);
    }
    button.disabled = true; button.textContent = 'Saving order…';
    try {
      const order = await api('/api/wholesale/orders', { method: 'POST', body });
      toast('Order saved. Start checking items as you pick them.');
      await showOrder(order.id);
    } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'Save order & start picking'; }
  }

  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.nav === 'new') openNew();
    else showOrders().catch(error => toast(error.message, true));
  }));
  main.addEventListener('click', event => { void handleMainClick(event); });
  main.addEventListener('input', handleMainInput);
  main.addEventListener('change', handleMainChange);
  main.addEventListener('submit', event => { void handleMainSubmit(event); });
  api('/api/wholesale/session').then(session => { showApp(session); return showOrders(); }).catch(error => {
    appView.hidden = false;
    setMain(pageHead('WHOLESALE ORDERS', 'Could not open orders', error.message));
    toast(error.message, true);
  });
})();
