/**
 * Routes: /api/seo/local
 *
 * Programmatic SEO — strony „usługa w mieście" generowane z bazy:
 *
 *  GET /api/seo/local/:serviceSlug/:citySlug
 *      → cała payloada potrzebna do wyrenderowania `/uslugi/:service/:city`
 *  GET /api/seo/local/services
 *      → katalog usług PSEO (do navi / listy)
 *  GET /api/seo/local/cities
 *      → katalog miast (do navi)
 *  GET /api/seo/local/index
 *      → mapka [{service, city, ordersCount}] – do wewnętrznego linkowania
 *
 * Te trasy są PUBLICZNE — Google ma do nich dotrzeć i je indeksować.
 */

const express = require('express');
const router = express.Router();

const {
  SEO_CITIES,
  SEO_LOCAL_SERVICES,
  SEO_DISTRICTS,
  getCityBySlug,
  getServiceBySlug,
  getDistrictBySlug,
  listDistricts
} = require('../utils/seoCities');
const {
  getServiceCityStats,
  getCityStats
} = require('../services/MarketplaceStatsService');

let logger; try { logger = require('../utils/logger'); } catch { logger = console; }

/**
 * Generuje meta tags (title, description, keywords) na bazie pary (service, city).
 * Wzorce dobrane pod realne wyszukiwania w PL.
 */
function buildMeta(service, city, stats, district = null) {
  const where = district
    ? `${city.name} (${district.name})`
    : city.name;
  const whereLoc = district
    ? `${city.locative}, dzielnica ${district.name}`
    : city.locative;

  const title = (
    district
      ? `${service.name} ${district.name} (${city.name}) — wykonawcy, cennik | Helpfli`
      : `${service.name} ${city.name} — cennik 2026, opinie, wykonawcy | Helpfli`
  ).slice(0, 70);

  const providersText = stats?.providers?.active > 0
    ? `${stats.providers.active} sprawdzonych wykonawców`
    : 'sprawdzeni wykonawcy';

  const priceText =
    stats?.prices?.avg > 0
      ? `średnia cena ${stats.prices.avg} zł`
      : 'aktualne ceny';

  const description = `${service.name} w ${whereLoc}: ${providersText}, ${priceText}, opinie i bezpłatna wycena. Znajdź ${service.namePerson || service.name.toLowerCase()} w 2 minuty na Helpfli.`.slice(0, 180);

  const keywords = [
    `${service.name.toLowerCase()} ${where.toLowerCase()}`,
    `${service.name.toLowerCase()} w ${whereLoc.toLowerCase()}`,
    `cennik ${service.name.toLowerCase()} ${where.toLowerCase()}`,
    `${service.namePerson || service.name.toLowerCase()} ${where.toLowerCase()}`,
    `dobry ${service.namePerson || service.name.toLowerCase()} ${where.toLowerCase()}`,
    `tani ${service.namePerson || service.name.toLowerCase()} ${where.toLowerCase()}`,
    `pilny ${service.name.toLowerCase()} ${where.toLowerCase()}`
  ];

  return { title, description, keywords };
}

/**
 * Zwraca powiązane miasta tej samej usługi i powiązane usługi tego samego miasta.
 * Używane do wewnętrznego linkowania (NAJWAŻNIEJSZE dla PSEO).
 */
function buildInternalLinks(service, city, district = null) {
  const otherCities = SEO_CITIES
    .filter((c) => c.slug !== city.slug)
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .slice(0, 12)
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      url: `/uslugi/${service.slug}/${c.slug}`
    }));

  const otherServices = SEO_LOCAL_SERVICES
    .filter((s) => s.slug !== service.slug)
    .filter((s) => s.category === service.category) // najpierw ta sama kategoria
    .concat(SEO_LOCAL_SERVICES.filter((s) => s.category !== service.category))
    .slice(0, 10)
    .map((s) => ({
      slug: s.slug,
      name: s.name,
      url: district
        ? `/uslugi/${s.slug}/${city.slug}/${district.slug}`
        : `/uslugi/${s.slug}/${city.slug}`
    }));

  const districts = listDistricts(city.slug)
    .filter((d) => !district || d.slug !== district.slug)
    .map((d) => ({
      slug: d.slug,
      name: d.name,
      url: `/uslugi/${service.slug}/${city.slug}/${d.slug}`
    }));

  return { otherCities, otherServices, districts };
}

/** GET /api/seo/local/services */
router.get('/services', (_req, res) => {
  res.json({ ok: true, services: SEO_LOCAL_SERVICES });
});

/** GET /api/seo/local/cities */
router.get('/cities', (_req, res) => {
  res.json({ ok: true, cities: SEO_CITIES });
});

