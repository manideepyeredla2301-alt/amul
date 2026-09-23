import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogueInviteMessage,catalogueReply,catalogueRequested,cleanGstin,cleanLocationUrl,cleanPhone,equalSecret,supportsWhatsAppWebhook} from '../src/worker.js';

test('constant-time secret comparison and phone normalization',async()=>{
  assert.equal(await equalSecret('same','same'),true);
  assert.equal(await equalSecret('same','different'),false);
  assert.equal(cleanPhone('+91 90140 03991'),'919014003991');
  assert.equal(cleanPhone('9014003991'),'919014003991');
  assert.throws(()=>cleanPhone('123'));
});

test('checkout profile validation keeps GST and map data usable',()=>{
  assert.equal(cleanGstin('36abcde1234f1z5'),'36ABCDE1234F1Z5');
  assert.throws(()=>cleanGstin('not-a-gstin'));
  assert.equal(cleanLocationUrl('',17.385,78.4867),'https://www.google.com/maps?q=17.385,78.4867');
  assert.match(cleanLocationUrl('https://maps.app.goo.gl/example',null,null),/^https:\/\/maps\.app\.goo\.gl\//);
  assert.throws(()=>cleanLocationUrl('https://example.com/shop',null,null));
});

test('webhook accepts standard and coexistence event fields',()=>{
  for(const field of ['messages','account_update','history','smb_app_state_sync','smb_message_echoes'])assert.equal(supportsWhatsAppWebhook(field),true);
  assert.equal(supportsWhatsAppWebhook('unrelated_field'),false);
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

test('new-customer invitations always use the approved catalogue template path',()=>{
  assert.deepEqual(catalogueInviteMessage('919014003991'),{
    messaging_product:'whatsapp',
    recipient_type:'individual',
    to:'919014003991',
    type:'template',
    template:{name:'amul_catalogue',language:{code:'en_US'}},
  });
});
