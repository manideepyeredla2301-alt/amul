import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

test('short ads address opens the display page and keeps its query', async () => {
  const response = await worker.fetch(new Request('https://cafe.example/ads?display=tv'), {});
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('Location'), 'https://cafe.example/ads/?display=tv');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});
