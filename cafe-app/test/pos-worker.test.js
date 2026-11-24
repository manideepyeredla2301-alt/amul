import test from 'node:test';
import assert from 'node:assert/strict';
import posWorker from '../src/pos-worker.js';

test('legacy POS address opens the counter page on the unified café site', async () => {
  const env = { CAFE_CANONICAL_ORIGIN: 'https://cafe.example' };
  const response = await posWorker.fetch(new Request('https://pos.example/'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://cafe.example/pos/');
  const saved = await posWorker.fetch(new Request('https://pos.example/pos/?held=1'), env);
  assert.equal(saved.headers.get('Location'), 'https://cafe.example/pos/?held=1');
  const admin = await posWorker.fetch(new Request('https://pos.example/admin/?view=products'), env);
  assert.equal(admin.headers.get('Location'), 'https://cafe.example/admin/?view=products');
  const ads = await posWorker.fetch(new Request('https://pos.example/ads?display=tv'), env);
  assert.equal(ads.headers.get('Location'), 'https://cafe.example/ads/?display=tv');
});

test('POS address keeps the shared café API available', async () => {
  const response = await posWorker.fetch(new Request('https://pos.example/api/cafe/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'frostflow-cafe' });
});
