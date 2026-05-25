/**
 * MarketplaceStatsService
 * -----------------------
 * Wyciąga z bazy realne, agregowane dane marketplace, których konkurencja
 * (Fixly/Oferteo) NIE publikuje. To buduje unikalność treści (E-E-A-T) i
 * stanowi paliwo dla:
 *   - poradników `/poradnik/:slug` (sekcja Live Stats, gdy ma `ctaCity`)
 *   - PSEO matrix `/wykonawcy/:service/:city` (cała strona zbudowana wokół tych danych)
 *   - admin dashboard (zdrowie marketplace)
 *
 * Wszystkie zapytania są:
 *   - tolerancyjne na błędy (zwracają `null` zamiast rzucać),
 *   - cache'owane LRU 1h (dane się zmieniają wolno, a Mongo ma swoje obciążenia),
 *   - bezpieczne dla brakujących indeksów (`.lean()`, limity, ograniczone agregacje).
 */

const { LRUCache } = require('lru-cache');
const Order = require('../models/Order');
const User = require('../models/User');
const Rating = require('../models/Rating');
const { TOP_PL_CITIES_BY_SLUG } = require('../utils/polishCities');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

const cache = new LRUCache({
  max: 500, // 500 wpisów (~30 miast × 15 najpopularniejszych usług)
  ttl: 60 * 60 * 1000 // 1h
});

function cacheKey(prefix, ...parts) {
  return `${prefix}:${parts.map((p) => (p == null ? '_' : String(p).toLowerCase())).join(':')}`;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Zbuduj regex dopasowujący polskie nazwy miasta (mianownik + miejscownik + bez polskich znaków).
 * Używamy `i` (case-insensitive), `g`-FLAG nie ma — pojedyncze dopasowanie wystarczy.
 */
function buildCityRegex(citySlug) {
  const city = TOP_PL_CITIES_BY_SLUG[citySlug];
  if (!city) return null;
  const alts = city.aliases.map(escapeRegex);
  return new RegExp(`(?:^|\\b)(?:${alts.join('|')})(?:\\b|$)`, 'i');
}

/**
 * Pobierz statystyki wykonawców dla danego miasta + opcjonalnej usługi.
 *
 * @param {Object} params
 * @param {string} [params.citySlug] – slug z `TOP_PL_CITIES` (np. "warszawa")
 * @param {string} [params.serviceSlug] – slug usługi (np. "hydraulik")
 * @returns {Promise<Object|null>}
 */
async function getProviderStats({ citySlug, serviceSlug } = {}) {
  const key = cacheKey('provider', citySlug, serviceSlug);
  if (cache.has(key)) return cache.get(key);

  try {
    const cityRegex = citySlug ? buildCityRegex(citySlug) : null;

    const match = {
      role: 'provider',
      isActive: { $ne: false },
      anonymized: { $ne: true }
    };
    if (cityRegex) {
      match.$or = [
        { location: cityRegex },
        { address: cityRegex }
      ];
    }

    // Filtruj po usłudze przez `services` (ref) – używamy populate, ale chcemy szybko.
    // Jeśli serviceSlug – wczytaj id usługi raz i dopnij filtr.
    let serviceFilter = null;
    if (serviceSlug) {
      try {
        const Service = require('../models/Service');
        const svc = await Service.findOne({ slug: serviceSlug.toLowerCase() })
          .select('_id')
          .lean();
        if (svc?._id) serviceFilter = svc._id;
      } catch (err) {
        logger.warn?.('[MarketplaceStats] Service lookup failed:', err.message);
      }
    }
    if (serviceFilter) match.services = serviceFilter;

    const providers = await User.find(match)
      .select('_id name providerLevel providerTier badges location rating')
      .limit(500)
      .lean();

    const count = providers.length;

    const verifiedCount = providers.filter((p) =>
      Array.isArray(p.badges) && (p.badges.includes('verified') || p.badges.includes('pro'))
    ).length;

    const proCount = providers.filter((p) =>
      ['pro', 'standard'].includes(p.providerTier) || ['pro', 'standard'].includes(p.providerLevel)
    ).length;

    // Średnia ocena (z User.rating jeśli mamy; lepiej z Rating, ale szybciej z denormalizacji)
    const ratedProviders = providers.filter((p) => Number(p.rating) > 0);
    const avgRating = ratedProviders.length
      ? Number(
          (
            ratedProviders.reduce((s, p) => s + Number(p.rating || 0), 0) /
            ratedProviders.length
          ).toFixed(2)
        )
      : null;

    const result = {
      count,
      verifiedCount,
      proCount,
      avgRating,
      sampledTopNames: providers
        .filter((p) => p.name)
        .slice(0, 6)
        .map((p) => p.name)
    };

    cache.set(key, result);
    return result;
  } catch (err) {
    logger.warn?.('[MarketplaceStats] getProviderStats failed:', err.message);
    return null;
  }
}

/**
 * Statystyki cenowe z faktycznie zrealizowanych zleceń.
 * Bierzemy zlecenia z ostatnich 180 dni (świeże dane), ze statusem zakończonym
 * (completed / released / paid). Filtr `service` po slugu LUB nazwie.
 */
async function getPriceStats({ citySlug, serviceSlug, days = 180 } = {}) {
  const key = cacheKey('price', citySlug, serviceSlug, days);
  if (cache.has(key)) return cache.get(key);

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const cityRegex = citySlug ? buildCityRegex(citySlug) : null;

    const match = {
      createdAt: { $gte: since },
      status: { $in: ['completed', 'rated', 'released', 'paid'] },
      priceTotal: { $gt: 0 }
    };
    if (serviceSlug) {
      // Order.service to string (slug lub kod). Dopasowujemy obie strony.
      match.service = new RegExp(`^${escapeRegex(serviceSlug)}$`, 'i');
    }
    if (cityRegex) {
      match.$or = [
        { city: cityRegex },
        { 'location.address': cityRegex }
      ];
    }

    const orders = await Order.find(match)
      .select('priceTotal amountTotal')
      .limit(2000)
      .lean();

    const prices = orders
      .map((o) => Number(o.priceTotal) || Number(o.amountTotal) / 100 || 0)
      .filter((p) => p > 0 && p < 100000) // filtr ekstremów / błędów
      .sort((a, b) => a - b);

    if (!prices.length) {
      const empty = { sampleSize: 0 };
      cache.set(key, empty);
      return empty;
    }

    const sum = prices.reduce((s, p) => s + p, 0);
    const mean = Math.round(sum / prices.length);
    const median = Math.round(prices[Math.floor(prices.length / 2)]);
    const p25 = Math.round(prices[Math.floor(prices.length * 0.25)]);
    const p75 = Math.round(prices[Math.floor(prices.length * 0.75)]);
    const min = Math.round(prices[0]);
    const max = Math.round(prices[prices.length - 1]);

    const result = { sampleSize: prices.length, mean, median, p25, p75, min, max, days };
    cache.set(key, result);
    return result;
  } catch (err) {
    logger.warn?.('[MarketplaceStats] getPriceStats failed:', err.message);
    return null;
  }
}

