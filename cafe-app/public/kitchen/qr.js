(() => {
  'use strict';
  const grid = document.querySelector('#qr-grid');
  const error = document.querySelector('#qr-error');
  let codes = [];

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) { location.replace('/kitchen/'); throw new Error('Sign in to continue.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function selected() {
    const first = Number(document.querySelector('#first-table').value);
    const count = Number(document.querySelector('#table-count').value);
    if (!Number.isInteger(first) || first < 1 || first > 999 ||
        !Number.isInteger(count) || count < 1 || count > 48 || first + count - 1 > 999) {
      throw new Error('Choose a first table from 1 to 999 and up to 48 consecutive tables.');
    }
    const wanted = [];
    if (document.querySelector('#include-general').checked) wanted.push({ context: 'GENERAL', label: 'General café' });
    if (document.querySelector('#include-counter').checked) wanted.push({ context: 'COUNTER', label: 'Counter pickup' });
    if (document.querySelector('#include-takeaway').checked) wanted.push({ context: 'TAKEAWAY', label: 'Takeaway' });
    for (let table = first; table < first + count; table += 1) {
      wanted.push({ context: 'TABLE', label: `Table ${table}`, table_number: String(table) });
    }
    return wanted;
  }

  function matchingCode(target) {
    return codes.find(code => code.context === target.context &&
      (target.context !== 'TABLE' || String(code.table_number) === target.table_number));
  }

  function card(code) {
    const url = new URL(code.url || `/?qr=${encodeURIComponent(code.id)}`, location.origin).toString();
    const section = document.createElement('section');
    section.className = 'qr-card';
    const brand = document.createElement('span');
    brand.className = 'qr-brand';
    brand.textContent = 'AMUL ICE CREAM CAFÉ';
    const heading = document.createElement('h2');
    heading.textContent = code.label;
    const subtitle = document.createElement('p');
    subtitle.textContent = code.context === 'TABLE' ? 'Your table is already selected' : 'Scan to browse and order';
    const image = document.createElement('div');
    image.className = 'qr-image';
    image.setAttribute('role', 'img');
    image.setAttribute('aria-label', `Ordering QR code for ${code.label}`);
    const qr = qrcode(0, 'M');
    qr.addData(url, 'Byte');
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
    image.innerHTML = svg;
    const action = document.createElement('strong');
    action.className = 'qr-cta';
    action.textContent = 'SCAN · ORDER · ENJOY';
    const pay = document.createElement('span');
    pay.className = 'qr-subline';
    pay.textContent = 'Pay at the café after ordering';
    const address = document.createElement('span');
    address.className = 'qr-url';
    address.textContent = url;
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'qr-download no-print';
    download.textContent = 'Download SVG';
    download.addEventListener('click', () => {
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `amul-cafe-${code.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    section.append(brand, heading, subtitle, image, action, pay, address, download);
    return section;
  }

  function render() {
    try {
      const fragment = document.createDocumentFragment();
      let inactive = 0;
      for (const target of selected()) {
        const code = matchingCode(target);
        if (code?.active) fragment.append(card(code));
        else if (code) inactive += 1;
      }
      grid.replaceChildren(fragment);
      showError(inactive ? `${inactive} disabled code${inactive === 1 ? ' is' : 's are'} omitted. Enable them in the admin dashboard if needed.` : '');
      if (!grid.children.length && !inactive) showError('No matching codes yet. Select Create missing codes.');
    } catch (cause) { showError(cause.message); }
  }

  async function refresh() {
    const result = await api('/api/cafe/admin/qr');
    codes = Array.isArray(result.codes) ? result.codes : [];
    render();
  }

  document.querySelector('#generate').addEventListener('click', async () => {
    const button = document.querySelector('#generate');
    button.disabled = true;
    try {
      for (const target of selected()) {
        if (!matchingCode(target)) await api('/api/cafe/admin/qr', target);
      }
      await refresh();
    } catch (cause) { showError(cause.message); }
    finally { button.disabled = false; }
  });
  document.querySelector('#print').addEventListener('click', () => window.print());
  document.querySelectorAll('#first-table, #table-count, #include-general, #include-counter, #include-takeaway')
    .forEach(input => input.addEventListener('change', render));
  refresh().catch(cause => showError(cause.message));
})();
