/**
 * Widełki cenowe wykonawcy — profil ogólny + per usługa.
 */

function rangesOverlap(min, max, clientMin, clientMax) {
  if (min == null || Number.isNaN(Number(min))) return true;
  const pMin = Number(min);
  const pMax = Number(max ?? min);
  const cMin = clientMin != null && !Number.isNaN(Number(clientMin)) ? Number(clientMin) : 0;
  const cMax =
    clientMax != null && !Number.isNaN(Number(clientMax)) ? Number(clientMax) : 999999;
  return pMin <= cMax && pMax >= cMin;
}

function resolveProviderPriceRange(user = {}) {
  const min =
    user.priceMin != null && user.priceMin !== ''
      ? Number(user.priceMin)
      : user.price != null && user.price !== ''
        ? Number(user.price)
        : null;
  const max =
    user.priceMax != null && user.priceMax !== ''
      ? Number(user.priceMax)
      : min;

  if (min == null || Number.isNaN(min)) {
    return { min: null, max: null };
  }

  const safeMax = max != null && !Number.isNaN(max) ? max : min;
  return { min, max: Math.max(min, safeMax) };
}

function getServicePriceEntries(user = {}, serviceIds = null) {
  const all = Array.isArray(user.servicePrices) ? user.servicePrices : [];
  if (!serviceIds || !serviceIds.length) return all;
  const ids = new Set(serviceIds.map(String));
  return all.filter((e) => ids.has(String(e.service)));
}

/** Zakres do wyświetlenia / sortowania — dla wybranych usług lub zbiorczo. */
function resolvePriceRangeForServices(user = {}, serviceIds = null) {
  const entries = getServicePriceEntries(user, serviceIds).filter((e) => e.min != null);
  if (entries.length) {
    const mins = entries.map((e) => Number(e.min));
    const maxs = entries.map((e) => Number(e.max ?? e.min));
    return { min: Math.min(...mins), max: Math.max(...maxs) };
  }
  return resolveProviderPriceRange(user);
}

/** Zakres „od–do” na liście bez filtra usługi (min/max ze wszystkich usług z ceną). */
function resolveDisplayPriceRange(user = {}) {
  const entries = (user.servicePrices || []).filter((e) => e.min != null);
  if (entries.length) {
    const mins = entries.map((e) => Number(e.min));
    const maxs = entries.map((e) => Number(e.max ?? e.min));
    return { min: Math.min(...mins), max: Math.max(...maxs) };
  }
  return resolveProviderPriceRange(user);
}

function providerMatchesBudget(user, clientMin, clientMax) {
  const { min, max } = resolveProviderPriceRange(user);
  return rangesOverlap(min, max, clientMin, clientMax);
}

/** Bez filtra usługi: pasuje, jeśli którakolwiek usługa (lub profil) mieści się w budżecie. */
function providerMatchesBudgetAnyService(user, clientMin, clientMax) {
  const priced = (user.servicePrices || []).filter((e) => e.min != null);
  if (priced.length) {
    return priced.some((e) => rangesOverlap(e.min, e.max ?? e.min, clientMin, clientMax));
  }
  return providerMatchesBudget(user, clientMin, clientMax);
}

/** Z filtrem usługi: tylko widełki dopasowanych usług (+ fallback profilu). */
function providerMatchesBudgetForServices(user, clientMin, clientMax, serviceIds = []) {
  const entries = getServicePriceEntries(user, serviceIds).filter((e) => e.min != null);
  if (entries.length) {
    return entries.some((e) => rangesOverlap(e.min, e.max ?? e.min, clientMin, clientMax));
  }
  return providerMatchesBudget(user, clientMin, clientMax);
}

