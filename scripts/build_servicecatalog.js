const fs = require('fs');
const path = require('path');
const SOURCE = require('../data/services_catalog.source');

const POPULAR_SLUGS = new Set([]);

const outFile = path.join(__dirname, '..', 'data', 'services_catalog.json');

const CATEGORY_LABELS = {
  'budowa-inwestycje': 'Budowa i inwestycje',
  'nieruchomosci': 'Nieruchomości',
  'motoryzacja-rozszerzona': 'Motoryzacja',
  'eventy': 'Eventy',
  'prawo-biznes': 'Prawo i biznes',
};

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function childName(child) {
  return typeof child === 'string' ? child : child.name;
}

function build() {
  const items = [];
  for (const cat of SOURCE) {
    const parent = slugify(cat.id);
    const catTier = cat.tier || 'quick';
    const catOfferOnly = Boolean(cat.offerOnlySuggested);
    const catB2b = Boolean(cat.b2b);

    for (const child of cat.children) {
      const name = childName(child);
      const childSlug = slugify(name);
      const fullSlug = `${parent}-${childSlug}`;
      const c = typeof child === 'object' ? child : {};

      items.push({
        parent_slug: parent,
        slug: fullSlug,
        name_pl: name,
        name_en: c.name_en || name,
        description: c.description || `Usługa Helpfli: ${name}`,
        tier: c.tier || catTier,
        offer_only_suggested: c.offerOnlySuggested ?? c.offer_only_suggested ?? catOfferOnly,
        b2b: c.b2b ?? catB2b,
        base_price_min: Number(c.base_price_min) || 0,
        base_price_max: Number(c.base_price_max) || 0,
        tags: c.tags || name,
        intent_keywords: c.intent_keywords || name,
        is_top: POPULAR_SLUGS.has(fullSlug) ? 1 : 0,
      });
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf8');
  console.log(`✅ Wygenerowano ${items.length} pozycji -> ${outFile}`);
}

build();
