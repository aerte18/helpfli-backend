/**
 * Read-only agregacje marketingowe dla AI Command Center.
 * Bez PII — wyłącznie zagregowane sygnały.
 */

const { LRUCache } = require('lru-cache');
const mongoose = require('mongoose');
const cfg = require('../config/marketingIntegration');
const Order = require('../models/Order');
const User = require('../models/User');
const Service = require('../models/Service');
const { TOP_PL_CITIES_BY_SLUG } = require('../utils/polishCities');
const { SEO_CITIES } = require('../utils/seoCities');

let categoriesData = [];
try {
  categoriesData = require('../data/categories_pl.json');
  if (!Array.isArray(categoriesData)) categoriesData = [];
} catch {
  categoriesData = [];
}

const cache = new LRUCache({
  max: 200,
  ttl: cfg.cacheTtlSeconds * 1000,
});

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCityRegex(citySlug) {
  const city = TOP_PL_CITIES_BY_SLUG[citySlug];
  if (!city) return null;
  const alts = city.aliases.map(escapeRegex);
  return new RegExp(`(?:^|\\b)(?:${alts.join('|')})(?:\\b|$)`, 'i');
}

function resolveCityMeta(citySlug) {
  const top = TOP_PL_CITIES_BY_SLUG[citySlug];
  const seo = SEO_CITIES.find((c) => c.slug === citySlug);
  if (!top && !seo) return null;
  return {
    city: seo?.name || top?.name || citySlug,
    citySlug,
    region: seo?.voivodeship || null,
  };
}

function normalizeCategoryId(id) {
  return String(id || '').trim().toLowerCase();
}

function expandCategoryFilters(categoryIds = []) {
  const parents = new Set();
  const services = new Set();
  for (const raw of categoryIds) {
    const id = normalizeCategoryId(raw);
    if (!id) continue;
    const cat = categoriesData.find((c) => normalizeCategoryId(c.id) === id);
    if (cat) {
      parents.add(cat.id);
      for (const sub of cat.subcategories || []) {
        services.add(sub.id);
      }
      continue;
    }
    for (const cat of categoriesData) {
      const sub = (cat.subcategories || []).find((s) => normalizeCategoryId(s.id) === id);
      if (sub) {
        parents.add(cat.id);
        services.add(sub.id);
      }
    }
    services.add(id);
  }
  return { parents: [...parents], services: [...services] };
}

function suppressCount(count) {
  if (count == null || count < cfg.privacyMinCount) {
    return { suppressed: true, value: null, band: count > 0 ? 'low' : 'none' };
  }
  return { suppressed: false, value: count, band: null };
}

function ratingBand(avg) {
  if (avg == null || !Number.isFinite(avg)) return 'unknown';
  if (avg < 2.5) return '1-2';
  if (avg < 3.5) return '3';
  if (avg < 4.5) return '4';
  return '5';
}

function withTimeout(promise, ms = cfg.aggregationTimeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('aggregation_timeout')), ms)
    ),
  ]);
}

async function getServiceEnrichment() {
  const key = 'catalog:service-enrichment';
  if (cache.has(key)) return cache.get(key);

  let rows = [];
  try {
    if (mongoose.connection.readyState === 1) {
      rows = await Service.find({})
        .select('parent_slug slug urgency_level requires_datetime service_kind updated_at')
        .lean();
    }
  } catch {
    rows = [];
  }

  const byParent = {};
  let maxUpdated = null;
  for (const row of rows) {
    const parent = row.parent_slug;
    if (!byParent[parent]) {
      byParent[parent] = {
        serviceCount: 0,
        emergencySupported: false,
        scheduledSupported: false,
        remoteSupported: false,
      };
    }
    byParent[parent].serviceCount += 1;
    if (Number(row.urgency_level) >= 4) byParent[parent].emergencySupported = true;
    if (Number(row.requires_datetime) === 1) byParent[parent].scheduledSupported = true;
    if (row.service_kind === 'remote' || row.service_kind === 'hybrid') {
      byParent[parent].remoteSupported = true;
    }
    if (row.updated_at && (!maxUpdated || row.updated_at > maxUpdated)) {
      maxUpdated = row.updated_at;
    }
  }

  const enrichment = { byParent, maxUpdated, serviceRowCount: rows.length };
  cache.set(key, enrichment);
  return enrichment;
}

