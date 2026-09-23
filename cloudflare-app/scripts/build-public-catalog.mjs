import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const repoRoot = path.resolve(appRoot, '..');
const source = JSON.parse(await readFile(path.join(repoRoot, 'catalog.json'), 'utf8'));
const sourceImages = path.join(repoRoot, 'images');
const publicImages = path.join(appRoot, 'public', 'images');
await mkdir(publicImages, { recursive: true });
const imageNames = new Set(await readdir(sourceImages));

const departments = (source.departments || []).map((department) => ({
  id: String(department.id),
  name: String(department.name),
  categories: (department.categories || []).map((category) => ({
    id: String(category.id),
    name: String(category.name),
    groups: (category.groups || []).map((group) => ({
      id: String(group.id),
      name: String(group.name),
      products: (group.products || []).map((product) => {
        const imageName = `${product.id}.jpg`;
        return {
          id: String(product.id),
          name: String(product.name),
          description: String(product.description || ''),
          pack: String(product.pack || ''),
          unitsPerCase: Number(product.unitsPerCase || 0),
          image: imageNames.has(imageName) ? `/images/${imageName}` : '',
        };
      }),
    })),
  })),
}));

for (const imageName of imageNames) {
  if (/^[A-Za-z0-9_-]+\.jpg$/.test(imageName)) await copyFile(path.join(sourceImages, imageName), path.join(publicImages, imageName));
}

const productCount = departments.reduce((sum, department) => sum + department.categories.reduce((categorySum, category) => categorySum + category.groups.reduce((groupSum, group) => groupSum + group.products.length, 0), 0), 0);
await writeFile(path.join(appRoot, 'public', 'catalog-data.json'), `${JSON.stringify({ title: source.title, departments, productCount })}\n`);
console.log(`Built public catalogue with ${productCount} products and ${imageNames.size} images.`);