/**
 * Łączny snapshot dla strony marketplace (PSEO + LiveStatsCard w artykule).
 */
async function getCityServiceSnapshot({ citySlug, serviceSlug } = {}) {
  const key = cacheKey('snapshot', citySlug, serviceSlug);
  if (cache.has(key)) return cache.get(key);

  const [providers, prices] = await Promise.all([
    getProviderStats({ citySlug, serviceSlug }),
    getPriceStats({ citySlug, serviceSlug })
  ]);

  // Recent activity: ile zleceń ostatnich 30 dni
  let recentOrders30d = null;
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cityRegex = citySlug ? buildCityRegex(citySlug) : null;
    const m = { createdAt: { $gte: since } };
    if (serviceSlug) m.service = new RegExp(`^${escapeRegex(serviceSlug)}$`, 'i');
    if (cityRegex) m.$or = [{ city: cityRegex }, { 'location.address': cityRegex }];
    recentOrders30d = await Order.countDocuments(m);
  } catch (err) {
    logger.warn?.('[MarketplaceStats] recentOrders failed:', err.message);
  }

  const result = {
    citySlug: citySlug || null,
    serviceSlug: serviceSlug || null,
    providers: providers || { count: 0 },
    prices: prices || { sampleSize: 0 },
    recentOrders30d: recentOrders30d ?? null,
    generatedAt: new Date().toISOString()
  };
  cache.set(key, result);
  return result;
}

/**
 * Czysty stat „ile mamy fachowców per usługa w całej Polsce" – uniwersalny snippet.
 */
async function getServiceCountrywideStats(serviceSlug) {
  return getCityServiceSnapshot({ citySlug: null, serviceSlug });
}

function invalidateAll() {
  cache.clear();
}

module.exports = {
  getProviderStats,
  getPriceStats,
  getCityServiceSnapshot,
  getServiceCountrywideStats,
  invalidateAll
};