async function getCatalog() {
  const key = 'catalog:full';
  if (cache.has(key)) return cache.get(key);

  const { byParent, maxUpdated, serviceRowCount } = await getServiceEnrichment();

  const categories = categoriesData.map((cat) => {
    const enrich = byParent[cat.id] || {};
    const subCount = (cat.subcategories || []).length;
    return {
      categoryId: cat.id,
      categoryName: cat.name,
      active: true,
      emergencySupported: !!enrich.emergencySupported,
      scheduledSupported: enrich.scheduledSupported !== false ? true : subCount > 0,
      remoteSupported: !!enrich.remoteSupported,
      subcategories: (cat.subcategories || []).map((sub) => ({
        id: sub.id,
        name: sub.name,
        tier: sub.tier || null,
        offerOnlySuggested: !!sub.offerOnlySuggested,
        b2b: !!sub.b2b,
      })),
      serviceCount: enrich.serviceCount || subCount,
    };
  });

  const sourceVersion = `${cfg.SOURCE_VERSION}:${categories.length}:${serviceRowCount}:${maxUpdated ? new Date(maxUpdated).toISOString() : 'static'}`;

  const result = { categories, sourceVersion };
  cache.set(key, result);
  return result;
}

function validateSummaryRequest(body = {}) {
  const errors = [];
  const categoryIds = Array.isArray(body.categoryIds)
    ? body.categoryIds.map(normalizeCategoryId).filter(Boolean)
    : Array.isArray(body.categories)
      ? body.categories.map(normalizeCategoryId).filter(Boolean)
      : [];

  const locations = Array.isArray(body.locations)
    ? body.locations.map((l) => String(l).trim().toLowerCase()).filter(Boolean)
    : [];

  if (categoryIds.length > cfg.maxCategoriesPerRequest) {
    errors.push({
      code: 'too_many_categories',
      message: `Maksymalnie ${cfg.maxCategoriesPerRequest} kategorii na zapytanie`,
    });
  }
  if (locations.length > cfg.maxLocationsPerRequest) {
    errors.push({
      code: 'too_many_locations',
      message: `Maksymalnie ${cfg.maxLocationsPerRequest} lokalizacji na zapytanie`,
    });
  }

  const dateFrom = body.dateFrom ? new Date(body.dateFrom) : null;
  const dateTo = body.dateTo ? new Date(body.dateTo) : new Date();
  if (body.dateFrom && Number.isNaN(dateFrom?.getTime())) {
    errors.push({ code: 'invalid_date', message: 'Nieprawidłowe dateFrom' });
  }
  if (body.dateTo && Number.isNaN(dateTo?.getTime())) {
    errors.push({ code: 'invalid_date', message: 'Nieprawidłowe dateTo' });
  }

  let rangeDays = cfg.maxDateRangeDays;
  if (dateFrom && dateTo && !Number.isNaN(dateFrom.getTime()) && !Number.isNaN(dateTo.getTime())) {
    if (dateFrom > dateTo) {
      errors.push({ code: 'invalid_date_range', message: 'dateFrom musi być przed dateTo' });
    }
    rangeDays = Math.ceil((dateTo - dateFrom) / (24 * 60 * 60 * 1000));
    if (rangeDays > cfg.maxDateRangeDays) {
      errors.push({
        code: 'date_range_too_large',
        message: `Zakres dat przekracza ${cfg.maxDateRangeDays} dni`,
        maxDays: cfg.maxDateRangeDays,
      });
    }
  }

  for (const loc of locations) {
    if (!TOP_PL_CITIES_BY_SLUG[loc]) {
      errors.push({ code: 'unsupported_location', message: `Nieobsługiwana lokalizacja: ${loc}`, location: loc });
    }
  }

  const { services } = expandCategoryFilters(categoryIds);
  if (categoryIds.length && !services.length) {
    errors.push({ code: 'unsupported_category', message: 'Nieznane identyfikatory kategorii' });
  }

  return {
    errors,
    categoryIds,
    locations,
    dateFrom: dateFrom && !Number.isNaN(dateFrom.getTime()) ? dateFrom : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    dateTo: dateTo && !Number.isNaN(dateTo.getTime()) ? dateTo : new Date(),
    serviceSlugs: services,
  };
}

function buildOrderMatch({ dateFrom, dateTo, serviceSlugs, locations }) {
  const match = {
    createdAt: { $gte: dateFrom, $lte: dateTo },
    status: { $nin: ['draft'] },
  };

  if (serviceSlugs.length) {
    match.service = {
      $in: serviceSlugs.map((s) => new RegExp(`^${escapeRegex(s)}$`, 'i')),
    };
  }

  if (locations.length) {
    const cityClauses = locations
      .map((slug) => buildCityRegex(slug))
      .filter(Boolean)
      .map((rx) => ({ city: rx }));
    if (cityClauses.length) {
      match.$or = cityClauses;
    }
  }

  return match;
}

