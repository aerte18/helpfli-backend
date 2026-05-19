/**
 * Generuje frontend/src/constants/servicesCatalog.js z categories_pl.json
 * Uruchom po: node scripts/update_categories_from_catalog.js
 */
const fs = require('fs');
const path = require('path');

const categoriesPath = path.join(__dirname, '../data/categories_pl.json');
const outPath = path.join(__dirname, '../../frontend/src/constants/servicesCatalog.js');

const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));

const catalog = categories.map((cat) => ({
  id: cat.id,
  label: cat.name,
  children: (cat.subcategories || []).map((sub) => ({
    slug: sub.id,
    label: sub.name,
    icon: 'wrench',
  })),
}));

const header = `// Auto-generated from backend/data/categories_pl.json
// Regenerate: cd backend && node scripts/export_frontend_services_catalog.js

`;

const body = `export const SERVICES_CATALOG = ${JSON.stringify(catalog, null, 2)};

export const SERVICE_BY_SLUG = SERVICES_CATALOG.flatMap((c) => c.children).reduce((acc, s) => {
  acc[s.slug] = s;
  return acc;
}, {});
`;

fs.writeFileSync(outPath, header + body, 'utf8');
console.log(`✅ Zapisano ${outPath} (${catalog.length} kategorii)`);
