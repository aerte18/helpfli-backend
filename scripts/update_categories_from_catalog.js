const fs = require('fs');
const path = require('path');

const categoriesPath = path.join(__dirname, '../data/categories_pl.json');
const legacyCategoriesPath = path.join(__dirname, '../data/categories_pl.json');
const sourcePath = path.join(__dirname, '../data/services_catalog.json');
const catalogSource = require('../data/services_catalog.source');

const PARENT_ICONS = {
  'budowa-inwestycje': '🏗️',
  nieruchomosci: '🏠',
  'motoryzacja-rozszerzona': '🚗',
  eventy: '🎉',
  'prawo-biznes': '⚖️',
};

const parentLabelsFromSource = Object.fromEntries(
  (catalogSource || []).map((c) => [String(c.id).trim(), c.label]).filter(([id]) => id)
);

try {
  const existingIcons = {};
  const legacyNames = {};
  if (fs.existsSync(categoriesPath)) {
    try {
      const legacyData = JSON.parse(fs.readFileSync(legacyCategoriesPath, 'utf8'));
      legacyData.forEach(cat => {
        if (cat.id && cat.icon) {
          existingIcons[cat.id] = cat.icon;
        }
        if (cat.id && cat.name) {
          legacyNames[cat.id] = cat.name;
        }
      });
    } catch (err) {
      console.warn('[update_categories_from_catalog] Could not read existing icons:', err.message);
    }
  }

  const catalog = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const grouped = {};
  catalog.forEach(item => {
    const parent = item.parent_slug;
    if (!parent) return;
    if (!grouped[parent]) {
      grouped[parent] = [];
    }
    grouped[parent].push(item);
  });

  const toTitle = (str) => str.replace(/[-_]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());

  const categories = Object.entries(grouped).map(([parent, items]) => ({
    id: parent,
    name: parentLabelsFromSource[parent] || legacyNames[parent] || toTitle(parent),
    icon: PARENT_ICONS[parent] || existingIcons[parent] || '❓',
    subcategories: items.map(child => ({
      id: child.slug,
      name: child.name_pl,
      tier: child.tier || 'quick',
      offerOnlySuggested: Boolean(child.offer_only_suggested ?? child.offerOnlySuggested),
      b2b: Boolean(child.b2b),
      base_price_min: Number(child.base_price_min) || 0,
      base_price_max: Number(child.base_price_max) || 0,
    }))
  }));

  fs.writeFileSync(categoriesPath, JSON.stringify(categories, null, 2), 'utf8');

  console.log('✅ Zaktualizowano categories_pl.json na podstawie SERVICES_CATALOG');
  console.log(`   Kategorii: ${categories.length}`);
  console.log(`   Przykład: ${categories[0].name} (${categories[0].subcategories.length} podkategorii)`);
} catch (error) {
  console.error('❌ Błąd podczas aktualizacji kategorii:', error);
  process.exit(1);
}