/**
 * GET /api/seo/local/index
 *  Lekka lista wszystkich istotnych par (service × city), z liczbą zleceń.
 *  Może być duża (50 × 30 = 1500), ale to wciąż <100KB JSON.
 *  Cache 1h.
 */
router.get('/index', async (_req, res) => {
  try {
    const items = SEO_LOCAL_SERVICES.flatMap((s) =>
      SEO_CITIES.map((c) => ({
        service: { slug: s.slug, name: s.name, category: s.category },
        city: { slug: c.slug, name: c.name, voivodeship: c.voivodeship }
      }))
    );
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, total: items.length, items });
  } catch (err) {
    logger.error?.('[SEO LOCAL] /index error:', err);
    res.status(500).json({ ok: false, message: 'Błąd /index' });
  }
});

/**
 * GET /api/seo/local/city/:citySlug
 *  Sumaryczne stats jednego miasta + lista usług PSEO.
 *  Używane na `/uslugi/miasto/:city` (hub city-only).
 */
router.get('/city/:citySlug', async (req, res) => {
  try {
    const city = getCityBySlug(req.params.citySlug);
    if (!city) return res.status(404).json({ ok: false, message: 'Miasto nie znalezione' });

    const stats = await getCityStats(city.slug);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      ok: true,
      city,
      stats,
      services: SEO_LOCAL_SERVICES.map((s) => ({
        slug: s.slug,
        name: s.name,
        category: s.category,
        url: `/uslugi/${s.slug}/${city.slug}`
      }))
    });
  } catch (err) {
    logger.error?.('[SEO LOCAL] /city/:slug error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania danych miasta' });
  }
});

/**
 * GET /api/seo/local/districts/:citySlug
 *  Lista dzielnic miasta (do navi i sitemap).
 */
router.get('/districts/:citySlug', (req, res) => {
  const city = getCityBySlug(req.params.citySlug);
  if (!city) return res.status(404).json({ ok: false, message: 'Miasto nieznane' });
  const districts = listDistricts(city.slug);
  res.json({ ok: true, city, districts });
});

/**
 * GET /api/seo/local/:serviceSlug/:citySlug/:districtSlug
 *  Trzeci poziom PSEO – dzielnice. Tylko dla TOP4 miast (Warszawa, Kraków, Wrocław, Poznań, Gdańsk).
 */
router.get('/:serviceSlug/:citySlug/:districtSlug', async (req, res) => {
  try {
    const service = getServiceBySlug(req.params.serviceSlug);
    const city = getCityBySlug(req.params.citySlug);
    const district = city ? getDistrictBySlug(city.slug, req.params.districtSlug) : null;

    if (!service || !city || !district) {
      return res.status(404).json({ ok: false, message: 'Strona PSEO (dzielnica) nie znaleziona' });
    }

    const stats = await getServiceCityStats(service.slug, city.slug, district.slug);
    const meta = buildMeta(service, city, stats, district);
    const links = buildInternalLinks(service, city, district);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      service,
      city,
      district,
      stats,
      meta,
      links,
      canonical: `/uslugi/${service.slug}/${city.slug}/${district.slug}`,
      ctaUrl: `/create-order?service=${encodeURIComponent(service.slug)}&city=${encodeURIComponent(city.name)}&district=${encodeURIComponent(district.name)}`
    });
  } catch (err) {
    logger.error?.('[SEO LOCAL] /:service/:city/:district error:', err);
    res.status(500).json({ ok: false, message: 'Błąd PSEO district' });
  }
});

/**
 * GET /api/seo/local/:serviceSlug/:citySlug
 *  GŁÓWNY endpoint PSEO. Zwraca komplet danych do landing page.
 *  Cache HTTP: 5 min (dane MarketplaceStatsService też mają 5 min cache w procesie).
 */
router.get('/:serviceSlug/:citySlug', async (req, res) => {
  try {
    const service = getServiceBySlug(req.params.serviceSlug);
    const city = getCityBySlug(req.params.citySlug);

    if (!service || !city) {
      return res.status(404).json({ ok: false, message: 'Strona PSEO nie znaleziona' });
    }

    const stats = await getServiceCityStats(service.slug, city.slug);
    const meta = buildMeta(service, city, stats);
    const links = buildInternalLinks(service, city);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      ok: true,
      service,
      city,
      stats,
      meta,
      links,
      canonical: `/uslugi/${service.slug}/${city.slug}`,
      ctaUrl: `/create-order?service=${encodeURIComponent(service.slug)}&city=${encodeURIComponent(city.name)}`
    });
  } catch (err) {
    logger.error?.('[SEO LOCAL] /:service/:city error:', err);
    res.status(500).json({ ok: false, message: 'Błąd PSEO' });
  }
});

module.exports = router;