async function getDemandSummary(body) {
  const parsed = validateSummaryRequest(body);
  if (parsed.errors.length) return { errors: parsed.errors };

  const cacheKey = `demand:${JSON.stringify({
    c: parsed.categoryIds,
    l: parsed.locations,
    f: parsed.dateFrom.toISOString(),
    t: parsed.dateTo.toISOString(),
  })}`;
  if (cache.has(cacheKey)) return { data: cache.get(cacheKey) };

  const match = buildOrderMatch(parsed);

  const rows = await withTimeout(
    Order.aggregate([
      { $match: match },
      {
        $project: {
          service: 1,
          city: 1,
          status: 1,
          urgency: 1,
          hour: { $hour: '$createdAt' },
          offerCount: { $size: { $ifNull: ['$offers', []] } },
          hasAccepted: {
            $cond: [{ $in: ['$status', ['accepted', 'in_progress', 'completed', 'rated', 'released']] }, 1, 0],
          },
        },
      },
      {
        $group: {
          _id: { category: '$service', city: '$city' },
          orderCount: { $sum: 1 },
          openCount: {
            $sum: {
              $cond: [{ $in: ['$status', cfg.openOrderStatuses] }, 1, 0],
            },
          },
          filledCount: { $sum: '$hasAccepted' },
          urgencyNow: { $sum: { $cond: [{ $eq: ['$urgency', 'now'] }, 1, 0] } },
          urgencyToday: { $sum: { $cond: [{ $eq: ['$urgency', 'today'] }, 1, 0] } },
          urgencyTomorrow: { $sum: { $cond: [{ $eq: ['$urgency', 'tomorrow'] }, 1, 0] } },
          urgencyThisWeek: { $sum: { $cond: [{ $eq: ['$urgency', 'this_week'] }, 1, 0] } },
          urgencyFlexible: { $sum: { $cond: [{ $eq: ['$urgency', 'flexible'] }, 1, 0] } },
          peakMorning: { $sum: { $cond: [{ $and: [{ $gte: ['$hour', 6] }, { $lt: ['$hour', 12] }] }, 1, 0] } },
          peakAfternoon: { $sum: { $cond: [{ $and: [{ $gte: ['$hour', 12] }, { $lt: ['$hour', 18] }] }, 1, 0] } },
          peakEvening: { $sum: { $cond: [{ $and: [{ $gte: ['$hour', 18] }, { $lt: ['$hour', 22] }] }, 1, 0] } },
          avgOffers: { $avg: '$offerCount' },
        },
      },
    ])
  );

  const aggregates = rows.map((row) => {
    const citySlug = detectCitySlugFromText(row._id.city);
    const cityMeta = citySlug ? resolveCityMeta(citySlug) : { city: row._id.city || 'unknown', citySlug: null, region: null };
    const orderCount = row.orderCount || 0;
    const openCount = row.openCount || 0;
    const filledCount = row.filledCount || 0;
    const fillRate =
      orderCount >= cfg.privacyMinCount && orderCount > 0
        ? Number((filledCount / orderCount).toFixed(3))
        : null;

    return {
      category: row._id.category,
      location: cityMeta,
      timeWindow: {
        dateFrom: parsed.dateFrom.toISOString(),
        dateTo: parsed.dateTo.toISOString(),
      },
      orderCount: suppressCount(orderCount),
      openCount: suppressCount(openCount),
      fillRate: fillRate != null ? { suppressed: false, value: fillRate } : { suppressed: true, value: null },
      urgencyDistribution: {
        now: suppressCount(row.urgencyNow),
        today: suppressCount(row.urgencyToday),
        tomorrow: suppressCount(row.urgencyTomorrow),
        thisWeek: suppressCount(row.urgencyThisWeek),
        flexible: suppressCount(row.urgencyFlexible),
      },
      peakPeriods: {
        morning_06_12: suppressCount(row.peakMorning),
        afternoon_12_18: suppressCount(row.peakAfternoon),
        evening_18_22: suppressCount(row.peakEvening),
      },
      avgOffersPerOrder:
        orderCount >= cfg.privacyMinCount
          ? { suppressed: false, value: Number((row.avgOffers || 0).toFixed(2)) }
          : { suppressed: true, value: null },
    };
  });

  const data = {
    aggregates,
    privacyMinCount: cfg.privacyMinCount,
    filters: {
      categoryIds: parsed.categoryIds,
      locations: parsed.locations,
    },
  };
  cache.set(cacheKey, data);
  return { data };
}

function detectCitySlugFromText(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const [slug, city] of Object.entries(TOP_PL_CITIES_BY_SLUG)) {
    for (const alias of city.aliases) {
      if (lower.includes(alias)) return slug;
    }
  }
  return null;
}

