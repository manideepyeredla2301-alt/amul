import test from 'node:test';
import assert from 'node:assert/strict';
import {baseOrderQuantity,cleanGstin,cleanLocationUrl,cleanPhone,cleanStoredPhone,cleanWholesaleUnit,defaultWholesaleUnit,directWhatsAppUrl,equalSecret,invoiceLineAmounts,orderEstimateLineAmounts,orderStatusMessage,paymentStatus,routeDisplayName} from '../src/worker.js';

test('constant-time secret comparison and phone normalization',async()=>{
  assert.equal(await equalSecret('same','same'),true);
  assert.equal(await equalSecret('same','different'),false);
  assert.equal(cleanPhone('+91 90140 03991'),'919014003991');
  assert.equal(cleanPhone('9014003991'),'919014003991');
  assert.throws(()=>cleanPhone('123'));
});

test('malformed legacy phone values do not hide the customer directory',()=>{
  assert.equal(cleanStoredPhone('old-number-not-available'),'');
  assert.equal(cleanStoredPhone('9014003991'),'919014003991');
});

test('route aliases keep renamed routes stable across source syncs',()=>{
  const aliases=new Map([['old route','New Route']]);
  assert.equal(routeDisplayName('Old Route',aliases),'New Route');
  assert.equal(routeDisplayName('',aliases),'Unassigned route');
});

test('checkout profile validation keeps GST and map data usable',()=>{
  assert.equal(cleanGstin('36abcde1234f1z5'),'36ABCDE1234F1Z5');
  assert.throws(()=>cleanGstin('not-a-gstin'));
  assert.equal(cleanLocationUrl('',17.385,78.4867),'https://www.google.com/maps?q=17.385,78.4867');
  assert.match(cleanLocationUrl('https://maps.app.goo.gl/example',null,null),/^https:\/\/maps\.app\.goo\.gl\//);
  assert.throws(()=>cleanLocationUrl('https://example.com/shop',null,null));
});

test('manual WhatsApp links preserve the recipient and prepared order update',()=>{
  const order={id:'order-1',order_number:'WEB-42',customer_name:'Anil Stores',delivery_date:'2026-09-30'};
  const message=orderStatusMessage(order,'Out for delivery');
  assert.match(message,/Anil Stores/);
  assert.match(message,/WEB-42/);
  assert.match(message,/out for delivery/);
  const url=new URL(directWhatsAppUrl('9014003991',message));
  assert.equal(url.hostname,'wa.me');
  assert.equal(url.pathname,'/919014003991');
  assert.equal(url.searchParams.get('text'),message);
});

test('online invoice arithmetic stays in paise and derives payment status',()=>{
  assert.deepEqual(orderEstimateLineAmounts(3,12550,500),{subtotal_paise:37650,tax_paise:0,total_paise:37650,gst_bps:500});
  assert.deepEqual(invoiceLineAmounts(3,12550,500),{subtotal_paise:37650,tax_paise:1883,total_paise:39533});
  assert.equal(paymentStatus(39533,0),'UNPAID');
  assert.equal(paymentStatus(39533,10000),'PART_PAID');
  assert.equal(paymentStatus(39533,39533),'PAID');
});

test('wholesale catalogue defaults and converts PC and BOX quantities',()=>{
  assert.equal(defaultWholesaleUnit('750 ml Combos'),'PC');
  assert.equal(defaultWholesaleUnit('2 L Family Packs'),'PC');
  assert.equal(defaultWholesaleUnit('5 L Bulk Packs'),'PC');
  assert.equal(defaultWholesaleUnit('Tricones'),'BOX');
  assert.equal(cleanWholesaleUnit('BX'),'BOX');
  assert.equal(cleanWholesaleUnit('PCS'),'PC');
  assert.equal(baseOrderQuantity(2,'BOX',24),48);
  assert.equal(baseOrderQuantity(3,'PC',24),3);
  assert.throws(()=>baseOrderQuantity(1.5,'BOX',24));
});
