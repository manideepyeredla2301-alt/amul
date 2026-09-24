// Aligns catalog.json with the Amul product master so every in-stock Amul product can appear
// in the public catalogue. Input: a JSON list of Amul products ({code,name,caseQty,pgroup})
// exported read-only from Amul SQL, with inStock=false for products without stock. It
//  1. corrects catalogue ids that do not match an Amul product code (matched by description),
//     keeping the original photo through `imageId`,
//  2. drops duplicate entries created by those corrections,
//  3. adds in-stock Amul products that are missing, placed in the matching catalogue group.
// Usage: node scripts/sync-catalogue-with-amul.mjs <amul-products.json> [--dry-run]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.resolve(here, '..', '..', 'catalog.json');
const [inputPath, flag] = process.argv.slice(2);
if (!inputPath) throw new Error('Pass the Amul product export JSON.');
const amul = JSON.parse((await readFile(inputPath, 'utf8')).replace(/^﻿/, ''));
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));

const norm = (s) => String(s || '').toLowerCase().replace(/\bamul\b|\bic\b|[^a-z0-9]/g, '');
const byCode = new Map(amul.map((p) => [p.code, p]));
const byName = new Map(amul.map((p) => [norm(p.name), p.code]));
const report = { corrected: [], duplicatesRemoved: [], added: [], unmatched: [] };

function findGroup(departmentId, categoryId, groupId) {
  for (const d of catalog.departments) for (const c of d.categories) for (const g of c.groups)
    if (d.id === departmentId && c.id === categoryId && g.id === groupId) return { d, c, g };
  return null;
}
// Names for categories this script may create (frozen_snacks matches the live catalogue).
const categoryNames = { frozen_snacks: 'Frozen Snacks' };
function ensureGroup(departmentId, categoryId, groupId, groupName, afterGroupId) {
  const found = findGroup(departmentId, categoryId, groupId);
  if (found) return found;
  const d = catalog.departments.find((x) => x.id === departmentId);
  if (!d) throw new Error(`Unknown department ${departmentId}`);
  let c = d.categories.find((x) => x.id === categoryId);
  if (!c) { c = { id: categoryId, name: categoryNames[categoryId] || groupName, groups: [] }; d.categories.push(c); }
  const g = { id: groupId, name: groupName, products: [] };
  const at = c.groups.findIndex((x) => x.id === afterGroupId);
  c.groups.splice(at < 0 ? c.groups.length : at + 1, 0, g);
  return { d, c, g };
}

// Where a missing Amul product belongs. Pack size decides ice-cream groups.
function placement(p) {
  const n = p.name;
  if (/^IC/.test(p.code)) {
    const g = (id) => ['frozen', 'ice_creams', id];
    if (/\b4\s*L\b/i.test(n)) return [...g('bulk_packs_4l'), '4 L Bulk Packs', 'family_packs_2l'];
    if (/\b5\s*L\b/i.test(n)) return g('bulk_packs_5l');
    if (/\b2\s*L\b/i.test(n)) return g('family_packs_2l');
    if (/combo/i.test(n)) return g('combos_750ml');
    if (/750\s*ml/i.test(n)) return g('family_packs_750ml');
    if (/\b1\s*(l|ltr)\b|\b1l\b|1l\(/i.test(n)) return g('tubs_1l');
    if (/^ICTR/.test(p.code)) return g('tricones');
    if (/\bstk\b|chocobar|kulfi|froot lickz/i.test(n)) return g('sticks_kulfi');
    if (/125\s*ml/i.test(n)) return g('cups_125ml');
    if (/cup/i.test(n) && /100\s*ml/i.test(n)) return g('cups_100ml');
    if (/cup/i.test(n) && /(55|60)\s*ml/i.test(n)) return g('cups_55_60ml');
    return g('sandwiches_novelties');
  }
  const code = p.code;
  if (/^FPS/.test(code)) return /f\.?\s*fries|french fries/i.test(p.name) ? ['frozen', 'frozen_snacks', 'french_fries', 'French Fries'] : ['frozen', 'frozen_snacks', 'veg_patties', 'Veg Patties', 'french_fries'];
  if (/^(BTM|TDM|SDM)/.test(code)) return ['dairy', 'milk_drinks', 'milk_buttermilk'];
  if (/^LAS/.test(code)) return ['dairy', 'milk_drinks', 'lassi'];
  if (/^(TRU|CAF|FMP|KOK)/.test(code)) return ['dairy', 'milk_drinks', 'milkshakes_kool'];
  if (/^(GHE|WBT|BTR)/.test(code)) return ['dairy', 'cooking_dairy', 'butter_ghee'];
  if (/^(PCH|MCH|AFC|PNR|KHO)/.test(code)) return ['dairy', 'cooking_dairy', 'cheese_cream'];
  if (/^SCM/.test(code)) return ['dairy', 'cooking_dairy', 'condensed_milk'];
  if (/^PEA/.test(code)) return ['dairy', 'cooking_dairy', 'spreads', 'Spreads', 'condensed_milk'];
  if (/^CHT/.test(code)) return ['chocolates', 'chocolate_range', 'chocolate_bars'];
  if (/^ABC/.test(code)) return ['snacks', 'bakery_snacks', 'cakes', 'Cakes', 'rusks'];
  if (/^(ATT|AET)/.test(code)) return ['snacks', 'bakery_snacks', 'rusks'];
  return null;
}

const displayName = (name) => String(name).replace(/^Amul\s+(IC\s+)?/i, '').replace(/\s{2,}/g, ' ').trim();
const packOf = (name) => (String(name).match(/(\d+(?:\.\d+)?\s*(?:ml|l|ltr|gm|g|kg)\b.*)$/i) || ['', ''])[1].trim();

// 1-2. Correct ids and remove duplicates.
const seen = new Set();
for (const d of catalog.departments) for (const c of d.categories) for (const g of c.groups) {
  g.products = g.products.filter((product) => {
    if (!byCode.has(product.id)) {
      const code = byName.get(norm(product.description));
      if (code) { report.corrected.push(`${product.id} -> ${code}`); product.imageId = product.imageId || product.id; product.id = code; }
      else report.unmatched.push(`${product.id} (${product.description})`);
    }
    if (seen.has(product.id)) { report.duplicatesRemoved.push(product.id); return false; }
    seen.add(product.id);
    return true;
  });
}

// 3. Add missing Amul products.
for (const p of amul) {
  if (seen.has(p.code) || p.inStock === false) continue;
  const place = placement(p);
  if (!place) { report.unmatched.push(`${p.code} not placed (${p.name})`); continue; }
  const [departmentId, categoryId, groupId, newName, after] = place;
  const target = newName ? ensureGroup(departmentId, categoryId, groupId, newName, after) : findGroup(departmentId, categoryId, groupId);
  if (!target) { report.unmatched.push(`${p.code} group ${place.join('/')} missing`); continue; }
  target.g.products.push({
    id: p.code, name: displayName(p.name), description: p.name,
    departmentId, department: target.d.name, categoryId, category: target.c.name, groupId, group: target.g.name,
    pack: packOf(p.name), unitsPerCase: Number(p.caseQty || 0), sourceCategory: p.pgroup || '', source: 'amul-product-master',
  });
  seen.add(p.code);
  report.added.push(`${p.code} -> ${groupId}`);
}

console.log(JSON.stringify({ corrected: report.corrected.length, duplicatesRemoved: report.duplicatesRemoved, added: report.added.length, unmatched: report.unmatched }, null, 1));
if (flag !== '--dry-run') await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
