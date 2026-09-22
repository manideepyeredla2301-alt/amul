import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanPhone,equalSecret} from '../src/worker.js';

test('constant-time secret comparison and phone normalization',async()=>{
  assert.equal(await equalSecret('same','same'),true);
  assert.equal(await equalSecret('same','different'),false);
  assert.equal(cleanPhone('+91 90140 03991'),'919014003991');
  assert.throws(()=>cleanPhone('123'));
});
