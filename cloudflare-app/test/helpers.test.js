import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogueReply,catalogueRequested,cleanPhone,equalSecret} from '../src/worker.js';

test('constant-time secret comparison and phone normalization',async()=>{
  assert.equal(await equalSecret('same','same'),true);
  assert.equal(await equalSecret('same','different'),false);
  assert.equal(cleanPhone('+91 90140 03991'),'919014003991');
  assert.throws(()=>cleanPhone('123'));
});

test('catalogue auto reply is explicit, useful and recognizes catalogue requests',()=>{
  const url='https://example.com/catalog';
  const reply=catalogueReply(url);
  assert.match(reply,/MR Enterprises/);
  assert.match(reply,/multiple products/);
  assert.match(reply,/https:\/\/example\.com\/catalog/);
  assert.equal(catalogueRequested('Please send catalogue'),true);
  assert.equal(catalogueRequested('menu'),true);
  assert.equal(catalogueRequested('My order is ready'),false);
});