/** @deprecated MongoDB coarse filter — prefer post-filter w search.js */
function buildBudgetOverlapMatch(budgetMin, budgetMax) {
  const hasMin = budgetMin != null && budgetMin !== '' && !Number.isNaN(Number(budgetMin)) && Number(budgetMin) > 0;
  const hasMax = budgetMax != null && budgetMax !== '' && !Number.isNaN(Number(budgetMax));
  if (!hasMin && !hasMax) return null;

  const cMin = hasMin ? Number(budgetMin) : 0;
  const cMax = hasMax ? Number(budgetMax) : 999999;

  return {
    $expr: {
      $let: {
        vars: {
          rawMin: { $ifNull: ['$priceMin', { $ifNull: ['$price', null] }] },
          rawMax: { $ifNull: ['$priceMax', null] },
        },
        in: {
          $cond: {
            if: { $eq: ['$$rawMin', null] },
            then: true,
            else: {
              $let: {
                vars: {
                  pMin: '$$rawMin',
                  pMax: { $ifNull: ['$$rawMax', '$$rawMin'] },
                },
                in: {
                  $and: [{ $lte: ['$$pMin', cMax] }, { $gte: ['$$pMax', cMin] }],
                },
              },
            },
          },
        },
      },
    },
  };
}

function appendSearchPriceFields(target, user, fallbackPrice, matchedServiceIds = null) {
  const { min, max } =
    matchedServiceIds && matchedServiceIds.length
      ? resolvePriceRangeForServices(user, matchedServiceIds)
      : resolveDisplayPriceRange(user);

  const from = min ?? fallbackPrice ?? null;
  const to = max ?? from;
  target.priceFrom = from;
  target.priceTo = to;
  target.price = from;
  if (from != null && to != null) {
    target.priceRange = from === to ? `${from}` : `${from}–${to}`;
  }
  return target;
}

function parsePriceInputs(priceMin, priceMax) {
  const minRaw = priceMin === '' || priceMin == null ? null : Number(priceMin);
  const maxRaw = priceMax === '' || priceMax == null ? null : Number(priceMax);

  if (minRaw != null && Number.isNaN(minRaw)) {
    return { error: 'Nieprawidłowa cena minimalna' };
  }
  if (maxRaw != null && Number.isNaN(maxRaw)) {
    return { error: 'Nieprawidłowa cena maksymalna' };
  }
  if (minRaw != null && minRaw < 0) {
    return { error: 'Cena minimalna nie może być ujemna' };
  }
  if (maxRaw != null && maxRaw < 0) {
    return { error: 'Cena maksymalna nie może być ujemna' };
  }
  if (minRaw != null && maxRaw != null && minRaw > maxRaw) {
    return { error: 'Cena minimalna nie może być wyższa od maksymalnej' };
  }

  return {
    priceMin: minRaw,
    priceMax: maxRaw,
    price: minRaw ?? undefined,
  };
}

function parseServicePricesPayload(prices, userServiceIds = []) {
  if (!Array.isArray(prices)) {
    return { error: 'Oczekiwano tablicy cen usług' };
  }

  const allowed = new Set(userServiceIds.map(String));
  const normalized = [];

  for (const row of prices) {
    const sid = String(row?.serviceId || row?.service || '').trim();
    if (!sid || !allowed.has(sid)) continue;

    const parsed = parsePriceInputs(row.min, row.max);
    if (parsed.error) return parsed;
    if (parsed.priceMin == null && parsed.priceMax == null) continue;

    normalized.push({
      service: sid,
      min: parsed.priceMin,
      max: parsed.priceMax,
    });
  }

  return { servicePrices: normalized };
}

function recomputeAggregatedProfilePrices(servicePrices = []) {
  const entries = servicePrices.filter((e) => e.min != null);
  if (!entries.length) return {};

  const mins = entries.map((e) => Number(e.min));
  const maxs = entries.map((e) => Number(e.max ?? e.min));
  return {
    priceMin: Math.min(...mins),
    priceMax: Math.max(...maxs),
    price: Math.min(...mins),
  };
}

module.exports = {
  rangesOverlap,
  resolveProviderPriceRange,
  resolvePriceRangeForServices,
  resolveDisplayPriceRange,
  providerMatchesBudget,
  providerMatchesBudgetAnyService,
  providerMatchesBudgetForServices,
  buildBudgetOverlapMatch,
  appendSearchPriceFields,
  parsePriceInputs,
  parseServicePricesPayload,
  recomputeAggregatedProfilePrices,
};
