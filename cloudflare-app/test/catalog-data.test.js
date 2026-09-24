import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalogue = JSON.parse(await readFile(new URL('../public/catalog-data.json', import.meta.url), 'utf8'));
const products = new Map(catalogue.departments.flatMap((department) => department.categories.flatMap((category) => category.groups.flatMap((group) => group.products.map((product) => [product.id, product])))));

test('catalogue distinguishes inner boxes from full crates', () => {
  assert.deepEqual([products.get('ICTRBCH45').unitsPerBox, products.get('ICTRBCH45').unitsPerCase], [20, 120]);
  assert.deepEqual([products.get('ICCUBSC95').unitsPerBox, products.get('ICCUBSC95').unitsPerCase], [16, 144]);
  assert.deepEqual([products.get('ICSTFRS53').unitsPerBox, products.get('ICSTFRS53').unitsPerCase], [20, 160]);
  assert.deepEqual([products.get('ICPPBSC95').unitsPerBox, products.get('ICPPBSC95').unitsPerCase], [3, 18]);
  assert.deepEqual([products.get('CHTCP102').unitsPerBox, products.get('CHTCP102').unitsPerCase], [20, 360]);
  assert.deepEqual([products.get('WCHCP17').unitsPerBox, products.get('WCHCP17').unitsPerCase], [75, 450]);
  assert.deepEqual([products.get('DWRCP70').unitsPerBox, products.get('DWRCP70').unitsPerCase], [240, 480]);
  assert.deepEqual([products.get('FPSCP01').unitsPerBox, products.get('FPSCP01').unitsPerCase], [40, 40]);
});

test('every catalogue product has a valid box conversion', () => {
  for (const product of products.values()) {
    assert.ok(Number.isInteger(product.unitsPerBox) && product.unitsPerBox > 0, `${product.id} needs a positive unitsPerBox`);
    assert.ok(product.unitsPerBox <= product.unitsPerCase, `${product.id} box cannot exceed its crate`);
  }
});
