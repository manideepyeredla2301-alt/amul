import assert from 'node:assert/strict';
import test from 'node:test';
import menu from '../src/menu.json' with { type: 'json' };
import prep from '../src/prep.json' with { type: 'json' };
import { priceItem, checkOrigin } from '../src/worker.js';

const item = id => menu.categories.flatMap(category => category.items).find(entry => entry.id === id);

test('burger prices and cheese slice match the finalized menu', () => {
  assert.equal(priceItem(item('classic-veg-burger'), {}).unit_price_paise, 9_000);
  assert.equal(priceItem(item('classic-veg-burger'), { 'burger-cheese': true }).unit_price_paise, 10_000);
  assert.equal(priceItem(item('classic-chicken-burger'), {}).unit_price_paise, 12_000);
  assert.equal(priceItem(item('classic-chicken-burger'), { 'burger-cheese': true }).unit_price_paise, 13_000);
});

test('regular scoops use the confirmed cup prices and add ₹10 for a cone', () => {
  const expected = new Map([
    ['vanilla', 40], ['strawberry', 40], ['blackcurrant', 50],
    ['cookies-cream', 50], ['choco-chips', 50], ['chocolate', 50],
    ['american-nuts', 50], ['butterscotch', 50], ['tender-coconut', 60],
    ['orange', 40], ['pineapple', 40],
  ]);
  for (const [flavour, cup] of expected) {
    const scoop = item(`scoop-${flavour}`);
    assert.ok(scoop, `${flavour} is in the Scoops menu`);
    assert.equal(priceItem(scoop, {'scoop-serving': 'cup'}).unit_price_paise, cup * 100);
    assert.equal(priceItem(scoop, {'scoop-serving': 'cone'}).unit_price_paise, (cup + 10) * 100);
  }
  assert.throws(() => priceItem(item('scoop-vanilla'), {'scoop-serving': 'free-cone'}), /Invalid serve it in choice/);
});

test('sandwich extras use menu prices and reject unsupported changes', () => {
  assert.equal(priceItem(item('grilled-paneer'), {
    'sandwich-bread': true, 'sandwich-cheese': true, 'sandwich-paneer': true,
  }).unit_price_paise, 18_900);
  assert.throws(() => priceItem(item('grilled-paneer'), { 'sandwich-chicken': true }), /Unsupported item option/);
  assert.throws(() => priceItem(item('classic-veg-burger'), { 'burger-cheese': 'free' }), /yes or no/);
});

test('sundae pricing requires matching scoops and named paid extras', () => {
  const base = {
    'sundae-size': 'double',
    'sundae-flavors': ['Vanilla', 'Strawberry'],
    'sundae-serving': 'waffle-bowl',
    'sundae-sauce': ['Chocolate Fudge'],
    'sundae-topping': ['Oreo Crumbs'],
  };
  assert.equal(priceItem(item('build-your-own-sundae'), base).unit_price_paise, 14_000);
  assert.equal(priceItem(item('build-your-own-sundae'), {
    ...base,
    'sundae-sauce': ['Chocolate Fudge', 'Caramel'],
    'sundae-topping': ['Oreo Crumbs', 'Jelly'],
    'sundae-extras': ['additional-sauce', 'additional-topping', 'whipped-cream'],
  }).unit_price_paise, 19_500);
  assert.throws(() => priceItem(item('build-your-own-sundae'), {
    ...base, 'sundae-flavors': ['Vanilla'],
  }), /one flavor for each scoop/);
  assert.throws(() => priceItem(item('build-your-own-sundae'), {
    ...base, 'sundae-sauce': ['Chocolate Fudge', 'Caramel'],
  }), /Extra sauce selection/);
});

test('cross-site writes are refused', () => {
  assert.throws(() => checkOrigin(new Request('https://cafe.example/api/cafe/orders', {
    method: 'POST', headers: { Origin: 'https://attacker.example' },
  })), /Cross-site request rejected/);
});

test('every orderable item has concise kitchen preparation steps', () => {
  const menuIds = menu.categories.flatMap(category => category.items.map(entry => entry.id)).sort();
  assert.deepEqual(Object.keys(prep.items).sort(), menuIds);
  for (const steps of Object.values(prep.items)) {
    assert.ok(Array.isArray(steps) && steps.length >= 2 && steps.length <= 4);
    assert.ok(steps.every(step => typeof step === 'string' && step.length > 15));
  }
});
