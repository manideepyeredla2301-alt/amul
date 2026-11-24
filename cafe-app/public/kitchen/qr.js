(() => {
  'use strict';
  const grid = document.querySelector('#qr-grid');
  const error = document.querySelector('#qr-error');

  function card(title, description, url) {
    const section = document.createElement('section');
    section.className = 'qr-card';
    const brand = document.createElement('span');
    brand.className = 'qr-brand';
    brand.textContent = 'AMUL ICE CREAM CAFÉ';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const subtitle = document.createElement('p');
    subtitle.textContent = description;
    const image = document.createElement('div');
    image.className = 'qr-image';
    image.setAttribute('role', 'img');
    image.setAttribute('aria-label', `Ordering QR code for ${title}`);
    const code = qrcode(0, 'M');
    code.addData(url, 'Byte');
    code.make();
    image.innerHTML = code.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
    const action = document.createElement('strong');
    action.className = 'qr-cta';
    action.textContent = 'SCAN · ORDER · ENJOY';
    const pay = document.createElement('span');
    pay.className = 'qr-subline';
    pay.textContent = 'Pay at the counter after ordering';
    const address = document.createElement('span');
    address.className = 'qr-url';
    address.textContent = url;
    section.append(brand, heading, subtitle, image, action, pay, address);
    return section;
  }

  function render() {
    error.hidden = true;
    const first = Number(document.querySelector('#first-table').value);
    const count = Number(document.querySelector('#table-count').value);
    if (!Number.isInteger(first) || first < 1 || first > 999 ||
        !Number.isInteger(count) || count < 1 || count > 48 || first + count - 1 > 999) {
      error.textContent = 'Choose a first table from 1 to 999 and up to 48 consecutive tables.';
      error.hidden = false;
      return;
    }
    const origin = window.location.origin;
    const fragment = document.createDocumentFragment();
    if (document.querySelector('#include-counter').checked) {
      fragment.append(card('Order at the counter', 'Browse the café menu', `${origin}/`));
    }
    for (let table = first; table < first + count; table += 1) {
      fragment.append(card(`Table ${table}`, 'Your table is already selected', `${origin}/?table=${table}`));
    }
    grid.replaceChildren(fragment);
  }

  document.querySelector('#generate').addEventListener('click', render);
  document.querySelector('#print').addEventListener('click', () => window.print());
  document.querySelectorAll('#first-table, #table-count, #include-counter').forEach((input) => {
    input.addEventListener('change', render);
  });

  fetch('/api/cafe/admin/session', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => {
      if (response.status === 401) { window.location.replace('/kitchen/'); return; }
      if (!response.ok) throw new Error('Could not verify staff access.');
      render();
    })
    .catch((cause) => {
      error.textContent = cause.message || 'Could not load QR cards.';
      error.hidden = false;
    });
})();
