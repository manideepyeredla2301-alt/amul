(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    login: $('#login-view'), app: $('#app-view'), loginForm: $('#login-form'),
    loginError: $('#login-error'), notice: $('#notice'), list: $('#order-list'),
    empty: $('#empty-state'), search: $('#search'), connection: $('#connection'),
    lastUpdated: $('#last-updated'), visibleCount: $('#visible-count'),
    listTitle: $('#list-title'),
  };
  const statusLabel = {
    RECEIVED: 'New', PREPARING: 'Preparing', READY: 'Ready',
    COMPLETED: 'Completed', CANCELLED: 'Cancelled',
  };
  const optionNames = {
    'burger-cheese': 'Amul cheese slice', 'sandwich-bread': 'Whole wheat bread',
    'sandwich-cheese': 'Extra cheese', 'sandwich-egg': 'Extra egg',
    'sandwich-paneer': 'Extra paneer', 'sandwich-chicken': 'Extra chicken',
    'sundae-size': 'Size', 'sundae-flavors': 'Flavours',
    'sundae-serving': 'Serving', 'sundae-sauce': 'Sauce',
    'sundae-topping': 'Topping', 'sundae-extras': 'Extras',
  };
  const choiceNames = {
    single: 'Single scoop', double: 'Double scoop', triple: 'Triple scoop',
    cup: 'Cup', 'waffle-cone': 'Waffle cone', 'waffle-bowl': 'Waffle bowl',
    'additional-topping': 'Additional topping', 'additional-sauce': 'Additional sauce',
    'whipped-cream': 'Whipped cream',
  };
  const state = { orders: [], filter: 'ACTIVE', busy: false, lastSnapshot: '', firstLoad: true };

  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const money = (paise) => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format((Number(paise) || 0) / 100);

  function parseDate(value) {
    if (!value) return new Date(NaN);
    const text = String(value).trim().replace(' ', 'T');
    return new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : `${text}Z`);
  }

  function orderTime(value) {
    const date = parseDate(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit',
      hour12: true, timeZone: 'Asia/Kolkata' }).format(date);
  }

  function todayInIndia(value) {
    const date = parseDate(value);
    if (Number.isNaN(date.getTime())) return false;
    const format = (dateValue) => new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata',
    }).format(dateValue);
    return format(date) === format(new Date());
  }

  function setConnection(online) {
    elements.connection.classList.toggle('offline', !online);
    elements.connection.innerHTML = `<i aria-hidden="true"></i> ${online ? 'Live' : 'Reconnecting'}`;
  }

  function notice(message, isError = false) {
    elements.notice.textContent = message;
    elements.notice.style.background = isError ? '#fff0eb' : '';
    elements.notice.style.borderColor = isError ? '#edc6b8' : '';
    elements.notice.hidden = !message;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showLogin() {
    elements.login.hidden = false;
    elements.app.hidden = true;
    document.title = 'Staff sign in · Amul Café';
    state.firstLoad = true;
    state.lastSnapshot = '';
  }

  function showApp() {
    elements.login.hidden = true;
    elements.app.hidden = false;
    document.title = 'Café kitchen · FrostFlow';
    $('#today-date').textContent = new Intl.DateTimeFormat('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata',
    }).format(new Date());
  }

  function humanizeChoice(value) {
    return choiceNames[value] || String(value).replace(/[-_]/g, ' ');
  }

  function itemOptions(value) {
    let options = value;
    if (typeof options === 'string') {
      try { options = JSON.parse(options); } catch { return options; }
    }
    if (!options || typeof options !== 'object') return '';
    const entries = Array.isArray(options) ? options.map((entry) => ['', entry]) : Object.entries(options);
    return entries.flatMap(([group, selected]) => {
      if (selected === false || selected === null || selected === '' || selected === undefined) return [];
      const name = optionNames[group] || group.replace(/[-_]/g, ' ');
      if (selected === true) return [name];
      const choices = Array.isArray(selected) ? selected : [selected];
      if (choices.length === 0) return [];
      const list = choices.map(humanizeChoice).join(', ');
      return [group ? `${name}: ${list}` : list];
    }).join(' · ');
  }

  function orderCard(order) {
    const status = String(order.status || 'RECEIVED').toUpperCase();
    const cssStatus = status.toLowerCase();
    const items = Array.isArray(order.items) ? order.items : [];
    const service = order.service_type === 'TAKEAWAY' ? 'Takeaway' : 'Dine in';
    const table = order.service_type === 'TAKEAWAY' ? 'Collection' : `Table ${order.table_number || '—'}`;
    const primary = { RECEIVED: ['PREPARING', 'Start preparing'], PREPARING: ['READY', 'Mark ready'], READY: ['COMPLETED', 'Complete order'] }[status];
    const canCancel = status === 'RECEIVED' || status === 'PREPARING';
    const itemMarkup = items.map((item) => {
      const options = itemOptions(item.options);
      const steps = Array.isArray(item.prep_steps) ? item.prep_steps : [];
      const prep = steps.length ? `<details class="prep-details" ${['RECEIVED', 'PREPARING'].includes(status) ? 'open' : ''}><summary>How to prepare</summary><ol>${steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol></details>` : '';
      return `<li class="order-item"><div class="item-main"><span class="item-qty">${escape(item.quantity)}×</span><div><span class="item-name">${escape(item.name)}</span>${options ? `<div class="item-options">${escape(options)}</div>` : ''}${prep}</div></div><span class="item-price">${money(item.total_paise)}</span></li>`;
    }).join('');
    return `<article class="order-card ${escape(cssStatus)}" data-id="${escape(order.id)}">
      <div class="card-head"><div class="head-row"><strong class="order-number">#${escape(order.order_number || String(order.id).slice(0, 8))}</strong><span class="order-time">${escape(orderTime(order.created_at))}</span></div>
      <div class="order-meta"><span class="status-pill ${escape(cssStatus)}">${escape(statusLabel[status] || status)}</span><span class="service-pill">${escape(service)}</span></div>
      <div class="customer-line"><span class="customer-name">${escape(order.customer_name || 'Guest')}</span><span class="table-label">${escape(table)}</span></div></div>
      <div class="card-body"><div class="items-title">${items.length} ITEM${items.length === 1 ? '' : 'S'}</div><ul class="order-items">${itemMarkup}</ul>${order.note ? `<div class="order-note"><strong>Customer instructions</strong>${escape(order.note)}</div>` : ''}</div>
      <div class="card-foot"><div class="order-total"><small>Total · Pay at counter</small><strong>${money(order.total_paise)}</strong></div>
      <div class="card-actions">${canCancel ? `<button type="button" class="action-button cancel" data-action="CANCELLED" data-id="${escape(order.id)}">Cancel</button>` : ''}${primary ? `<button type="button" class="action-button" data-action="${primary[0]}" data-id="${escape(order.id)}">${primary[1]}</button>` : ''}</div></div></article>`;
  }

  function render() {
    const counts = { RECEIVED: 0, PREPARING: 0, READY: 0, COMPLETED: 0 };
    for (const order of state.orders) {
      const status = String(order.status || '').toUpperCase();
      if (counts[status] !== undefined && (status !== 'COMPLETED' || todayInIndia(order.updated_at || order.created_at))) counts[status] += 1;
    }
    $('#count-received').textContent = counts.RECEIVED;
    $('#count-preparing').textContent = counts.PREPARING;
    $('#count-ready').textContent = counts.READY;
    $('#count-completed').textContent = counts.COMPLETED;
    document.title = counts.RECEIVED ? `(${counts.RECEIVED}) Café kitchen · FrostFlow` : 'Café kitchen · FrostFlow';

    const search = elements.search.value.trim().toLocaleLowerCase();
    const visible = state.orders.filter((order) => {
      const status = String(order.status || '').toUpperCase();
      if (state.filter === 'ACTIVE' && !['RECEIVED', 'PREPARING', 'READY'].includes(status)) return false;
      if (state.filter !== 'ACTIVE' && status !== state.filter) return false;
      if (!search) return true;
      const haystack = [order.order_number, order.customer_name, order.table_number,
        ...(order.items || []).map((item) => item.name)].join(' ').toLocaleLowerCase();
      return haystack.includes(search);
    });
    const priority = { RECEIVED: 0, PREPARING: 1, READY: 2, COMPLETED: 3, CANCELLED: 4 };
    visible.sort((a, b) => {
      if (state.filter === 'ACTIVE') {
        const rank = (priority[a.status] ?? 5) - (priority[b.status] ?? 5);
        if (rank) return rank;
        return parseDate(a.created_at) - parseDate(b.created_at);
      }
      return parseDate(b.created_at) - parseDate(a.created_at);
    });
    elements.list.innerHTML = visible.map(orderCard).join('');
    elements.empty.hidden = visible.length > 0;
    elements.visibleCount.textContent = `${visible.length} order${visible.length === 1 ? '' : 's'}`;
    elements.listTitle.textContent = state.filter === 'ACTIVE' ? 'Active queue' : `${statusLabel[state.filter] || state.filter} orders`;
  }

  async function loadOrders({ manual = false } = {}) {
    if (state.busy || elements.app.hidden || (!manual && document.hidden)) return;
    state.busy = true;
    try {
      const data = await api('/api/cafe/admin/orders');
      const orders = Array.isArray(data.orders) ? data.orders : [];
      const snapshot = JSON.stringify(orders);
      if (snapshot !== state.lastSnapshot || state.firstLoad) {
        state.orders = orders;
        state.lastSnapshot = snapshot;
        render();
        state.firstLoad = false;
      }
      elements.lastUpdated.textContent = `Updated ${new Intl.DateTimeFormat('en-IN', {
        hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
      }).format(new Date())}`;
      setConnection(true);
      if (manual) notice('Orders are up to date.');
    } catch (error) {
      if (error.status === 401) { showLogin(); return; }
      setConnection(false);
      if (manual || state.firstLoad) notice('Could not refresh orders. We will retry automatically.', true);
    } finally { state.busy = false; }
  }

  async function changeStatus(id, status, button) {
    if (status === 'CANCELLED' && !confirm('Cancel this order? The customer will see the cancellation.')) return;
    button.disabled = true;
    try {
      await api(`/api/cafe/admin/orders/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } });
      notice(status === 'CANCELLED' ? 'Order cancelled.' : `Order marked ${statusLabel[status].toLowerCase()}.`);
      state.lastSnapshot = '';
      await loadOrders({ manual: false });
    } catch (error) {
      if (error.status === 401) { showLogin(); return; }
      notice(error.message || 'Could not update this order.', true);
    } finally { button.disabled = false; }
  }

  elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = elements.loginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    elements.loginError.hidden = true;
    try {
      await api('/api/cafe/admin/login', { method: 'POST', body: {
        username: $('#username').value.trim(), password: $('#password').value,
      } });
      $('#password').value = '';
      showApp();
      await loadOrders();
    } catch (error) {
      elements.loginError.textContent = error.status === 401 ? 'Username or password was incorrect.' : (error.message || 'Could not sign in. Please try again.');
      elements.loginError.hidden = false;
    } finally { button.disabled = false; }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('/api/cafe/admin/logout', { method: 'POST', body: {} }); }
    catch { /* Clearing the visible board still protects customer details. */ }
    state.orders = [];
    elements.list.innerHTML = '';
    showLogin();
  });
  $('#refresh').addEventListener('click', () => loadOrders({ manual: true }));
  elements.search.addEventListener('input', render);
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    render();
  }));
  elements.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) changeStatus(button.dataset.id, button.dataset.action, button);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadOrders(); });
  window.setInterval(() => loadOrders(), 8000);

  api('/api/cafe/admin/session').then(() => { showApp(); loadOrders(); }).catch(() => showLogin());
})();
