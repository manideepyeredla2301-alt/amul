(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const apiBase = '/api/cafe/admin';
  const state = { view: 'dashboard', session: null, data: {}, filters: {}, editor: null, loading: false };
  const titles = {
    dashboard: ['BUSINESS OVERVIEW', 'Good morning'], products: ['YOUR MENU', 'Products'],
    categories: ['YOUR MENU', 'Categories'], options: ['YOUR MENU', 'Add-ons & choices'],
    inventory: ['STOCK CONTROL', 'Inventory'], orders: ['DAILY OPERATIONS', 'Orders & payments'],
    reports: ['BUSINESS INSIGHTS', 'Sales reports'], promotions: ['GROW YOUR CAFÉ', 'Offers'],
    qr: ['TABLE ORDERING', 'QR codes'], staff: ['YOUR TEAM', 'Staff'], settings: ['BUSINESS DETAILS', 'Settings'],
  };
  const currency = amount => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((Number(amount) || 0) / 100);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const attr = escape;
  const safeImage = value => typeof value === 'string' && /^\/(?!\/)[^<>]*$/.test(value) ? value : '';
  const bool = value => value === true || value === 1 || value === '1' || value === 'true';
  const list = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
  const optionGroups = value => {
    const groups = value?.optionGroups ?? value;
    return Array.isArray(groups) ? groups : groups && typeof groups === 'object'
      ? Object.entries(groups).map(([id, group]) => ({ id, ...group })) : [];
  };
  const statusPill = (label, tone = '') => `<span class="pill ${tone}">${escape(label)}</span>`;
  const empty = (title, description) => `<div class="empty-card surface"><strong>${escape(title)}</strong><p>${escape(description)}</p></div>`;
  const button = (action, label, extra = '') => `<button type="button" class="button button-small button-secondary" data-action="${attr(action)}" ${extra}>${escape(label)}</button>`;
  const whenIndia = value => {
    if (!value) return '—';
    const normalized = /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : String(value).replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(date);
  };
  const indiaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  async function api(path, options = {}) {
    const response = await fetch(path.startsWith('/api/cafe/') ? path : apiBase + path, {
      method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: options.body === undefined || options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : options.body instanceof FormData ? options.body : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function toast(message, error = false) {
    const node = $('#toast');
    node.textContent = message;
    node.style.background = error ? '#a93c32' : '';
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 3500);
  }

  function showLogin(message = '') {
    $('#login-view').hidden = false;
    $('#app-view').hidden = true;
    $('#login-error').textContent = message;
    $('#login-error').hidden = !message;
    state.session = null;
    document.title = 'Manager sign in · Amul Café';
  }

  function showApp(session) {
    state.session = session;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    const name = session.username || session.user?.username || 'Rachana';
    $('#staff-badge').textContent = name[0]?.toUpperCase() || 'R';
    document.title = 'Manage café · FrostFlow';
  }

  function updateNav() {
    $$('[data-view]').forEach(node => {
      const active = node.dataset.view === state.view || (state.view === 'options' && node.dataset.view === 'products');
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    });
    $$('[data-mobile-view]').forEach(node => node.classList.toggle('active', node.dataset.mobileView === state.view));
    const [eyebrow, title] = titles[state.view] || titles.dashboard;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').innerHTML = `${escape(title)}<span>.</span>`;
  }

  async function setView(view) {
    if (!titles[view]) return;
    state.view = view;
    updateNav();
    $('#page-content').innerHTML = '<div class="empty-card surface"><strong>Loading…</strong><p>Getting the latest café information.</p></div>';
    $('#page-error').hidden = true;
    try {
      await loadView(view);
      renderView(view);
      $('#sync-status').classList.remove('offline');
    } catch (error) {
      if (error.status === 401) { showLogin('Your session expired. Please sign in again.'); return; }
      $('#page-content').innerHTML = empty('Could not load this section', error.message || 'Please try again.');
      $('#page-error').textContent = error.message || 'Could not load the latest data.';
      $('#page-error').hidden = false;
      $('#sync-status').classList.add('offline');
    }
  }

  async function loadView(view) {
    if (view === 'dashboard') {
      const [overview, orders] = await Promise.all([api('/overview'), api('/orders?scope=all')]);
      state.data.overview = overview;
      state.data.orders = list(orders, 'orders');
    } else if (view === 'products') {
      const [products, categories, groups] = await Promise.all([api('/products'), api('/categories'), api('/option-groups')]);
      state.data.products = list(products, 'products');
      state.data.categories = list(categories, 'categories');
      state.data.optionGroups = optionGroups(groups);
    } else if (view === 'categories') {
      const [categories, products] = await Promise.all([api('/categories'), api('/products')]);
      state.data.categories = list(categories, 'categories');
      state.data.products = list(products, 'products');
    } else if (view === 'options') {
      state.data.optionGroups = optionGroups(await api('/option-groups'));
    } else if (view === 'inventory') {
      state.data.inventory = await api('/inventory');
    } else if (view === 'orders') {
      state.data.orders = list(await api('/orders?scope=all'), 'orders');
    } else if (view === 'reports') {
      const range = state.filters.reportRange || 'today';
      const query = range === 'custom'
        ? `range=custom&from=${encodeURIComponent(state.filters.reportFrom || indiaDate())}&to=${encodeURIComponent(state.filters.reportTo || indiaDate())}`
        : `range=${encodeURIComponent(range)}`;
      state.data.reports = await api(`/reports?${query}`);
    } else if (view === 'staff') {
      state.data.staff = list(await api('/staff'), 'staff');
    } else if (view === 'promotions') {
      const [promotions, categories, products] = await Promise.all([api('/promotions'), api('/categories'), api('/products')]);
      state.data.promotions = list(promotions, 'promotions');
      state.data.categories = list(categories, 'categories');
      state.data.products = list(products, 'products');
    } else if (view === 'settings') {
      const result = await api('/settings');
      state.data.settings = result.settings || result;
    } else if (view === 'qr') {
      const result = await api('/qr');
      state.data.qr = list(result, 'codes');
    }
  }

  function renderView(view) {
    const renderers = { dashboard: renderDashboard, products: renderProducts, categories: renderCategories,
      options: renderOptions, inventory: renderInventory, orders: renderOrders, reports: renderReports,
      promotions: renderPromotions, qr: renderQr, staff: renderStaff, settings: renderSettings };
    $('#page-content').innerHTML = renderers[view]();
  }

  function heading(title, description, actions = '') {
    return `<div class="section-heading"><div><h2>${escape(title)}</h2><p>${escape(description)}</p></div><div class="section-actions">${actions}</div></div>`;
  }

  function stat(label, value, foot, icon = '✦', tone = '') {
    return `<div class="stat-card surface ${tone}"><div class="stat-top"><small>${escape(label)}</small><span class="stat-icon">${icon}</span></div><strong>${value}</strong><span class="stat-foot">${escape(foot)}</span></div>`;
  }

  function renderDashboard() {
    const overview = state.data.overview || {};
    const summary = overview.summary || overview;
    const orders = (state.data.orders || []).slice(0, 5);
    const cards = [
      stat('Today’s sales', currency(summary.total_sales_paise ?? summary.sales_paise), 'Confirmed payments', '₹'),
      stat('Orders today', escape(summary.total_orders ?? summary.orders ?? 0), 'Across QR, counter and tablet', '◉'),
      stat('Average order', currency(summary.average_order_paise), 'Per completed order', '↗'),
      stat('Pending payments', currency(summary.pending_paise), 'Waiting to be collected', '!', 'alert'),
    ].join('');
    const recent = orders.length ? `<div class="mini-list">${orders.map(order => `<div class="mini-row"><span><strong>${escape(order.order_number)}</strong><small>${escape(order.customer_name || order.table_number || 'Walk-in')} · ${whenIndia(order.created_at)}</small></span><span><strong>${currency(order.total_paise)}</strong><small>${escape(order.payment_status || 'UNPAID')}</small></span></div>`).join('')}</div>` : empty('No orders yet', 'New customer and staff orders will appear here.');
    const top = list(overview, 'top_products');
    const topProducts = top.length ? `<div class="mini-list">${top.slice(0, 5).map(row => `<div class="mini-row"><span><strong>${escape(row.name || row.product_name)}</strong><small>${escape(row.quantity || row.units || 0)} sold</small></span><strong>${currency(row.sales_paise || row.total_paise)}</strong></div>`).join('')}</div>` : '<p class="filter-note">Product rankings appear after sales are recorded.</p>';
    return `${heading('Your café at a glance', 'Live numbers for today in India.', `<a href="/pos/" class="button button-primary">Open POS ↗</a>`)}<div class="stat-grid">${cards}</div><div class="content-grid"><section class="surface"><div class="card-head"><h3>Recent orders</h3><button type="button" class="text-button" data-action="go-orders">View all →</button></div>${recent}</section><section class="surface"><div class="card-head"><h3>Popular products</h3><button type="button" class="text-button" data-action="go-reports">Reports →</button></div>${topProducts}</section></div>`;
  }

  function productRows(products) {
    const categories = new Map((state.data.categories || []).map(category => [category.id, category.name]));
    return products.map(product => {
      const image = safeImage(product.image_url);
      const thumb = image ? `<img class="product-thumb" src="${attr(image)}" alt="">` : '<span class="product-thumb empty">◫</span>';
      const manuallyAvailable = bool(product.available_setting ?? product.available);
      const noStock = bool(product.track_stock) && manuallyAvailable && !bool(product.available);
      const availability = !bool(product.active) ? statusPill('Archived', 'off') : !manuallyAvailable ? statusPill('Sold out', 'warn') : noStock ? statusPill('Out of stock', 'red') : statusPill('Available');
      const availabilityAction = noStock ? '<button data-action="go-inventory">Check stock</button>' : `<button data-action="toggle-product" data-id="${attr(product.id)}">${manuallyAvailable ? 'Sold out' : 'Make live'}</button>`;
      const stock = bool(product.track_stock) ? product.type === 'PREPARED' && Number(product.stock_quantity) <= 0 && bool(product.available) ? 'Ingredients' : escape(product.stock_quantity ?? 0) : '—';
      return `<tr><td><div class="table-product">${thumb}<span><strong>${escape(product.name)}</strong><small>${escape(product.sku || product.barcode || product.id)}</small></span></div></td><td>${escape(categories.get(product.category_id) || product.category_id || '—')}</td><td>${escape(product.type || 'PREPARED')}</td><td><strong>${currency(product.price_paise)}</strong></td><td>${stock}</td><td>${availability}</td><td class="row-actions"><button data-action="edit-product" data-id="${attr(product.id)}">Edit</button>${product.type === 'PREPARED' ? `<button data-action="edit-recipe" data-id="${attr(product.id)}">Recipe</button>` : ''}<button data-action="duplicate-product" data-id="${attr(product.id)}">Duplicate</button>${availabilityAction}<button data-action="archive-product" data-id="${attr(product.id)}">Archive</button></td></tr>`;
    }).join('');
  }

  function renderProducts() {
    const products = state.data.products || [];
    const categories = state.data.categories || [];
    const query = String(state.filters.productSearch || '').toLowerCase();
    const categoryId = state.filters.productCategory || 'all';
    const visible = products.filter(product => (categoryId === 'all' || product.category_id === categoryId) && (!query || `${product.name} ${product.sku || ''} ${product.barcode || ''}`.toLowerCase().includes(query)));
    const chips = [{ id: 'all', name: 'All products' }, ...categories].map(category => `<button type="button" class="chip ${categoryId === category.id ? 'active' : ''}" data-product-category="${attr(category.id)}">${escape(category.name)}</button>`).join('');
    return `${heading('Your products', `${products.length} products in your café catalogue.`, `<button class="button button-secondary" data-action="go-options">Manage add-ons</button><button class="button button-secondary" data-action="import-products">Import CSV or Excel</button><button class="button button-primary" data-action="add-product">+ Add product</button>`)}<div class="toolbar"><label class="search-box"><input id="product-search" type="search" placeholder="Search name, SKU or barcode" value="${attr(state.filters.productSearch || '')}"></label><select id="product-type"><option value="all">All types</option><option value="PREPARED" ${state.filters.productType === 'PREPARED' ? 'selected' : ''}>Café food & drinks</option><option value="RETAIL" ${state.filters.productType === 'RETAIL' ? 'selected' : ''}>Retail ice cream</option></select></div><div class="chip-row">${chips}</div><div class="surface table-wrap"><table class="data-table"><thead><tr><th>Product</th><th>Category</th><th>Type</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>${productRows(visible.filter(product => state.filters.productType === 'all' || !state.filters.productType || product.type === state.filters.productType)) || `<tr><td colspan="7">${empty('No products found', 'Try another search or add your first product.')}</td></tr>`}</tbody></table></div>`;
  }

  function renderCategories() {
    const categories = [...(state.data.categories || [])].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
    const products = state.data.products || [];
    return `${heading('Organize the menu', 'Choose where each product appears for customers and staff.', `<button class="button button-primary" data-action="add-category">+ Add category</button>`)}<div class="category-grid">${categories.map(category => {
      const image = safeImage(category.image_url);
      const count = products.filter(product => product.category_id === category.id && bool(product.active)).length;
      return `<article class="category-card surface">${image ? `<img class="category-image" src="${attr(image)}" alt="">` : '<div class="category-image"></div>'}<div class="category-body"><div class="category-title"><h3>${escape(category.name)}</h3>${bool(category.active) ? statusPill('Live') : statusPill('Hidden', 'off')}</div><p>${escape(category.description || 'No description yet')}</p><div class="category-footer"><small>${count} product${count === 1 ? '' : 's'} · ${[category.show_qr && 'QR', category.show_pos && 'POS', category.show_retail && 'Retail'].filter(Boolean).join(', ') || 'Hidden'}</small><span><button class="text-button" data-action="edit-category" data-id="${attr(category.id)}">Edit</button> <button class="text-button" data-action="delete-category" data-id="${attr(category.id)}">Delete</button></span></div></div></article>`;
    }).join('') || empty('No categories yet', 'Add a category to organize your products.')}</div>`;
  }

  function renderOptions() {
    const groups = state.data.optionGroups || [];
    return `${heading('Add-ons & choices', 'Manage reusable product options such as cheese slices and sundae flavours.', `<button class="button button-secondary" data-action="go-products">← Products</button><button class="button button-primary" data-action="add-option">+ Add group</button>`)}<div class="surface table-wrap"><table class="data-table"><thead><tr><th>Group</th><th>How customers choose</th><th>Choices</th><th>Base add-on</th><th></th></tr></thead><tbody>${groups.map(group => `<tr><td><strong>${escape(group.name)}</strong><br><small>${escape(group.id)}</small></td><td>${escape(group.type)}</td><td>${escape((group.choices || []).map(choice => typeof choice === 'string' ? choice : choice.name).join(', ') || 'Yes / no')}</td><td>${currency(Number(group.priceDelta || 0) * 100)}</td><td class="row-actions"><button data-action="edit-option" data-id="${attr(group.id)}">Edit</button><button data-action="delete-option" data-id="${attr(group.id)}">Delete</button></td></tr>`).join('') || `<tr><td colspan="5">No add-on groups yet.</td></tr>`}</tbody></table></div>`;
  }

  function inventoryLow(product) {
    if (!bool(product.track_stock) || !bool(product.active)) return false;
    if (product.type === 'PREPARED') return bool(product.available_setting) && !bool(product.available);
    return Number(product.stock_quantity) <= Number(product.low_stock_threshold ?? 5);
  }

  function inventoryStatus(product) {
    if (!bool(product.available_setting)) return statusPill('Paused', 'off');
    if (!bool(product.available)) return statusPill('Out of stock', 'red');
    if (product.type === 'RETAIL' && Number(product.stock_quantity) <= Number(product.low_stock_threshold ?? 5)) return statusPill('Low', 'warn');
    return statusPill('Available');
  }

  function renderInventory() {
    const inventory = state.data.inventory || {};
    const products = list(inventory, 'products');
    const movements = list(inventory, 'movements');
    const low = products.filter(inventoryLow).length;
    return `${heading('Stock & inventory', 'Track on-hand quantities and record every adjustment.', `<button class="button button-primary" data-action="go-products">+ Add retail product</button>`)}<div class="stat-grid">${stat('Tracked products', escape(products.filter(product => bool(product.track_stock)).length), 'With stock tracking enabled', '◈')}${stat('Low or out of stock', escape(low), 'Needs attention', '!', 'alert')}${stat('Stock movements', escape(movements.length), 'Recent adjustments', '↕')}${stat('Retail products', escape(products.filter(product => product.type === 'RETAIL').length), 'Packaged products', '◫')}</div><div class="surface table-wrap"><table class="data-table"><thead><tr><th>Product</th><th>SKU / barcode</th><th>On hand</th><th>Cost</th><th>Status</th><th></th></tr></thead><tbody>${products.filter(product => bool(product.track_stock)).map(product => `<tr><td><strong>${escape(product.name)}</strong></td><td>${escape(product.sku || product.barcode || '—')}</td><td><strong>${product.type === 'PREPARED' && Number(product.stock_quantity) <= 0 && bool(product.available) ? 'Ingredients' : escape(product.stock_quantity ?? 0)}</strong></td><td>${currency(product.cost_paise)}</td><td>${inventoryStatus(product)}</td><td class="row-actions"><button data-action="adjust-stock" data-id="${attr(product.id)}">Adjust stock</button></td></tr>`).join('') || `<tr><td colspan="6">No products are tracking stock yet. Turn on stock tracking in a product’s details.</td></tr>`}</tbody></table></div><div class="content-grid" style="margin-top:16px"><section class="surface"><div class="card-head"><h3>Recent movements</h3></div><div class="mini-list">${movements.slice(0, 10).map(row => `<div class="mini-row"><span><strong>${escape(row.product_name || row.item_name || row.product_id)}</strong><small>${escape(row.reason || 'Adjustment')} · ${whenIndia(row.created_at)}</small></span><strong>${Number(row.quantity_delta) > 0 ? '+' : ''}${escape(row.quantity_delta)}</strong></div>`).join('') || '<p class="filter-note">No stock adjustments recorded yet.</p>'}</div></section><section class="surface"><div class="card-head"><h3>Stock practice</h3></div><p class="filter-note">Record purchases, wastage and corrections as stock movements. Each confirmed retail sale deducts stock automatically when tracking is enabled.</p></section></div>` + renderExtraInventory(inventory);
  }

  function renderExtraInventory(inventory) {
    const ingredients = list(inventory, 'ingredients');
    const batches = list(inventory, 'batches');
    const products = list(inventory, 'products');
    const names = new Map([...products, ...ingredients].map(item => [item.id, item.name]));
    const ingredientRows = ingredients.map(ingredient => `<tr><td><strong>${escape(ingredient.name)}</strong></td><td>${escape(ingredient.unit)}</td><td><strong>${escape(ingredient.stock_quantity ?? 0)}</strong></td><td>${escape(ingredient.low_stock_quantity ?? 0)}</td><td>${Number(ingredient.stock_quantity || 0) <= Number(ingredient.low_stock_quantity || 0) ? statusPill('Low', 'warn') : statusPill('In stock')}</td><td class="row-actions"><button data-action="edit-ingredient" data-id="${attr(ingredient.id)}">Edit</button><button data-action="adjust-stock" data-id="${attr(ingredient.id)}">Adjust</button></td></tr>`).join('');
    const batchRows = batches.slice(0, 30).map(batch => `<tr><td><strong>${escape(batch.batch_number || batch.id?.slice(0, 8) || '—')}</strong></td><td>${escape(names.get(batch.product_id || batch.ingredient_id) || batch.product_id || batch.ingredient_id || '—')}</td><td>${escape(batch.quantity ?? 0)}</td><td>${escape(batch.expiry_date || '—')}</td><td>${batch.expiry_date && batch.expiry_date < indiaDate() ? statusPill('Expired', 'red') : statusPill('Recorded')}</td></tr>`).join('');
    return `<section class="surface table-wrap inventory-extra"><div class="card-head"><div><h3>Ingredients</h3><p class="filter-note">Track milk, sauces, toppings and other recipe inputs.</p></div><button class="button button-small button-primary" data-action="add-ingredient">+ Add ingredient</button></div><table class="data-table"><thead><tr><th>Ingredient</th><th>Unit</th><th>On hand</th><th>Low at</th><th>Status</th><th></th></tr></thead><tbody>${ingredientRows || '<tr><td colspan="6">No ingredients configured yet.</td></tr>'}</tbody></table></section><section class="surface table-wrap inventory-extra"><div class="card-head"><h3>Stock batches</h3></div><table class="data-table"><thead><tr><th>Batch</th><th>Product / ingredient</th><th>Quantity</th><th>Expiry</th><th>Status</th></tr></thead><tbody>${batchRows || '<tr><td colspan="5">Batches appear here after a stock adjustment includes a batch number.</td></tr>'}</tbody></table></section>`;
  }

  function renderOrders() {
    const all = state.data.orders || [];
    const query = String(state.filters.orderSearch || '').toLowerCase();
    const status = state.filters.orderStatus || 'all';
    const orders = all.filter(order => (status === 'all' || order.payment_status === status || order.status === status) && (!query || `${order.order_number} ${order.customer_name || ''} ${order.table_number || ''}`.toLowerCase().includes(query)));
    const unpaid = all.filter(order => !['PAID', 'REFUNDED'].includes(String(order.payment_status || 'UNPAID')) && order.status !== 'CANCELLED');
    return `${heading('Orders & payments', 'Review sales and record cash, UPI or card collections.', `<a class="button button-secondary" href="/pos/">Open counter POS ↗</a>`)}<div class="stat-grid">${stat('All orders', escape(all.length), 'Recent orders', '◉')}${stat('Payment pending', escape(unpaid.length), 'Awaiting collection', '!', 'alert')}${stat('Amount pending', currency(unpaid.reduce((sum, order) => sum + Number(order.total_paise || 0) - Number(order.paid_paise || 0), 0)), 'Uncollected balance', '₹')}${stat('Paid orders', escape(all.filter(order => order.payment_status === 'PAID').length), 'Collected in full', '✓')}</div><div class="toolbar"><label class="search-box"><input id="order-search" type="search" placeholder="Search order or customer" value="${attr(state.filters.orderSearch || '')}"></label><select id="order-status-filter"><option value="all">All orders</option><option value="UNPAID" ${status === 'UNPAID' ? 'selected' : ''}>Unpaid</option><option value="PARTIAL" ${status === 'PARTIAL' ? 'selected' : ''}>Part paid</option><option value="PAID" ${status === 'PAID' ? 'selected' : ''}>Paid</option><option value="CANCELLED" ${status === 'CANCELLED' ? 'selected' : ''}>Cancelled</option></select></div><div class="order-list">${orders.map(order => `<article class="order-card surface"><div class="order-top"><div><h3>#${escape(order.order_number || order.id)}</h3><div class="meta"><span>${escape(order.customer_name || 'Walk-in')}</span><span>${escape(order.service_type === 'DINE_IN' ? `Table ${order.table_number || '—'}` : order.service_type || order.source || 'Counter')}</span><span>${whenIndia(order.created_at)}</span></div></div>${statusPill(order.payment_status || 'UNPAID', order.payment_status === 'PAID' ? '' : 'warn')}</div><div class="order-lines">${(order.items || []).map(item => `<div class="mini-row"><span>${escape(item.quantity)}× ${escape(item.name)}</span><strong>${currency(item.total_paise)}</strong></div>`).join('') || 'No item details'}</div><div class="order-foot"><div><small>Total · ${escape(order.status || 'RECEIVED')}</small><br><strong>${currency(order.total_paise)}</strong></div><div class="section-actions">${order.payment_status !== 'PAID' && order.status !== 'CANCELLED' ? `<button class="button button-small button-primary" data-action="record-payment" data-id="${attr(order.id)}">Record payment</button>` : ''}<button class="button button-small button-secondary" data-action="order-details" data-id="${attr(order.id)}">Details / returns</button><button class="button button-small button-quiet" data-action="print-receipt" data-id="${attr(order.id)}">Print receipt</button></div></div></article>`).join('') || empty('No matching orders', 'Orders will appear here after customers or staff place them.')}</div>`;
  }

  function reportBars(rows, valueKey, nameKey = 'name') {
    const values = rows.map(row => Number(row[valueKey] || 0));
    const max = Math.max(1, ...values);
    return `<div class="report-bars">${rows.slice(0, 8).map(row => `<div class="report-bar"><span>${escape(row[nameKey] || row.category_name || row.product_name || 'Other')}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round(Number(row[valueKey] || 0) / max * 100))}%"></div></div><strong>${currency(row[valueKey])}</strong></div>`).join('') || '<p class="filter-note">Sales will appear after payments are recorded.</p>'}</div>`;
  }

  function renderReports() {
    const report = state.data.reports || {};
    const s = report.summary || report;
    const top = list(report, 'top_products');
    const categories = list(report, 'category_sales');
    const payments = list(report, 'payments');
    const range = state.filters.reportRange || 'today';
    const selector = `<select id="report-range"><option value="today" ${range === 'today' ? 'selected' : ''}>Today</option><option value="yesterday" ${range === 'yesterday' ? 'selected' : ''}>Yesterday</option><option value="7d" ${range === '7d' ? 'selected' : ''}>Last 7 days</option><option value="month" ${range === 'month' ? 'selected' : ''}>This month</option><option value="custom" ${range === 'custom' ? 'selected' : ''}>Custom dates</option></select>${range === 'custom' ? `<label class="compact-date">From <input id="report-from" type="date" value="${attr(state.filters.reportFrom || indiaDate())}"></label><label class="compact-date">To <input id="report-to" type="date" value="${attr(state.filters.reportTo || indiaDate())}"></label>` : ''}`;
    return `${heading('Sales performance', 'Reports use the café’s Asia/Kolkata business day.', `${selector}<button class="button button-secondary" data-action="export-reports">↓ Export CSV</button>`)}<div class="stat-grid">${stat('Total sales', currency(s.total_sales_paise ?? s.sales_paise), 'Confirmed payments', '₹')}${stat('Orders', escape(s.total_orders ?? s.orders ?? 0), 'In selected period', '◉')}${stat('Average order', currency(s.average_order_paise), 'Order value', '↗')}${stat('Refunds', currency(s.refunds_paise), 'Refunded payments', '↶')}</div><div class="content-grid"><section class="surface"><div class="card-head"><h3>Best selling products</h3></div>${reportBars(top, 'sales_paise')}</section><section class="surface"><div class="card-head"><h3>Sales by category</h3></div>${reportBars(categories, 'sales_paise')}</section></div><section class="surface" style="padding:20px;margin-top:16px"><div class="card-head"><h3>Payment methods</h3></div><div class="mini-list">${payments.map(row => `<div class="mini-row"><span>${escape(row.method || row.name)}</span><strong>${currency(row.amount_paise || row.total_paise)}</strong></div>`).join('') || '<p class="filter-note">No payments in this period.</p>'}</div></section>` + renderAdditionalReports(report);
  }

  function renderAdditionalReports(report) {
    const s = report.summary || {};
    const addOns = list(report, 'popular_addons');
    const slow = list(report, 'slow_moving');
    const low = list(report, 'low_stock');
    const consumed = list(report, 'ingredient_consumption');
    const lines = (rows, value) => rows.length ? rows.slice(0, 8).map(row => `<div class="mini-row"><span>${escape(row.name || row.id)}</span><strong>${escape(value(row))}</strong></div>`).join('') : '<p class="filter-note">No records in this period.</p>';
    return `<div class="content-grid report-extra"><section class="surface"><div class="card-head"><h3>Sales by product type</h3></div><div class="mini-list"><div class="mini-row"><span>Café food & drinks</span><strong>${currency(s.cafe_sales_paise)}</strong></div><div class="mini-row"><span>Packaged retail</span><strong>${currency(s.retail_sales_paise)}</strong></div><div class="mini-row"><span>Pending payments</span><strong>${currency(s.pending_paise)}</strong></div><div class="mini-row"><span>Cancelled orders</span><strong>${escape(s.cancelled_orders || 0)}</strong></div></div></section><section class="surface"><div class="card-head"><h3>Popular add-ons</h3></div><div class="mini-list">${lines(addOns, row => `${row.quantity || 0} selected`)}</div></section></div><div class="content-grid report-extra"><section class="surface"><div class="card-head"><h3>Low stock products</h3></div><div class="mini-list">${lines(low, row => `${row.stock_quantity ?? 0} left`)}</div></section><section class="surface"><div class="card-head"><h3>Slow-moving products</h3></div><div class="mini-list">${lines(slow, row => `${row.quantity ?? 0} sold`)}</div></section></div><section class="surface report-extra report-consumption"><div class="card-head"><h3>Ingredient consumption</h3></div><div class="mini-list">${lines(consumed, row => `${row.consumed_quantity ?? 0} ${row.unit || ''}`)}</div></section>`;
  }

  function renderPromotions() {
    const promotions = state.data.promotions || [];
    return `${heading('Offers & promotions', 'Choose when and where your café offers apply.', `<button class="button button-primary" data-action="add-promotion">+ Create offer</button>`)}<div class="info-strip"><strong>✦</strong><span>Ice cream above ₹250 can earn one free Salted Fries when the opening offer is enabled. Only eligible ice cream products count.</span></div><div class="surface table-wrap"><table class="data-table"><thead><tr><th>Offer</th><th>Type</th><th>Dates</th><th>Usage</th><th>Status</th><th></th></tr></thead><tbody>${promotions.map(promo => `<tr><td><strong>${escape(promo.name)}</strong><br><small>${escape(promo.description || '')}</small></td><td>${escape({FREE_ITEM:'Free item',PERCENT:'Percentage',FIXED:'Fixed discount'}[promo.type] || promo.type || 'Offer')}</td><td>${escape(promo.starts_at || 'Anytime')} – ${escape(promo.ends_at || 'Ongoing')}</td><td>${escape(promo.usage_count || 0)}${promo.usage_limit ? ` / ${escape(promo.usage_limit)}` : ''}</td><td>${bool(promo.active) ? statusPill('Live') : statusPill('Paused', 'off')}</td><td class="row-actions"><button data-action="edit-promotion" data-id="${attr(promo.id)}">Edit</button><button data-action="toggle-promotion" data-id="${attr(promo.id)}">${bool(promo.active) ? 'Pause' : 'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="6">No promotions configured yet.</td></tr>'}</tbody></table></div>`;
  }

  function renderQr() {
    const codes = state.data.qr || [];
    return `${heading('Ordering QR codes', 'Create a code for each table or counter pickup point.', `<a class="button button-secondary" href="/kitchen/qr.html" target="_blank" rel="noopener">Print cards ↗</a><button class="button button-primary" data-action="add-qr">+ Add QR code</button>`)}<div class="qr-preview surface"><div><span class="eyebrow">SCAN TO ORDER</span><h2 style="font:700 24px Georgia,serif;margin:8px 0 0">Put the menu on every table.</h2><p>Customers open your current menu directly. Table cards prefill the table number and the kitchen receives the order.</p></div><a class="button button-primary" href="/kitchen/qr.html" target="_blank" rel="noopener">Generate print sheet ↗</a></div><div class="surface table-wrap" style="margin-top:16px"><table class="data-table"><thead><tr><th>Code</th><th>Context</th><th>Link</th><th>Status</th><th></th></tr></thead><tbody>${codes.map(code => `<tr><td><strong>${escape(code.label || code.name || code.id)}</strong></td><td>${escape(code.context || 'TABLE')}${code.table_number ? ` · ${escape(code.table_number)}` : ''}</td><td><small>${escape(code.url || '')}</small></td><td>${bool(code.active) ? statusPill('Enabled') : statusPill('Disabled', 'off')}</td><td class="row-actions"><button data-action="edit-qr" data-id="${attr(code.id)}">Edit</button><button data-action="toggle-qr" data-id="${attr(code.id)}">${bool(code.active) ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="5">No saved QR codes yet. Use the print sheet to create table cards.</td></tr>'}</tbody></table></div>`;
  }

  function renderStaff() {
    const staff = state.data.staff || [];
    return `${heading('People & permissions', 'Give each team member access only to the tools they need.', `<button class="button button-primary" data-action="add-staff">+ Add staff member</button>`)}<div class="surface table-wrap"><table class="data-table"><thead><tr><th>Staff member</th><th>Role</th><th>Access</th><th></th></tr></thead><tbody>${staff.map(person => `<tr><td><strong>${escape(person.display_name || person.username)}</strong><br><small>${escape(person.username)}</small></td><td>${escape(person.role || 'STAFF')}</td><td>${bool(person.active) ? statusPill('Active') : statusPill('Disabled', 'off')}</td><td class="row-actions">${person.managed_by_environment ? '<small>Owner account</small>' : `<button data-action="edit-staff" data-id="${attr(person.id || person.username)}">Edit</button><button data-action="toggle-staff" data-id="${attr(person.id || person.username)}">${bool(person.active) ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('') || '<tr><td colspan="4">No staff accounts yet.</td></tr>'}</tbody></table></div><div class="info-strip">Owner can manage prices and settings. Cashiers take payments and print receipts. Kitchen staff see preparation orders only.</div>`;
  }

  function renderSettings() {
    const settings = state.data.settings || {};
    return `${heading('Business settings', 'Keep your customer receipts and ordering details accurate.')}
      <form id="settings-form" class="settings-form surface" style="padding:22px"><div class="form-grid">
      <label class="form-field">Shop name<input name="shop_name" value="${attr(settings.shop_name || 'Amul Ice Cream Café')}" required></label>
      <label class="form-field">Business phone<input name="shop_phone" value="${attr(settings.shop_phone || '')}" inputmode="tel"></label>
      <label class="form-field full">Address<textarea name="shop_address">${escape(settings.shop_address || '')}</textarea></label>
      <label class="form-field">GSTIN<input name="gstin" value="${attr(settings.gstin || '')}" maxlength="15"></label>
      <label class="form-field">Receipt footer<input name="receipt_footer" value="${attr(settings.receipt_footer || 'Thank you for visiting!')}"></label>
      <label class="form-field">Default tax rate (%)<input name="default_tax_rate" type="number" min="0" max="50" step="0.01" value="${attr(Number(settings.default_tax_rate_bps || 0) / 100)}"><small class="field-hint">Products can override this tax setting individually.</small></label>
      <label class="form-field">Currency<input value="INR · Indian rupee" disabled></label>
      </div><div class="toggle-row"><input id="cash-enabled" name="cash_enabled" type="checkbox" ${settings.cash_enabled === undefined || bool(settings.cash_enabled) ? 'checked' : ''}><label for="cash-enabled">Accept cash</label></div><div class="toggle-row"><input id="upi-enabled" name="upi_enabled" type="checkbox" ${settings.upi_enabled === undefined || bool(settings.upi_enabled) ? 'checked' : ''}><label for="upi-enabled">Record UPI payments</label></div><div class="toggle-row"><input id="card-enabled" name="card_enabled" type="checkbox" ${settings.card_enabled === undefined || bool(settings.card_enabled) ? 'checked' : ''}><label for="card-enabled">Record card payments</label></div><button class="button button-primary" type="submit">Save settings</button></form>`;
  }

  const field = (name, label, value = '', type = 'text', extra = '') => `<label class="form-field ${extra.includes('data-full') ? 'full' : ''}">${escape(label)}<input name="${attr(name)}" type="${attr(type)}" value="${attr(value ?? '')}" ${extra.replace('data-full', '')}></label>`;
  const area = (name, label, value = '', extra = '') => `<label class="form-field full">${escape(label)}<textarea name="${attr(name)}" ${extra}>${escape(value ?? '')}</textarea></label>`;
  const choice = (name, label, choices, selected) => `<label class="form-field">${escape(label)}<select name="${attr(name)}">${choices.map(([value, text]) => `<option value="${attr(value)}" ${String(selected ?? '') === String(value) ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`;
  const toggle = (name, label, selected) => `<label class="toggle-row"><input type="checkbox" name="${attr(name)}" ${bool(selected) ? 'checked' : ''}>${escape(label)}</label>`;
  const imagePicker = (value, label = 'Product photo') => `<div class="image-picker"><div id="image-preview">${safeImage(value) ? `<img src="${attr(safeImage(value))}" alt="Current image">` : '<div class="empty-image">◫</div>'}</div><div><strong>${escape(label)}</strong><input type="file" name="image_file" accept="image/jpeg,image/png,image/webp"><small>Square crop, JPG / PNG / WebP. Up to 1 MB after upload.</small><button class="text-button" type="button" data-editor-action="clear-image">Remove image</button></div><input type="hidden" name="image_url" value="${attr(value || '')}"></div>`;

  function productForm(product = {}) {
    const categories = state.data.categories || [];
    const groupIds = new Set(product.optionGroups || product.option_groups || []);
    return `${imagePicker(product.image_url)}<div class="form-grid">
      ${field('id', 'Product ID', product.id, 'text', product.id ? 'readonly' : 'placeholder="e.g. classic-veg-burger"')}
      ${field('name', 'Product name', product.name, 'text', 'required maxlength="120"')}
      ${choice('category_id', 'Category', categories.map(category => [category.id, category.name]), product.category_id)}
      ${choice('type', 'Product type', [['PREPARED', 'Café food or drink'], ['RETAIL', 'Packaged retail']], product.type || 'PREPARED')}
      ${field('price_rupees', 'Selling price (₹)', Number(product.price_paise || 0) / 100, 'number', 'required min="0" step="0.01"')}
      ${field('mrp_rupees', 'MRP (₹)', Number(product.mrp_paise || 0) / 100, 'number', 'min="0" step="0.01"')}
      ${field('cost_rupees', 'Purchase / ingredient cost (₹)', Number(product.cost_paise || 0) / 100, 'number', 'min="0" step="0.01"')}
      ${field('tax_percent', 'Tax rate override (%)', product.id ? Number(product.tax_rate_bps || 0) / 100 : '', 'number', 'min="0" max="50" step="0.01" placeholder="Use shop default"')}
      ${field('sku', 'SKU', product.sku, 'text', 'maxlength="80"')}
      ${field('barcode', 'Barcode', product.barcode, 'text', 'maxlength="80"')}
      ${field('brand', 'Brand', product.brand, 'text', 'maxlength="80"')}
      ${field('pack_size', 'Pack size', product.pack_size, 'text', 'placeholder="e.g. 100 ml"')}
      ${choice('veg_type', 'Food label', [['VEG', 'Vegetarian'], ['NON_VEG', 'Non-vegetarian'], ['EGG', 'Contains egg']], product.veg_type || 'VEG')}
      ${field('prep_minutes', 'Typical prep time (minutes)', product.prep_minutes ?? '', 'number', 'min="0" max="180"')}
      ${choice('kitchen_route', 'Send to kitchen', [['true', 'Yes, prepare this'], ['false', 'No, retail only']], product.kitchen_route === undefined ? String(product.type !== 'RETAIL') : String(bool(product.kitchen_route)))}
      ${product.id ? '' : field('stock_quantity', 'Opening stock', 0, 'number', 'step="1" min="0"')}
      ${field('low_stock_threshold', 'Low stock alert at', product.low_stock_threshold ?? 5, 'number', 'min="0" step="0.001"')}
    </div>${area('description', 'Description', product.description)}
    <label class="form-field full">Kitchen preparation steps<textarea name="prep_steps_text" rows="6" placeholder="One instruction per line">${escape((product.prep_steps || []).join('\n'))}</textarea><small class="field-hint">Kitchen tickets show these steps to the cook. Use one clear instruction per line.</small></label>
    <h3 class="form-divider">Ordering choices</h3><div class="option-group-list">${(state.data.optionGroups || []).map(group => `<label><input type="checkbox" name="option_group" value="${attr(group.id)}" ${groupIds.has(group.id) ? 'checked' : ''}>${escape(group.name)}</label>`).join('') || '<small class="field-hint">Add reusable choices from Manage add-ons.</small>'}</div>
    <h3 class="form-divider">Availability</h3><div class="form-grid">${toggle('available', 'Available for ordering', (product.available_setting ?? product.available) !== false)}${toggle('active', 'Active product', product.active !== false)}${toggle('track_stock', 'Track stock', product.track_stock)}</div>`;
  }

  function categoryForm(category = {}) {
    return `${imagePicker(category.image_url, 'Category photo')}<div class="form-grid">${field('id', 'Category ID', category.id, 'text', category.id ? 'readonly' : 'placeholder="e.g. ice-cream-bars"')}${field('name', 'Category name', category.name, 'text', 'required maxlength="100"')}${field('sort_order', 'Display order', category.sort_order ?? 0, 'number', 'step="1" min="0"')}</div>${area('description', 'Description', category.description)}<h3 class="form-divider">Where should it appear?</h3><div class="form-grid">${toggle('show_qr', 'Customer QR menu', category.show_qr !== false)}${toggle('show_pos', 'Tablet POS', category.show_pos !== false)}${toggle('show_retail', 'Retail POS', category.show_retail)}${toggle('active', 'Category enabled', category.active !== false)}</div>`;
  }

  function optionForm(group = {}) {
    const lines = (group.choices || []).map(choice => typeof choice === 'string' ? choice : `${choice.id || ''} | ${choice.name || ''} | ${choice.priceDelta || 0}`).join('\n');
    return `<div class="form-grid">${field('id', 'Option ID', group.id, 'text', group.id ? 'readonly' : 'required pattern="[a-z0-9-]{2,80}" placeholder="e.g. extra-cheese"')}${field('name', 'Group name', group.name, 'text', 'required')}${choice('type', 'Choice type', [['checkbox', 'Yes / no add-on'], ['single', 'Pick one'], ['multi', 'Pick one or more']], group.type || 'checkbox')}${field('priceDelta', 'Yes / no extra price (₹)', group.priceDelta ?? 0, 'number', 'min="0" step="1"')}</div>${toggle('required', 'Customer must choose', group.required)}<label class="form-field full">Choices (one per line)<textarea name="choicesText" rows="6" placeholder="id | Display name | extra price in ₹">${escape(lines)}</textarea><small class="field-hint">Example: waffle-cone | Waffle Cone | 10. For simple flavour names, enter just the name.</small></label>`;
  }

  function stockForm(product) {
    return `<div class="info-strip">${escape(product.name)} currently has <strong>${escape(product.stock_quantity ?? 0)} ${escape(product.unit || 'units')}</strong> on hand.</div><div class="form-grid">${field('quantity_delta', 'Change in quantity', '', 'number', 'required step="0.001" placeholder="+10 or -2"')}${choice('reason', 'Reason', [['PURCHASE', 'New stock / purchase'], ['WASTAGE', 'Wastage'], ['CORRECTION', 'Stock correction'], ['RETURN', 'Customer return']], 'PURCHASE')}${field('batch_number', 'Batch number', '', 'text', 'maxlength="80"')}${field('manufacturing_date', 'Manufacturing date', '', 'date')}${field('expiry_date', 'Best before / expiry', '', 'date')}${field('cost_rupees', 'Purchase cost per unit (₹)', '', 'number', 'min="0" step="0.01"')}</div>`;
  }

  function ingredientForm(ingredient = {}) {
    return `<div class="form-grid">${field('id', 'Ingredient ID', ingredient.id, 'text', ingredient.id ? 'readonly' : 'placeholder="e.g. whole-milk"')}${field('name', 'Ingredient name', ingredient.name, 'text', 'required maxlength="100"')}${choice('unit', 'Unit', [['g', 'Grams'], ['ml', 'Millilitres'], ['each', 'Each']], ingredient.unit || 'g')}${ingredient.id ? '' : field('stock_quantity', 'Opening stock', 0, 'number', 'min="0" step="0.001"')}${field('low_stock_quantity', 'Low stock alert at', ingredient.low_stock_quantity ?? 0, 'number', 'min="0" step="0.001"')}${field('cost_rupees', 'Cost per unit (₹)', Number(ingredient.cost_paise_per_unit || 0) / 100, 'number', 'min="0" step="0.01"')}</div>${toggle('active', 'Ingredient enabled', ingredient.active === undefined || bool(ingredient.active))}`;
  }

  function recipeForm(product, recipe = []) {
    const ingredients = state.data.ingredients || [];
    const current = new Map(recipe.map(line => [line.ingredient_id, line.quantity]));
    return `<div class="info-strip"><strong>${escape(product.name)}</strong> · Enter the amount consumed for one serving. Stock is deducted when an order is placed.</div><div class="recipe-lines">${ingredients.map(ingredient => `<label><span>${escape(ingredient.name)} <small>${escape(ingredient.unit)}</small></span><input name="recipe_${attr(ingredient.id)}" data-ingredient-id="${attr(ingredient.id)}" type="number" min="0" step="0.001" value="${attr(current.get(ingredient.id) ?? '')}" placeholder="0"></label>`).join('') || '<p class="field-hint">Add ingredients under Inventory first, then set up this recipe.</p>'}</div><p class="field-hint">Leave an ingredient blank to exclude it. Saving replaces the previous recipe.</p>`;
  }

  function importForm() {
    const categories = state.data.categories || [];
    return `<div class="info-strip">Upload a CSV or .xlsx Excel file with up to 200 products. Excel imports the first worksheet. Check the preview before saving.</div><label class="form-field full">Choose CSV or Excel file<input name="import_file" type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><div id="import-preview"></div><details class="product-eligibility" open><summary>Required columns and category IDs</summary><p class="field-hint">Required: name, category_id, type, price (rupees) or price_paise. Optional: SKU, barcode, brand, pack_size, veg_type, stock_quantity, image_url and more. Type must be PREPARED or RETAIL.</p><div class="import-category-list">${categories.map(category => `<span><strong>${escape(category.name)}</strong> · ${escape(category.id)}</span>`).join('') || 'Create a category before importing products.'}</div><button type="button" class="text-button" data-editor-action="download-template">Download blank CSV</button></details>`;
  }

  function openImportEditor() {
    state.editor = { kind: 'import', id: null, validated: false, uploading: false, importFile: null };
    $('#editor-eyebrow').textContent = 'BULK CATALOGUE';
    $('#editor-title').textContent = 'Import products';
    $('#editor-fields').innerHTML = importForm();
    $('#editor-error').hidden = true;
    $('#save-editor').hidden = false;
    $('#save-editor').textContent = 'Check file';
    $('#editor-dialog').showModal();
  }

  async function saveImport(form) {
    const file = $('input[name="import_file"]', form)?.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) { $('#editor-error').textContent = 'Import file must be under 1 MB.'; $('#editor-error').hidden = false; return; }
    const save = $('#save-editor');
    save.disabled = true;
    $('#editor-error').hidden = true;
    try {
      if (!state.editor.importFile) {
        if (/\.xlsx$/i.test(file.name)) state.editor.importFile = await globalThis.CafeExcelImport.toCsvFile(file);
        else if (/\.csv$/i.test(file.name)) state.editor.importFile = file;
        else throw new Error('Choose a CSV or .xlsx Excel file.');
      }
      const payload = new FormData();
      payload.append('file', state.editor.importFile);
      if (!state.editor.validated) {
        const result = await api('/products/import?dry_run=true', { method: 'POST', body: payload });
        const products = list(result, 'products');
        state.editor.validated = true;
        $('#import-preview').innerHTML = `<div class="import-preview"><strong>${escape(result.count ?? products.length)} products ready to import</strong><p>Check these first rows before saving:</p><ul>${products.slice(0, 8).map(product => `<li>${escape(product.name)} · ${escape(product.category_id)} · ${currency(product.price_paise)}</li>`).join('')}</ul>${products.length > 8 ? `<small>…and ${products.length - 8} more</small>` : ''}</div>`;
        save.textContent = `Import ${result.count ?? products.length} products`;
      } else {
        const result = await api('/products/import', { method: 'POST', body: payload });
        $('#editor-dialog').close();
        state.editor = null;
        toast(`${result.created || 0} products imported.`);
        await setView('products');
      }
    } catch (error) { $('#editor-error').textContent = error.message || 'Could not import this file.'; $('#editor-error').hidden = false; }
    finally { save.disabled = false; }
  }

  function downloadImportTemplate() {
    const headers = 'name,category_id,type,price,sku,barcode,brand,pack_size,veg_type,stock_quantity\r\n';
    const url = URL.createObjectURL(new Blob(['\ufeff' + headers], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'amul-cafe-products-template.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function paymentForm(order) {
    const balance = Math.max(0, Number(order.total_paise || 0) - Number(order.paid_paise || 0));
    return `<div class="info-strip">Order <strong>${escape(order.order_number)}</strong> has ${currency(balance)} left to collect.</div><div class="form-grid">${choice('method', 'Payment method', [['CASH', 'Cash'], ['UPI', 'UPI'], ['CARD', 'Card']], 'CASH')}${field('amount_rupees', 'Amount collected (₹)', balance / 100, 'number', 'required min="0.01" step="0.01"')}${field('reference', 'Reference / transaction ID', '', 'text', 'data-full maxlength="120"')}</div>`;
  }

  function renderOrderDetails(order) {
    const retail = (order.items || []).some(item => item.type === 'RETAIL');
    return `<div class="order-detail-summary"><strong>#${escape(order.order_number || order.id)}</strong><span>${escape(order.customer_name || 'Walk-in')} · ${whenIndia(order.created_at)}</span><span>${statusPill(order.status || 'RECEIVED')} ${statusPill(order.payment_status || 'UNPAID', order.payment_status === 'PAID' ? '' : 'warn')}</span></div><h3 class="form-divider">Items</h3><div class="mini-list">${(order.items || []).map(item => `<div class="mini-row"><span><strong>${escape(item.quantity)}× ${escape(item.name)}</strong><small>${escape(item.type)}${item.note ? ` · ${escape(item.note)}` : ''}</small></span><strong>${currency(item.total_paise)}</strong></div>`).join('')}</div><h3 class="form-divider">Payments</h3><div class="mini-list">${(order.payments || []).map(payment => `<div class="mini-row"><span><strong>${escape(payment.method)}</strong><small>${escape(payment.reference || whenIndia(payment.created_at))}</small></span><span><strong>${currency(payment.amount_paise)}</strong> ${Number(payment.amount_paise || 0) > Number(payment.refunded_paise || 0) ? `<button type="button" class="text-button" data-editor-action="refund-payment" data-payment-id="${attr(payment.id)}">Refund</button>` : statusPill('Fully refunded', 'off')}</span></div>`).join('') || '<p class="field-hint">No payment has been recorded.</p>'}</div><h3 class="form-divider">Retail returns</h3><div class="mini-list">${(order.returns || []).map(line => `<div class="mini-row"><span>${escape(line.quantity)} returned from line ${escape(line.line_no)}</span><small>${escape(line.reason || '')}</small></div>`).join('') || '<p class="field-hint">No retail items returned.</p>'}</div>${retail ? '<button type="button" class="button button-secondary" data-editor-action="return-order">Record retail return</button>' : ''}<p class="field-hint">A return updates stock. Record a payment refund separately if money is returned to the customer.</p>`;
  }

  async function openOrderDetails(id) {
    try {
      const result = await api(`/orders/${encodeURIComponent(id)}`);
      const order = result.order;
      if (!order) throw new Error('Order details were not returned.');
      state.data.orderDetails = order;
      state.editor = { kind: 'order-details', id, record: order };
      $('#editor-eyebrow').textContent = 'ORDER HISTORY';
      $('#editor-title').textContent = 'Order details';
      $('#editor-fields').innerHTML = renderOrderDetails(order);
      $('#editor-error').hidden = true;
      $('#save-editor').hidden = true;
      $('#editor-dialog').showModal();
    } catch (error) { toast(error.message || 'Could not load order details.', true); }
  }

  function returnForm(order) {
    const returned = new Map();
    for (const line of order.returns || []) returned.set(line.line_no, (returned.get(line.line_no) || 0) + Number(line.quantity || 0));
    const lines = (order.items || []).filter(item => item.type === 'RETAIL' && item.quantity > (returned.get(item.line_no) || 0));
    return `<div class="info-strip">Choose the packaged items being returned. Their tracked stock will be restored.</div><div class="recipe-lines">${lines.map(item => `<label><span>${escape(item.name)} <small>Sold ${escape(item.quantity)} · already returned ${escape(returned.get(item.line_no) || 0)}</small></span><input type="number" name="return_quantity" data-line-no="${attr(item.line_no)}" min="0" max="${attr(item.quantity - (returned.get(item.line_no) || 0))}" step="1" value="0"></label>`).join('') || '<p class="field-hint">No retail quantity remains to return.</p>'}</div>${area('reason', 'Reason for return', '', 'required maxlength="300"')}`;
  }

  function refundForm(payment) {
    const balance = Math.max(0, Number(payment.amount_paise || 0) - Number(payment.refunded_paise || 0));
    return `<div class="info-strip">${escape(payment.method)} payment of ${currency(payment.amount_paise)}. Up to ${currency(balance)} may be refunded.</div><div class="form-grid">${field('amount_rupees', 'Refund amount (₹)', balance / 100, 'number', `required min="0.01" max="${balance / 100}" step="0.01"`)}</div>${area('reason', 'Reason for refund', '', 'required maxlength="300"')}`;
  }

  function openReturnEditor() {
    const order = state.data.orderDetails;
    if (!order) return toast('Open the order again to record a return.', true);
    state.editor = { kind: 'return', id: order.id, record: order };
    $('#editor-eyebrow').textContent = 'RETAIL RETURNS';
    $('#editor-title').textContent = `Return · #${order.order_number || order.id}`;
    $('#editor-fields').innerHTML = returnForm(order);
    $('#editor-error').hidden = true;
    $('#save-editor').hidden = false;
    $('#save-editor').textContent = 'Record return';
    $('#editor-dialog').showModal();
  }

  function openRefundEditor(paymentId) {
    const payment = (state.data.orderDetails?.payments || []).find(row => row.id === paymentId);
    if (!payment) return toast('Open the order again to record a refund.', true);
    state.editor = { kind: 'refund', id: paymentId, record: payment };
    $('#editor-eyebrow').textContent = 'PAYMENT REFUND';
    $('#editor-title').textContent = 'Record refund';
    $('#editor-fields').innerHTML = refundForm(payment);
    $('#editor-error').hidden = true;
    $('#save-editor').hidden = false;
    $('#save-editor').textContent = 'Refund payment';
    $('#editor-dialog').showModal();
  }

  function staffForm(person = {}) {
    const existing = !!(person.id || person.username);
    const permissions = new Set(person.permissions || []);
    const extra = [['catalog', 'Edit catalogue & prices'], ['inventory', 'Adjust stock'], ['reports', 'View reports'], ['qr', 'Manage QR codes'], ['availability', 'Change availability'], ['refunds', 'Issue refunds / returns'], ['discounts', 'Apply manual discounts'], ['promotions', 'Manage offers'], ['settings', 'Change business settings'], ['staff', 'Manage staff'], ['pos', 'Use POS'], ['kitchen', 'Update kitchen orders'], ['orders', 'View orders'], ['payments', 'Record payments']];
    return `<div class="form-grid">${field('display_name', 'Name', person.display_name, 'text', 'required')}${field('username', 'Username', person.username, 'text', existing ? 'readonly' : 'required autocomplete="off"')}${choice('role', 'Role', [['MANAGER', 'Manager'], ['CASHIER', 'Cashier'], ['KITCHEN', 'Kitchen staff']], person.role || 'CASHIER')}${field('password', existing ? 'New password (leave blank to keep)' : 'Password', '', 'password', existing ? 'autocomplete="new-password" minlength="12" maxlength="200"' : 'required autocomplete="new-password" minlength="12" maxlength="200"')}</div>${toggle('active', 'Account enabled', person.active !== false)}<h3 class="form-divider">Extra permissions</h3><p class="field-hint">Role access applies automatically. Check any additional tools this person may use.</p><div class="option-group-list">${extra.map(([key,label]) => `<label><input type="checkbox" name="staff_permission" value="${attr(key)}" ${permissions.has(key) ? 'checked' : ''}>${escape(label)}</label>`).join('')}</div><p class="field-hint">Staff passwords need at least 12 characters.</p>`;
  }

  function promotionForm(promo = {}) {
    const categories = state.data.categories || [];
    const products = state.data.products || [];
    const categoryIds = new Set(promo.eligible_category_ids || []);
    const productIds = new Set(promo.eligible_product_ids || []);
    const type = promo.type || 'FREE_ITEM';
    const discountDisplay = type === 'PERCENT' ? Number(promo.discount_value || 0) / 100 : Number(promo.discount_value || 0) / 100;
    return `<div class="form-grid">${field('name', 'Offer name', promo.name, 'text', 'required data-full')}
      ${choice('type', 'Offer type', [['FREE_ITEM', 'Free item'], ['PERCENT', 'Percentage off'], ['FIXED', 'Fixed discount']], type)}
      ${field('threshold_rupees', 'Eligible spend must exceed (₹)', Number(promo.threshold_paise || 0) / 100, 'number', 'min="0" step="0.01"')}
      ${field('minimum_spend_rupees', 'Minimum full order (₹)', Number(promo.minimum_spend_paise || 0) / 100, 'number', 'min="0" step="0.01"')}
      <label class="form-field"><span id="discount-label">${type === 'PERCENT' ? 'Discount (%)' : 'Fixed discount (₹)'}</span><input name="discount_display" type="number" min="0" step="0.01" value="${attr(discountDisplay)}"><small class="field-hint">Used for percentage and fixed discounts only.</small></label>
      ${choice('free_product_id', 'Complimentary product', [['', 'Select a product'], ...products.filter(product => product.active).map(product => [product.id, product.name])], promo.free_product_id || (type === 'FREE_ITEM' ? 'salted-fries' : ''))}
      ${field('starts_at', 'Start date', promo.starts_at?.slice(0, 10) || '', 'date')}
      ${field('ends_at', 'End date', promo.ends_at?.slice(0, 10) || '', 'date')}
      ${field('usage_limit', 'Usage limit', promo.usage_limit ?? '', 'number', 'min="1" step="1"')}
    </div>${area('description', 'Customer-facing offer details', promo.description)}<h3 class="form-divider">Which purchases qualify?</h3><p class="field-hint">Only checked categories or products count toward the eligible spend threshold.</p>
    <div class="option-group-list">${categories.map(category => `<label><input type="checkbox" name="eligible_category" value="${attr(category.id)}" ${categoryIds.has(category.id) ? 'checked' : ''}>${escape(category.name)}</label>`).join('')}</div>
    <details class="product-eligibility"><summary>Select individual eligible products</summary><div class="option-group-list">${products.map(product => `<label><input type="checkbox" name="eligible_product" value="${attr(product.id)}" ${productIds.has(product.id) ? 'checked' : ''}>${escape(product.name)}</label>`).join('')}</div></details>
    ${toggle('active', 'Offer enabled', promo.active !== false)}`;
  }

  function qrForm(code = {}) {
    return `<div class="form-grid">${field('label', 'Label', code.label, 'text', 'required')}${choice('context', 'Ordering context', [['TABLE', 'Dine-in table'], ['GENERAL', 'General menu'], ['TAKEAWAY', 'Takeaway'], ['COUNTER', 'Counter pickup']], code.context || 'TABLE')}${field('table_number', 'Table number (for table codes)', code.table_number, 'text', 'maxlength="16"')}${toggle('active', 'QR code enabled', code.active !== false)}</div><p class="field-hint">The generated link always points to this site. Disabled codes cannot place new orders.</p>`;
  }

  function editorRecord(kind, id) {
    const key = { product: 'products', category: 'categories', option: 'optionGroups', stock: 'inventory', ingredient: 'inventory', payment: 'orders', staff: 'staff', promotion: 'promotions', qr: 'qr' }[kind];
    const data = kind === 'stock' ? [...list(state.data.inventory, 'products'), ...list(state.data.inventory, 'ingredients')]
      : kind === 'ingredient' ? list(state.data.inventory, 'ingredients') : state.data[key] || [];
    return data.find(row => String(row.id || row.username) === String(id)) || {};
  }

  function openEditor(kind, id = null) {
    const record = id ? editorRecord(kind, id) : {};
    const forms = { product: productForm, category: categoryForm, option: optionForm,
      stock: stockForm, ingredient: ingredientForm, payment: paymentForm, staff: staffForm, promotion: promotionForm, qr: qrForm };
    if (!forms[kind]) return;
    const titles = { product: 'product', category: 'category', option: 'add-on group',
      stock: 'stock', ingredient: 'ingredient', payment: 'payment', staff: 'team member', promotion: 'offer', qr: 'QR code' };
    state.editor = { kind, id, record, uploading: false };
    $('#editor-eyebrow').textContent = id ? 'UPDATE DETAILS' : 'ADD NEW';
    $('#editor-title').textContent = kind === 'stock' ? 'Adjust stock' : kind === 'payment' ? 'Record payment' : `${id ? 'Edit' : 'Add'} ${titles[kind]}`;
    $('#editor-fields').innerHTML = forms[kind](record);
    $('#editor-error').hidden = true;
    $('#save-editor').hidden = false;
    $('#save-editor').textContent = kind === 'stock' ? 'Save adjustment' : kind === 'payment' ? 'Record payment' : 'Save changes';
    $('#editor-dialog').showModal();
  }

  const fromRupees = value => Math.round((Number(value) || 0) * 100);
  const formValue = (form, name) => String(new FormData(form).get(name) || '').trim();
  const checked = (form, name) => Boolean($(`[name="${name}"]`, form)?.checked);

  function editorPayload(form, kind) {
    if (kind === 'product') {
      const payload = {
        id: formValue(form, 'id'), name: formValue(form, 'name'), category_id: formValue(form, 'category_id'),
        type: formValue(form, 'type'), description: formValue(form, 'description'),
        image_url: formValue(form, 'image_url'), price_paise: fromRupees(formValue(form, 'price_rupees')),
        mrp_paise: fromRupees(formValue(form, 'mrp_rupees')), cost_paise: fromRupees(formValue(form, 'cost_rupees')),
        sku: formValue(form, 'sku'), barcode: formValue(form, 'barcode'), brand: formValue(form, 'brand'),
        pack_size: formValue(form, 'pack_size'), veg_type: formValue(form, 'veg_type'),
        prep_minutes: Number(formValue(form, 'prep_minutes') || 0), kitchen_route: formValue(form, 'kitchen_route') === 'true',
        prep_steps: formValue(form, 'prep_steps_text').split('\n').map(step => step.trim()).filter(Boolean),
        low_stock_threshold: Number(formValue(form, 'low_stock_threshold') || 0),
        available: checked(form, 'available'), active: checked(form, 'active'), track_stock: checked(form, 'track_stock'),
        optionGroups: $$('input[name="option_group"]:checked', form).map(input => input.value),
      };
      if (!payload.id) delete payload.id;
      const tax = formValue(form, 'tax_percent');
      if (state.editor?.id || tax !== '') payload.tax_rate_bps = Math.round(Number(tax || 0) * 100);
      if (!state.editor?.id) payload.stock_quantity = Number(formValue(form, 'stock_quantity') || 0);
      return payload;
    }
    if (kind === 'ingredient') {
      const payload = { id: formValue(form, 'id'), name: formValue(form, 'name'), unit: formValue(form, 'unit'),
        low_stock_quantity: Number(formValue(form, 'low_stock_quantity') || 0),
        cost_paise_per_unit: fromRupees(formValue(form, 'cost_rupees')), active: checked(form, 'active') };
      if (!payload.id) delete payload.id;
      if (!state.editor?.id) payload.stock_quantity = Number(formValue(form, 'stock_quantity') || 0);
      return payload;
    }
    if (kind === 'recipe') {
      return { recipe: $$('[data-ingredient-id]', form).map(input => ({ ingredient_id: input.dataset.ingredientId, quantity: Number(input.value) }))
        .filter(line => Number.isFinite(line.quantity) && line.quantity > 0) };
    }
    if (kind === 'category') {
      const payload = { id: formValue(form, 'id'), name: formValue(form, 'name'),
        description: formValue(form, 'description'), image_url: formValue(form, 'image_url'),
        sort_order: Number(formValue(form, 'sort_order') || 0), active: checked(form, 'active'),
        show_qr: checked(form, 'show_qr'), show_pos: checked(form, 'show_pos'), show_retail: checked(form, 'show_retail') };
      if (!payload.id) delete payload.id;
      return payload;
    }
    if (kind === 'option') {
      const choices = formValue(form, 'choicesText').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        if (!line.includes('|')) return line;
        const [id, name, price] = line.split('|').map(part => part.trim());
        return { id, name, priceDelta: Number(price || 0) };
      });
      const payload = { id: formValue(form, 'id'), name: formValue(form, 'name'), type: formValue(form, 'type'),
        required: checked(form, 'required'), priceDelta: Number(formValue(form, 'priceDelta') || 0), choices };
      if (!payload.id) delete payload.id;
      return payload;
    }
    if (kind === 'stock') {
      const payload = { quantity_delta: Number(formValue(form, 'quantity_delta')),
        reason: formValue(form, 'reason'), batch_number: formValue(form, 'batch_number'),
        manufacturing_date: formValue(form, 'manufacturing_date'),
        expiry_date: formValue(form, 'expiry_date') };
      const cost = formValue(form, 'cost_rupees');
      if (cost) payload.cost_paise = fromRupees(cost);
      return payload;
    }
    if (kind === 'payment') return { method: formValue(form, 'method'), amount_paise: fromRupees(formValue(form, 'amount_rupees')), reference: formValue(form, 'reference') };
    if (kind === 'return') return { reason: formValue(form, 'reason'), items: $$('[data-line-no]', form)
      .map(input => ({ line_no: Number(input.dataset.lineNo), quantity: Number(input.value) }))
      .filter(line => Number.isInteger(line.quantity) && line.quantity > 0) };
    if (kind === 'refund') return { reason: formValue(form, 'reason'), amount_paise: fromRupees(formValue(form, 'amount_rupees')) };
    if (kind === 'staff') {
      const payload = { display_name: formValue(form, 'display_name'), username: formValue(form, 'username'),
        role: formValue(form, 'role'), active: checked(form, 'active'),
        permissions: $$('input[name="staff_permission"]:checked', form).map(input => input.value) };
      const password = formValue(form, 'password');
      if (password) payload.password = password;
      return payload;
    }
    if (kind === 'promotion') return { name: formValue(form, 'name'), description: formValue(form, 'description'), type: formValue(form, 'type'),
      threshold_paise: fromRupees(formValue(form, 'threshold_rupees')),
      minimum_spend_paise: fromRupees(formValue(form, 'minimum_spend_rupees')),
      discount_value: formValue(form, 'type') === 'FREE_ITEM' ? 0 : fromRupees(formValue(form, 'discount_display')),
      free_product_id: formValue(form, 'type') === 'FREE_ITEM' ? formValue(form, 'free_product_id') || null : null,
      eligible_category_ids: $$('input[name="eligible_category"]:checked', form).map(input => input.value),
      eligible_product_ids: $$('input[name="eligible_product"]:checked', form).map(input => input.value),
      starts_at: formValue(form, 'starts_at') || null, ends_at: formValue(form, 'ends_at') || null,
      usage_limit: formValue(form, 'usage_limit') ? Number(formValue(form, 'usage_limit')) : null,
      active: checked(form, 'active') };
    if (kind === 'qr') return { label: formValue(form, 'label'), context: formValue(form, 'context'),
      table_number: formValue(form, 'table_number'), active: checked(form, 'active') };
    return {};
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!state.editor || state.editor.uploading) return;
    const form = $('#editor-form');
    const { kind, id } = state.editor;
    if (kind === 'import') { await saveImport(form); return; }
    const payload = editorPayload(form, kind);
    const oldImage = ['product', 'category'].includes(kind) ? state.editor.record?.image_url : null;
    const save = $('#save-editor');
    $('#editor-error').hidden = true;
    if (kind === 'promotion') {
      let problem = '';
      if (!payload.eligible_category_ids.length && !payload.eligible_product_ids.length) problem = 'Select at least one eligible category or product.';
      else if (payload.type === 'FREE_ITEM' && !payload.free_product_id) problem = 'Select the complimentary product.';
      else if (payload.type === 'PERCENT' && payload.discount_value > 10000) problem = 'Percentage discount cannot exceed 100%.';
      else if (payload.starts_at && payload.ends_at && payload.starts_at > payload.ends_at) problem = 'End date must be on or after start date.';
      if (problem) {
        $('#editor-error').textContent = problem;
        $('#editor-error').hidden = false;
        return;
      }
    }
    if (kind === 'return' && !payload.items.length) {
      $('#editor-error').textContent = 'Choose at least one retail item to return.';
      $('#editor-error').hidden = false;
      return;
    }
    save.disabled = true;
    try {
      const base = { product: '/products', category: '/categories', option: '/option-groups', ingredient: '/ingredients',
        staff: '/staff', promotion: '/promotions', qr: '/qr' }[kind];
      if (kind === 'stock') await api(`/inventory/${encodeURIComponent(id)}/adjustments`, { method: 'POST', body: payload });
      else if (kind === 'payment') await api(`/orders/${encodeURIComponent(id)}/payments`, { method: 'POST', body: payload });
      else if (kind === 'recipe') await api(`/recipes/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
      else if (kind === 'return') await api(`/orders/${encodeURIComponent(id)}/returns`, { method: 'POST', body: payload });
      else if (kind === 'refund') await api(`/payments/${encodeURIComponent(id)}/refunds`, { method: 'POST', body: payload });
      else await api(base + (id ? `/${encodeURIComponent(id)}` : ''), { method: id ? 'PATCH' : 'POST', body: payload });
      if (oldImage && oldImage !== payload.image_url) {
        const uploaded = /^\/api\/cafe\/images\/([a-f0-9]{32})$/i.exec(oldImage);
        if (uploaded) await api(`/images/${uploaded[1]}`, { method: 'DELETE' }).catch(() => {});
      }
      $('#editor-dialog').close();
      state.editor = null;
      toast(kind === 'stock' ? 'Stock adjustment saved.' : kind === 'payment' ? 'Payment recorded.' : kind === 'return' ? 'Retail return recorded.' : kind === 'refund' ? 'Refund recorded.' : 'Changes saved.');
      await setView(state.view);
    } catch (error) {
      $('#editor-error').textContent = error.message || 'Could not save changes.';
      $('#editor-error').hidden = false;
    } finally { save.disabled = false; }
  }

  async function cropForUpload(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG or WebP image.');
    if (file.size > 12_000_000) throw new Error('Choose an image smaller than 12 MB.');
    const bitmap = await createImageBitmap(file);
    try {
      const square = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.min(900, square);
      const context = canvas.getContext('2d');
      context.fillStyle = '#f8f7f4';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, (bitmap.width - square) / 2, (bitmap.height - square) / 2,
        square, square, 0, 0, canvas.width, canvas.height);
      let quality = .9;
      let blob;
      do {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        quality -= .12;
      } while (blob && blob.size > 950_000 && quality >= .4);
      if (!blob || blob.size > 1_000_000) throw new Error('Image is still too large after cropping. Try a smaller photo.');
      return new File([blob], 'product-photo.jpg', { type: 'image/jpeg' });
    } finally { bitmap.close?.(); }
  }

  async function uploadImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const editor = state.editor;
    editor.uploading = true;
    $('#save-editor').disabled = true;
    $('#editor-error').hidden = true;
    try {
      const cropped = await cropForUpload(file);
      const form = new FormData();
      form.append('file', cropped);
      const result = await api('/images', { method: 'POST', body: form });
      const url = result.image_url || result.url;
      if (!safeImage(url)) throw new Error('Image uploaded, but its link was not returned.');
      $('input[name="image_url"]', $('#editor-form')).value = url;
      $('#image-preview').innerHTML = `<img src="${attr(url)}" alt="Uploaded square preview">`;
      toast('Photo uploaded and cropped to a square.');
    } catch (error) {
      $('#editor-error').textContent = error.message || 'Photo upload failed.';
      $('#editor-error').hidden = false;
    } finally { editor.uploading = false; $('#save-editor').disabled = false; }
  }

  function findRecord(kind, id) { return editorRecord(kind, id); }

  async function openRecipeEditor(id) {
    const product = editorRecord('product', id);
    if (!product.id) return toast('Product not found. Refresh the list.', true);
    try {
      const [ingredients, result] = await Promise.all([api('/ingredients'), api(`/recipes/${encodeURIComponent(id)}`)]);
      state.data.ingredients = list(ingredients, 'ingredients').filter(ingredient => bool(ingredient.active));
      state.editor = { kind: 'recipe', id, record: product, uploading: false };
      $('#editor-eyebrow').textContent = 'KITCHEN INVENTORY';
      $('#editor-title').textContent = `Recipe · ${product.name}`;
      $('#editor-fields').innerHTML = recipeForm(product, list(result, 'recipe'));
      $('#editor-error').hidden = true;
      $('#save-editor').hidden = false;
      $('#save-editor').textContent = 'Save recipe';
      $('#editor-dialog').showModal();
    } catch (error) { toast(error.message || 'Could not load the recipe.', true); }
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action?.startsWith('go-')) { await setView(action.slice(3)); return; }
    if (action === 'order-details') { await openOrderDetails(id); return; }
    if (action === 'import-products') { openImportEditor(); return; }
    if (action === 'edit-recipe') { await openRecipeEditor(id); return; }
    const match = action?.match(/^(add|edit|adjust|record)-(product|category|option|stock|ingredient|payment|staff|promotion|qr)$/);
    if (match) { openEditor(match[2], match[1] === 'add' ? null : id); return; }
    if (action === 'duplicate-product') {
      button.disabled = true;
      try {
        await api(`/products/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: {} });
        toast('Draft copy created. Edit and activate it when ready.');
        await setView('products');
      } catch (error) { toast(error.message || 'Could not duplicate product.', true); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'print-receipt') {
      window.open(`${apiBase}/orders/${encodeURIComponent(id)}/receipt`, '_blank', 'noopener');
      return;
    }
    if (action === 'export-reports') { exportReports(); return; }
    if (action?.startsWith('toggle-')) {
      const kind = action.slice(7);
      const record = findRecord(kind, id);
      const fieldName = kind === 'product' ? 'available' : 'active';
      const base = { product: 'products', staff: 'staff', promotion: 'promotions', qr: 'qr' }[kind];
      if (!base) return;
      button.disabled = true;
      try {
        await api(`/${base}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { [fieldName]: !bool(kind === 'product' ? record.available_setting ?? record.available : record[fieldName]) } });
        toast(kind === 'product' ? 'Availability updated.' : 'Status updated.');
        await setView(state.view);
      } catch (error) { toast(error.message || 'Could not update status.', true); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'archive-product' || action === 'delete-category' || action === 'delete-option') {
      const target = action === 'archive-product' ? 'product' : action === 'delete-category' ? 'category' : 'option';
      const record = findRecord(target, id);
      const label = record.name || id;
      if (!confirm(`${action === 'archive-product' ? 'Archive' : 'Delete'} ${label}? Existing orders will stay in your records.`)) return;
      const base = { product: 'products', category: 'categories', option: 'option-groups' }[target];
      button.disabled = true;
      try {
        await api(`/${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast(action === 'archive-product' ? 'Product archived.' : 'Removed.');
        await setView(state.view);
      } catch (error) { toast(error.message || 'Could not remove this item.', true); }
      finally { button.disabled = false; }
    }
  }

  function csvCell(value) {
    const string = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(string) ? `'${string}` : string;
    return `"${safe.replaceAll('"', '""')}"`;
  }
  function exportReports() {
    const report = state.data.reports || {};
    const rows = [['Section', 'Name', 'Units / count', 'Amount (INR)']];
    const summary = report.summary || {};
    rows.push(['Summary', 'Total sales', summary.total_orders || 0, Number(summary.total_sales_paise || 0) / 100]);
    rows.push(['Summary', 'Pending payments', '', Number(summary.pending_paise || 0) / 100]);
    rows.push(['Summary', 'Refunds', '', Number(summary.refunds_paise || 0) / 100]);
    rows.push(['Summary', 'Cancelled orders', summary.cancelled_orders || 0, '']);
    rows.push(['Product type', 'Café food and drinks', '', Number(summary.cafe_sales_paise || 0) / 100]);
    rows.push(['Product type', 'Packaged retail', '', Number(summary.retail_sales_paise || 0) / 100]);
    for (const product of list(report, 'top_products')) rows.push(['Top product', product.name || product.product_name, product.quantity || product.units || 0, Number(product.sales_paise || 0) / 100]);
    for (const category of list(report, 'category_sales')) rows.push(['Category', category.name || category.category_name, category.quantity || 0, Number(category.sales_paise || 0) / 100]);
    for (const payment of list(report, 'payments')) rows.push(['Payment method', payment.method || payment.name, payment.count || 0, Number(payment.amount_paise || payment.total_paise || 0) / 100]);
    for (const addon of list(report, 'popular_addons')) rows.push(['Popular add-on', addon.name || addon.id, addon.quantity || addon.count || 0, '']);
    for (const product of list(report, 'low_stock')) rows.push(['Low stock', product.name || product.id, product.stock_quantity || 0, '']);
    for (const product of list(report, 'slow_moving')) rows.push(['Slow moving', product.name || product.id, product.quantity || 0, '']);
    for (const ingredient of list(report, 'ingredient_consumption')) rows.push(['Ingredient consumption', `${ingredient.name || ingredient.id} (${ingredient.unit || ''})`, ingredient.consumed_quantity || 0, '']);
    const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `amul-cafe-report-${state.filters.reportRange || 'today'}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 3000);
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.target;
    const payload = {
      shop_name: formValue(form, 'shop_name'), shop_phone: formValue(form, 'shop_phone'),
      shop_address: formValue(form, 'shop_address'), gstin: formValue(form, 'gstin'),
      receipt_footer: formValue(form, 'receipt_footer'),
      default_tax_rate_bps: Math.round(Number(formValue(form, 'default_tax_rate') || 0) * 100),
      cash_enabled: checked(form, 'cash_enabled'), upi_enabled: checked(form, 'upi_enabled'),
      card_enabled: checked(form, 'card_enabled'),
    };
    const save = $('button[type="submit"]', form);
    save.disabled = true;
    try {
      await api('/settings', { method: 'PUT', body: payload });
      toast('Business settings saved.');
      await setView('settings');
    } catch (error) { toast(error.message || 'Could not save settings.', true); }
    finally { save.disabled = false; }
  }

  function showMoreMenu() {
    let menu = $('#mobile-more-menu');
    if (menu) { menu.remove(); return; }
    menu = document.createElement('div');
    menu.id = 'mobile-more-menu';
    menu.className = 'mobile-more-menu';
    menu.innerHTML = [['categories','Categories'], ['options','Add-ons'], ['reports','Reports'], ['promotions','Offers'], ['qr','QR codes'], ['staff','Staff'], ['settings','Settings']]
      .map(([view,label]) => `<button type="button" data-more-view="${view}">${escape(label)}</button>`).join('') + '<button type="button" data-more-view="logout">Sign out</button>';
    document.body.append(menu);
    menu.addEventListener('click', async event => {
      const target = event.target.closest('[data-more-view]');
      if (!target) return;
      const view = target.dataset.moreView;
      menu.remove();
      if (view === 'logout') $('#sign-out').click(); else await setView(view);
    });
  }

  function wireEvents() {
    $('#login-form').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = $('button[type="submit"]', event.target);
      submit.disabled = true;
      $('#login-error').hidden = true;
      try {
        const data = await api('/login', { method: 'POST', body: {
          username: $('#login-username').value.trim(), password: $('#login-password').value,
        } });
        $('#login-password').value = '';
        showApp(data);
        await setView('dashboard');
      } catch (error) {
        $('#login-error').textContent = error.message || 'Could not sign in.';
        $('#login-error').hidden = false;
      } finally { submit.disabled = false; }
    });
    $('#sign-out').addEventListener('click', async () => {
      try { await api('/logout', { method: 'POST', body: {} }); } catch { /* Clear view regardless. */ }
      state.data = {};
      showLogin();
    });
    $('#navigation').addEventListener('click', event => {
      const button = event.target.closest('[data-view]');
      if (button) setView(button.dataset.view);
    });
    $('.mobile-nav').addEventListener('click', event => {
      const button = event.target.closest('[data-mobile-view]');
      if (!button) return;
      if (button.dataset.mobileView === 'more') showMoreMenu();
      else { $('#mobile-more-menu')?.remove(); setView(button.dataset.mobileView); }
    });
    $('#refresh-view').addEventListener('click', () => setView(state.view));
    $('#page-content').addEventListener('click', event => {
      const action = event.target.closest('[data-action]');
      if (action) handleAction(action);
      const category = event.target.closest('[data-product-category]');
      if (category) { state.filters.productCategory = category.dataset.productCategory; renderView('products'); }
    });
    $('#page-content').addEventListener('input', event => {
      if (event.target.id === 'product-search') { state.filters.productSearch = event.target.value; renderView('products'); $('#product-search')?.focus(); }
      if (event.target.id === 'order-search') { state.filters.orderSearch = event.target.value; renderView('orders'); $('#order-search')?.focus(); }
    });
    $('#page-content').addEventListener('change', event => {
      if (event.target.id === 'product-type') { state.filters.productType = event.target.value; renderView('products'); }
      if (event.target.id === 'order-status-filter') { state.filters.orderStatus = event.target.value; renderView('orders'); }
      if (event.target.id === 'report-range') { state.filters.reportRange = event.target.value; setView('reports'); }
      if (event.target.id === 'report-from' || event.target.id === 'report-to') {
        state.filters[event.target.id === 'report-from' ? 'reportFrom' : 'reportTo'] = event.target.value;
        setView('reports');
      }
    });
    $('#page-content').addEventListener('submit', event => { if (event.target.id === 'settings-form') saveSettings(event); });
    $('#editor-form').addEventListener('submit', saveEditor);
    $('#editor-fields').addEventListener('change', event => {
      if (event.target.name === 'image_file') uploadImage(event.target);
      if (event.target.name === 'import_file' && state.editor?.kind === 'import') {
        state.editor.validated = false;
        state.editor.importFile = null;
        $('#import-preview').innerHTML = '';
        $('#save-editor').textContent = 'Check file';
      }
      if (event.target.name === 'type' && state.editor?.kind === 'promotion') {
        const label = $('#discount-label');
        if (label) label.textContent = event.target.value === 'PERCENT' ? 'Discount (%)' : 'Fixed discount (₹)';
      }
    });
    $('#editor-fields').addEventListener('click', event => {
      if (event.target.dataset.editorAction === 'download-template') downloadImportTemplate();
      if (event.target.dataset.editorAction === 'return-order') {
        $('#editor-dialog').close();
        setTimeout(openReturnEditor, 50);
      }
      if (event.target.dataset.editorAction === 'refund-payment') {
        const paymentId = event.target.dataset.paymentId;
        $('#editor-dialog').close();
        setTimeout(() => openRefundEditor(paymentId), 50);
      }
      if (event.target.dataset.editorAction === 'clear-image') {
        $('input[name="image_url"]', $('#editor-form')).value = '';
        $('#image-preview').innerHTML = '<div class="empty-image">◫</div>';
        $('input[name="image_file"]', $('#editor-form')).value = '';
      }
    });
    $('#close-editor').addEventListener('click', () => $('#editor-dialog').close());
    $('#cancel-editor').addEventListener('click', () => $('#editor-dialog').close());
    $('#editor-dialog').addEventListener('close', () => { state.editor = null; });
    window.addEventListener('online', () => $('#sync-status').classList.remove('offline'));
    window.addEventListener('offline', () => $('#sync-status').classList.add('offline'));
  }

  async function init() {
    wireEvents();
    try {
      const session = await api('/session');
      showApp(session);
      await setView('dashboard');
    } catch { showLogin(); }
  }

  init();
})();
