import test from 'node:test';
import assert from 'node:assert/strict';
import posWorker from '../src/pos-worker.js';

test('separate POS address opens the counter page', async () => {
  const response = await posWorker.fetch(new Request('https://pos.example/'), {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://pos.example/pos/');
});

test('POS address keeps the shared café API available', async () => {
  const response = await posWorker.fetch(new Request('https://pos.example/api/cafe/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'frostflow-cafe' });
});
