const fs = require('fs');
const path = require('path');
const SOURCE = require('../data/services_catalog.source');

// (opcjonalnie) wskaż popularne usługi po docelowych slugach
const POPULAR_SLUGS = new Set([
  // 'hydraulika-udraznianie-odplywow-i-kanalizacji',
]);

const outFile = path.join(__dirname, '..', 'data', 'services_catalog.json');

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function build() {
  const items = [];
  for (const cat of SOURCE) {
    const parent = slugify(cat.id);
    for (const child of cat.children) {
      const childSlug = slugify(child);
      const fullSlug = `${parent}-${childSlug}`;
      items.push({
        parent_slug: parent,
        slug: fullSlug,
        name_pl: child,
        is_top: POPULAR_SLUGS.has(fullSlug) ? 1 : 0
      });
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf8');
  console.log(`✅ Wygenerowano ${items.length} pozycji -> ${outFile}`);
}

build();





