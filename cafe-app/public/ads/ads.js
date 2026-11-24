'use strict';

(() => {
  const SLIDE_MS = 6000;
  const REFRESH_MS = 5 * 60 * 1000;
  const OFFER_STALE_MS = 15 * 60 * 1000;
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const currency = paise => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2,
  }).format(Number(paise || 0) / 100);
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = {
    menu: null, slides: [], index: 0, elapsed: 0, lastFrame: 0, frame: 0,
    playing: !prefersReducedMotion, refreshing: false, lastSuccess: 0, refreshFailed: false,
  };

  function safeImage(path) {
    if (!path) return '';
    try {
      const url = new URL(String(path), location.origin);
      return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function imageFor(item, category) {
    return safeImage(item?.image_url || category?.image_url || '/images/hero-sundae.jpg');
  }
  function priceFor(item) {
    const prefix = (item?.optionGroups || []).includes('sundae-size') ? 'From ' : '';
    return prefix + currency(item?.price_paise ?? Math.round(Number(item?.price || 0) * 100));
  }
  function allProducts() {
    return (state.menu?.categories || []).flatMap(category => (category.items || []).map(item => ({ item, category })));
  }
  function availableFrom(ids) {
    const wanted = new Set(ids);
    return allProducts().filter(({ item, category }) => wanted.has(category.id) && item.available);
  }
  function firstFrom(id) { return availableFrom([id])[0]; }
  function product(id) { return allProducts().find(entry => entry.item.id === id); }
  function selectedFrom(ids, limit = 3) {
    return ids.map(firstFrom).filter(Boolean).slice(0, limit);
  }
  function offerName(offer) {
    if (offer?.name) return String(offer.name);
    if (offer?.type === 'FREE_ITEM') {
      const gift = product(offer.complimentary_product_id)?.item.name;
      return gift ? `Complimentary ${gift}` : 'A little something extra';
    }
    if (offer?.type === 'PERCENT' && Number(offer.discount_value) > 0)
      return `${(Number(offer.discount_value) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}% off eligible items`;
    if (offer?.type === 'FIXED' && Number(offer.discount_value) > 0)
      return `${currency(offer.discount_value)} off eligible items`;
    return 'Today’s café offer';
  }
  function offerDetails(offer) {
    const details = [];
    if (Number(offer?.threshold_paise) > 0) details.push(`Eligible spend over ${currency(offer.threshold_paise)}`);
    if (Number(offer?.minimum_spend_paise) > 0) {
      details.push(`Order minimum ${currency(offer.minimum_spend_paise)}`);
    }
    if (offer?.type === 'FREE_ITEM') {
      const gift = product(offer.complimentary_product_id)?.item.name;
      if (gift && !offerName(offer).toLowerCase().includes(gift.toLowerCase())) details.push(`Includes ${gift}`);
    }
    return details.join(' · ');
  }
  function currentOffers() {
    if (!state.menu || Date.now() - state.lastSuccess > OFFER_STALE_MS) return [];
    return Array.isArray(state.menu.offers) ? state.menu.offers : [];
  }
  function slideData() {
    const available = allProducts().filter(({ item }) => item.available);
    const introHero = firstFrom('signature-sundaes') || available[0];
    const ice = selectedFrom(['scoops', 'signature-sundaes', 'build-your-own-sundae'], 3);
    const coffee = selectedFrom(['cold-coffees', 'coffee-frappes', 'dessert-frappes'], 3);
    const cool = selectedFrom(['milkshakes', 'thickshakes', 'mojitos'], 3);
    const burger = availableFrom(['burgers']).slice(0, 2);
    const savoury = [...burger, ...selectedFrom(['sandwiches'], 1)].slice(0, 3);
    const snacks = selectedFrom(['fries', 'momos', 'nuggets', 'maggi'], 4);
    const cheese = Number(state.menu?.optionGroups?.['burger-cheese']?.priceDelta);
    const slides = [
      { id: 'welcome', kicker: 'MADE FOR HAPPY MOMENTS', lines: ['A little joy,', 'made to order.'],
        description: 'Ice cream, coffee and café favourites. Find a treat for every mood.',
        items: [], image: '/images/hero-sundae.jpg', alt: 'Ice cream sundae', sticker: 'MADE FRESH', label: 'WELCOME' },
      { id: 'ice-cream', kicker: 'SCOOP INTO HAPPINESS', lines: ['Your ice cream', 'moment starts here.'],
        description: firstFrom('scoops')
          ? 'A scoop in a cup or cone, signature sundaes and build-your-own treats.'
          : 'Signature sundaes and a build-your-own scoop experience.',
        items: ice, image: imageFor(ice[0]?.item || introHero?.item, ice[0]?.category || introHero?.category),
        alt: ice[0]?.item.name || 'Ice cream sundae', sticker: 'SCOOPED WITH LOVE', label: 'ICE CREAM' },
      { id: 'coffee', kicker: 'THE PERFECT PICK-ME-UP', lines: ['Sip something', 'wonderful.'],
        description: 'Cold coffees, coffee frappes and dessert frappes for every kind of break.',
        items: coffee, image: imageFor(coffee[0]?.item, coffee[0]?.category),
        alt: coffee[0]?.item.name || 'Café coffee', sticker: 'CHILL & SIP', label: 'COFFEE & FRAPPES' },
      { id: 'shakes', kicker: 'CHILLED TO PERFECTION', lines: ['Shakes, sips', '& sunny days.'],
        description: 'Classic milkshakes, thickshakes and refreshing mojitos.',
        items: cool, image: imageFor(cool[0]?.item, cool[0]?.category),
        alt: cool[0]?.item.name || 'Café milkshake', sticker: 'COOL DOWN', label: 'SHAKES & REFRESHERS' },
      { id: 'savoury', kicker: 'HUNGRY FOR MORE?', lines: ['Meet your new', 'café favourite.'],
        description: 'Juicy burgers and freshly made sandwiches, just the way you like them.',
        items: savoury, image: imageFor(savoury[0]?.item, savoury[0]?.category),
        alt: savoury[0]?.item.name || 'Café burger', sticker: 'FRESHLY MADE',
        note: Number.isFinite(cheese) && cheese > 0 && burger.length ? `Add an Amul cheese slice to a burger for ${currency(cheese * 100)}` : '',
        label: 'BURGERS & SANDWICHES' },
      { id: 'snacks', kicker: 'A LITTLE SOMETHING SAVOURY', lines: ['Snack happy,', 'stay longer.'],
        description: 'Fries, momos, nuggets and Maggi for the whole table.',
        items: snacks, image: imageFor(snacks[0]?.item, snacks[0]?.category),
        alt: snacks[0]?.item.name || 'Café snack', sticker: 'HOT & FRESH', label: 'SNACK TIME' },
    ];
    const offers = currentOffers();
    if (offers.length) {
      const free = offers.find(offer => offer.type === 'FREE_ITEM');
      const gift = free ? product(free.complimentary_product_id) : null;
      slides.push({ id: 'offers', kicker: 'CURRENT CAFÉ OFFERS', lines: ['More reasons', 'to say yes.'],
        description: offers.length === 1 ? 'A little extra joy is waiting with your next café order.' : `${offers.length} current offers to explore at the café.`,
        offerNames: offers.slice(0, 2).map(offerName), items: [],
        image: imageFor(gift?.item, gift?.category) || '/images/hero-sundae.jpg',
        alt: gift?.item.name || 'Café dessert', sticker: 'A LITTLE EXTRA', label: 'OFFERS' });
    }
    return slides;
  }
  function renderSlide(manual = false) {
    const current = state.slides[state.index];
    if (!current) return;
    const itemPills = (current.items || []).map(({ item }) =>
      `<span class="slide-item"><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(priceFor(item))}</strong></span>`).join('');
    const offerPills = (current.offerNames || []).map(name =>
      `<span class="slide-item"><span>${escapeHtml(name)}</span></span>`).join('');
    const photo = safeImage(current.image) || '/images/hero-sundae.jpg';
    $('#slide').innerHTML = `<div class="slide-copy"><span class="slide-kicker">${escapeHtml(current.kicker)}</span>
      <h2>${escapeHtml(current.lines[0])}<br><em>${escapeHtml(current.lines[1])}</em></h2>
      <p class="slide-description">${escapeHtml(current.description)}</p>
      ${(itemPills || offerPills) ? `<div class="slide-items">${itemPills || offerPills}</div>` : ''}
      ${current.note ? `<span class="slide-note">${escapeHtml(current.note)}</span>` : ''}</div>
      <div class="slide-visual"><img src="${escapeHtml(photo)}" alt="${escapeHtml(current.alt)}" decoding="async"><span class="slide-sticker">${escapeHtml(current.sticker)}</span></div>`;
    const image = $('#slide img');
    image?.addEventListener('error', () => image.classList.add('image-missing'), { once: true });
    $('#slide').classList.remove('enter');
    void $('#slide').offsetWidth;
    $('#slide').classList.add('enter');
    $('#slide-count').textContent = `${String(state.index + 1).padStart(2, '0')} / ${String(state.slides.length).padStart(2, '0')}`;
    $('#slide-label').textContent = current.label;
    if (manual) $('#slide-announcement').textContent = `${current.label}, slide ${state.index + 1} of ${state.slides.length}`;
    updateProgress();
  }
  function renderOffers() {
    const offers = currentOffers();
    $('#offers').hidden = offers.length === 0;
    $('#offers-link').hidden = offers.length === 0;
    $('#offer-list').innerHTML = offers.map(offer => `<article class="offer-card"><span class="offer-badge">CURRENT OFFER</span>
      <h3>${escapeHtml(offerName(offer))}</h3>
      ${offer.description ? `<p>${escapeHtml(offer.description)}</p>` : ''}
      ${offerDetails(offer) ? `<span class="offer-detail">${escapeHtml(offerDetails(offer))}</span>` : ''}</article>`).join('');
  }
  function renderMenu() {
    const categories = Array.isArray(state.menu?.categories) ? state.menu.categories : [];
    $('#menu-categories').innerHTML = categories.filter(category => (category.items || []).length).map(category =>
      `<a href="#menu-${escapeHtml(category.id)}">${escapeHtml(category.name)}</a>`).join('');
    $('#menu-groups').innerHTML = categories.filter(category => (category.items || []).length).map((category, index) => {
      const cards = category.items.map(item => {
        const photo = imageFor(item, category);
        return `<article class="menu-card${item.available ? '' : ' is-unavailable'}">
          <div class="menu-photo">${photo ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(item.image_url ? item.name : category.name + ' selection')}" loading="lazy" decoding="async">` : ''}</div>
          <div class="menu-card-copy"><div class="menu-card-top"><h4>${escapeHtml(item.name)}</h4><span class="menu-price">${escapeHtml(priceFor(item))}</span></div>
          ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
          ${item.available ? '' : '<span class="unavailable-label">Currently unavailable</span>'}</div></article>`;
      }).join('');
      return `<section id="menu-${escapeHtml(category.id)}" class="menu-category" aria-labelledby="category-${escapeHtml(category.id)}">
        <div class="category-heading"><div><h3 id="category-${escapeHtml(category.id)}">${escapeHtml(category.name)}</h3>${category.description ? `<p>${escapeHtml(category.description)}</p>` : ''}</div><span class="category-number">${String(index + 1).padStart(2, '0')} / ${String(categories.length).padStart(2, '0')}</span></div>
        <div class="menu-grid">${cards}</div></section>`;
    }).join('') || '<p class="menu-loading">The café menu is being updated. Please check again soon.</p>';
    $$('.menu-photo img').forEach(image => image.addEventListener('error', () => image.remove(), { once: true }));
  }
  function $$(selector) { return Array.from(document.querySelectorAll(selector)); }
  function updateStatus() {
    const status = $('#menu-status');
    if (!state.lastSuccess) { status.textContent = 'CONNECTING TO THE CAFÉ'; return; }
    if (state.refreshFailed) {
      const when = new Date(state.lastSuccess).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
      status.textContent = `LAST UPDATED ${when} · RECONNECTING`;
      $('.stage-live').classList.add('is-stale');
    } else {
      status.textContent = 'LIVE CAFÉ MENU';
      $('.stage-live').classList.remove('is-stale');
    }
  }
  function renderAll() {
    renderMenu();
    renderOffers();
    const oldId = state.slides[state.index]?.id;
    state.slides = slideData();
    state.index = Math.max(0, state.slides.findIndex(slide => slide.id === oldId));
    if (state.index >= state.slides.length) state.index = 0;
    state.elapsed = 0;
    renderSlide();
    setControlsEnabled(true);
    updateStatus();
    syncPlayback();
  }
  function setControlsEnabled(enabled) {
    ['#previous-slide', '#play-pause', '#next-slide', '#fullscreen'].forEach(selector => { $(selector).disabled = !enabled; });
  }
  async function refreshMenu() {
    if (state.refreshing) return;
    state.refreshing = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/cafe/menu', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Menu unavailable (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data.categories)) throw new Error('Menu response is incomplete');
      state.menu = data;
      state.lastSuccess = Date.now();
      state.refreshFailed = false;
      renderAll();
    } catch {
      state.refreshFailed = true;
      updateStatus();
      if (state.menu) {
        if (Date.now() - state.lastSuccess > OFFER_STALE_MS) renderAll();
      } else {
        $('#slide').innerHTML = '<div class="stage-loading"><span aria-hidden="true">✳</span><p>We could not load today’s menu.</p><button id="retry-menu" type="button">Try again</button></div>';
        $('#retry-menu').addEventListener('click', refreshMenu);
        $('#menu-groups').innerHTML = '<p class="menu-loading">The menu is temporarily unavailable. Please try again.</p>';
      }
    } finally {
      clearTimeout(timeout);
      state.refreshing = false;
    }
  }
  function updateProgress() {
    $('#progress-bar').style.width = `${Math.min(100, (state.elapsed / SLIDE_MS) * 100)}%`;
  }
  function stopFrame() {
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = 0;
    state.lastFrame = 0;
  }
  function tick(time) {
    if (!state.playing || document.hidden || !state.slides.length) { stopFrame(); return; }
    if (state.lastFrame) state.elapsed += Math.min(100, time - state.lastFrame);
    state.lastFrame = time;
    if (state.elapsed >= SLIDE_MS) {
      state.index = (state.index + 1) % state.slides.length;
      state.elapsed = 0;
      renderSlide();
    } else updateProgress();
    state.frame = requestAnimationFrame(tick);
  }
  function syncPlayback() {
    $('#play-pause').textContent = state.playing ? 'Pause' : 'Play';
    $('#play-pause').setAttribute('aria-label', state.playing ? 'Pause commercial' : 'Play commercial');
    stopFrame();
    if (state.playing && !document.hidden && state.slides.length) state.frame = requestAnimationFrame(tick);
  }
  function move(delta) {
    if (!state.slides.length) return;
    state.index = (state.index + delta + state.slides.length) % state.slides.length;
    state.elapsed = 0;
    renderSlide(true);
    syncPlayback();
  }

  $('#previous-slide').addEventListener('click', () => move(-1));
  $('#next-slide').addEventListener('click', () => move(1));
  $('#play-pause').addEventListener('click', () => { state.playing = !state.playing; syncPlayback(); });
  $('#fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('#stage').requestFullscreen();
    } catch { $('#slide-announcement').textContent = 'Full screen is unavailable in this browser.'; }
  });
  document.addEventListener('fullscreenchange', () => {
    const full = Boolean(document.fullscreenElement);
    $('#fullscreen').innerHTML = full ? '⤢ <span>Exit full screen</span>' : '⛶ <span>Full screen</span>';
    $('#fullscreen').setAttribute('aria-label', full ? 'Exit full screen' : 'Show commercial full screen');
  });
  document.addEventListener('visibilitychange', syncPlayback);
  $('#stage').addEventListener('keydown', event => {
    if (event.target !== $('#stage')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  });
  setInterval(refreshMenu, REFRESH_MS);
  setInterval(() => {
    if (state.menu && Date.now() - state.lastSuccess > OFFER_STALE_MS && currentOffers().length === 0 && $('#offers').hidden === false) renderAll();
  }, 60 * 1000);
  syncPlayback();
  refreshMenu();
})();
