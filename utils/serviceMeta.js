const Service = require('../models/Service');
const path = require('path');

let staticCatalog = null;
function getStaticCatalog() {
  if (staticCatalog) return staticCatalog;
  try {
    staticCatalog = require(path.join(__dirname, '../data/services_catalog.json'));
  } catch {
    staticCatalog = [];
  }
  return staticCatalog;
}

function normalizeSlug(slug = '') {
  return String(slug).trim().toLowerCase().replace(/_/g, '-');
}

function metaFromRecord(rec = {}) {
  if (!rec) return null;
  return {
    slug: rec.slug,
    parent_slug: rec.parent_slug,
    name_pl: rec.name_pl,
    tier: rec.tier || 'quick',
    offerOnlySuggested: Boolean(rec.offerOnlySuggested ?? rec.offer_only_suggested),
    b2b: Boolean(rec.b2b),
    base_price_min: Number(rec.base_price_min) || 0,
    base_price_max: Number(rec.base_price_max) || 0,
  };
}

async function getServiceMetaBySlug(slug) {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;

  try {
    const fromDb = await Service.findOne({ slug: normalized })
      .select('slug parent_slug name_pl tier offerOnlySuggested b2b base_price_min base_price_max')
      .lean();
    if (fromDb) return metaFromRecord(fromDb);
  } catch {
    /* DB optional */
  }

  const hit = getStaticCatalog().find((s) => normalizeSlug(s.slug) === normalized);
  return metaFromRecord(hit);
}

const LARGE_PROJECT_KEYWORDS = [
  'budowa domu', 'budowa hali', 'dom pod klucz', 'generalny remont', 'stan surowy',
  'wykończenie wnętrz', 'fotowoltaik', 'pompa ciepła', 'generalny wykonawca',
  'projekt budowlany', 'geodeta', 'kosztorys', 'odbiór mieszkania', 'rzeczoznawca',
  'inspekcja domu', 'basen', 'deweloper',
];

function shouldSuggestOffersOnly({ serviceMeta, budgetMin, budgetMax, description = '' } = {}) {
  if (serviceMeta?.offerOnlySuggested) return true;
  const max = Number(budgetMax ?? budgetMin ?? 0);
  if (max >= 50000) return true;
  const text = String(description).toLowerCase();
  return LARGE_PROJECT_KEYWORDS.some((kw) => text.includes(kw));
}

function applyOffersOnlyOrderDefaults(orderPayload = {}) {
  if (orderPayload.orderMode !== 'offers_only') return orderPayload;
  return {
    ...orderPayload,
    paymentPreference: 'external',
    matchMode: orderPayload.matchMode || 'open',
  };
}

module.exports = {
  normalizeSlug,
  metaFromRecord,
  getServiceMetaBySlug,
  shouldSuggestOffersOnly,
  applyOffersOnlyOrderDefaults,
};
