require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const Service = require('../models/Service');

const catalogPath = path.join(__dirname, '../data/services_catalog.json');
const catalog = require(catalogPath);

function normalizeSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
  await mongoose.connect(uri);
  console.log('🔌 Połączono z MongoDB');
  console.log(`📦 Katalog statyczny: ${catalog.length} rekordów`);

  const activeSlugs = new Set();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const item of catalog) {
    const parent = normalizeSlug(item.parent_slug || item.parent || item.id);
    const slug = normalizeSlug(item.slug || `${parent}-${item.name_pl}`);
    activeSlugs.add(slug);

    const payload = {
      parent_slug: parent,
      slug,
      name_pl: item.name_pl,
      name_en: item.name_en || item.name_pl,
      description: item.description || `Usługa Helpfli: ${item.name_pl}`,
      tags: item.tags || item.name_pl,
      intent_keywords: item.intent_keywords || item.name_pl,
      danger_flags: item.danger_flags || '',
      urgency_level: item.urgency_level || 3,
      base_price_min: item.base_price_min || 0,
      base_price_max: item.base_price_max || 0,
      unit: item.unit || 'PLN',
      requires_photos: Number(item.requires_photos ?? 0),
      requires_address: Number(item.requires_address ?? 1),
      requires_datetime: Number(item.requires_datetime ?? 1),
      ai_triage_template: item.ai_triage_template || '',
      service_kind: item.service_kind || 'onsite',
      is_top: item.is_top ? 1 : 0,
      seasonal: item.seasonal || 'none',
      updated_at: new Date()
    };

    const existing = await Service.findOne({ slug }).select('_id parent_slug slug name_pl name_en service_kind is_top urgency_level seasonal').lean();
    if (existing) {
      const same =
        String(existing.parent_slug || '') === String(payload.parent_slug || '') &&
        String(existing.slug || '') === String(payload.slug || '') &&
        String(existing.name_pl || '') === String(payload.name_pl || '') &&
        String(existing.name_en || '') === String(payload.name_en || '') &&
        String(existing.service_kind || '') === String(payload.service_kind || '') &&
        Number(existing.is_top || 0) === Number(payload.is_top || 0) &&
        Number(existing.urgency_level || 0) === Number(payload.urgency_level || 0) &&
        String(existing.seasonal || '') === String(payload.seasonal || '');
      if (same) {
        unchanged += 1;
      }
    }

    const res = await Service.updateOne({ slug }, { $set: payload }, { upsert: true });

    if (res.upsertedCount > 0) {
      inserted += 1;
    } else if (res.modifiedCount > 0) {
      updated += 1;
    }
  }

  let removed = 0;
  const shouldPrune = process.argv.includes('--prune');
  if (shouldPrune) {
    const removal = await Service.deleteMany({ slug: { $nin: Array.from(activeSlugs) } });
    removed = removal.deletedCount || 0;
  }

  console.log('✅ Import zakończony');
  console.log(`   ➕ Dodano: ${inserted}`);
  console.log(`   ♻️ Zaktualizowano: ${updated}`);
  console.log(`   🟰 Bez zmian: ${unchanged}`);
  console.log(`   ➖ Usunięto: ${removed}${shouldPrune ? '' : ' (pominięto, użyj --prune)'}`);
  const total = await Service.countDocuments({});
  console.log(`   📚 Łącznie rekordów w Service: ${total}`);

  await mongoose.disconnect();
  console.log('🔌 Rozłączono z MongoDB');
}

run().catch(err => {
  console.error('❌ Błąd importu usług:', err);
  process.exit(1);
});