async function getSupplySummary(body) {
  const parsed = validateSummaryRequest(body);
  if (parsed.errors.length) return { errors: parsed.errors };

  const cacheKey = `supply:${JSON.stringify({
    c: parsed.categoryIds,
    l: parsed.locations,
  })}`;
  if (cache.has(cacheKey)) return { data: cache.get(cacheKey) };

  const providerMatch = {
    role: 'provider',
    isActive: { $ne: false },
    anonymized: { $ne: true },
  };

  if (parsed.locations.length) {
    const cityRegexes = parsed.locations.map((slug) => buildCityRegex(slug)).filter(Boolean);
    if (cityRegexes.length) {
      providerMatch.$or = cityRegexes.flatMap((rx) => [
        { location: rx },
        { address: rx },
      ]);
    }
  }

  let serviceObjectIds = [];
  if (parsed.serviceSlugs.length && mongoose.connection.readyState === 1) {
    const svcDocs = await Service.find({ slug: { $in: parsed.serviceSlugs } }).select('_id slug').lean();
    serviceObjectIds = svcDocs.map((s) => s._id);
    if (serviceObjectIds.length) {
      providerMatch.services = { $in: serviceObjectIds };
    }
  }

  const providers = await withTimeout(
    User.find(providerMatch)
      .select('ratingAvg verified provider_status.isOnline successRate badges')
      .limit(5000)
      .lean()
  );

  const byKey = new Map();
  for (const p of providers) {
    const citySlug = parsed.locations[0] || 'poland';
    const key = `${parsed.categoryIds.join(',') || 'all'}::${citySlug}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        category: parsed.categoryIds[0] || 'all',
        location: parsed.locations[0] ? resolveCityMeta(parsed.locations[0]) : { city: 'Polska', citySlug: null, region: null },
        activeCount: 0,
        availableNowCount: 0,
        verifiedCount: 0,
        ratingSum: 0,
        ratingCount: 0,
        ratingBands: { '1-2': 0, '3': 0, '4': 0, '5': 0, unknown: 0 },
        responseRateSum: 0,
        responseRateCount: 0,
      });
    }
    const bucket = byKey.get(key);
    bucket.activeCount += 1;
    if (p.provider_status?.isOnline) bucket.availableNowCount += 1;
    if (p.verified || (Array.isArray(p.badges) && p.badges.includes('verified'))) {
      bucket.verifiedCount += 1;
    }
    const rating = Number(p.ratingAvg);
    if (rating > 0) {
      bucket.ratingSum += rating;
      bucket.ratingCount += 1;
      bucket.ratingBands[ratingBand(rating)] += 1;
    } else {
      bucket.ratingBands.unknown += 1;
    }
    const sr = Number(p.successRate);
    if (Number.isFinite(sr) && sr >= 0) {
      bucket.responseRateSum += sr;
      bucket.responseRateCount += 1;
    }
  }

  const aggregates = [...byKey.values()].map((b) => {
    const avgRating =
      b.ratingCount >= cfg.privacyMinCount
        ? Number((b.ratingSum / b.ratingCount).toFixed(2))
        : null;
    const avgResponseRate =
      b.responseRateCount >= cfg.privacyMinCount
        ? Number((b.responseRateSum / b.responseRateCount).toFixed(2))
        : null;

    const ratingBandsOut = {};
    for (const [band, cnt] of Object.entries(b.ratingBands)) {
      ratingBandsOut[band] = suppressCount(cnt);
    }

    return {
      category: b.category,
      location: b.location,
      activeContractorCount: suppressCount(b.activeCount),
      availableContractorCount: suppressCount(b.availableNowCount),
      verifiedContractorCount: suppressCount(b.verifiedCount),
      avgRating: avgRating != null ? { suppressed: false, value: avgRating } : { suppressed: true, value: null },
      ratingBands: ratingBandsOut,
      avgResponseRatePercent:
        avgResponseRate != null
          ? { suppressed: false, value: avgResponseRate }
          : { suppressed: true, value: null },
      coverageGap:
        b.activeCount < cfg.privacyMinCount
          ? { suppressed: false, value: 'low_supply' }
          : { suppressed: false, value: 'adequate' },
    };
  });

  const data = {
    aggregates,
    privacyMinCount: cfg.privacyMinCount,
    filters: {
      categoryIds: parsed.categoryIds,
      locations: parsed.locations,
    },
    note: 'Dostępność „availableNow” opiera się na provider_status.isOnline — sygnał przybliżony.',
  };
  cache.set(cacheKey, data);
  return { data };
}

function getClaimsRegistry() {
  const registry = require('../data/marketing_claims_registry.json');
  const codes = new Set();
  for (const claim of registry.claims || []) {
    if (codes.has(claim.code)) {
      throw new Error(`duplicate_claim_code:${claim.code}`);
    }
    codes.add(claim.code);
  }
  return registry;
}

function invalidateCache() {
  cache.clear();
}

module.exports = {
  getCatalog,
  getDemandSummary,
  getSupplySummary,
  getClaimsRegistry,
  validateSummaryRequest,
  suppressCount,
  invalidateCache,
  expandCategoryFilters,
};
