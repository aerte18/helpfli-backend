/**
 * Routes: /api/seo
 * -----------------
 *  Publiczne:
 *    GET  /api/seo/articles            – lista opublikowanych poradników (paginacja, filtr po kategorii, search)
 *    GET  /api/seo/article/:slug       – jeden poradnik po slugu (zwiększa licznik views)
 *    GET  /api/seo/categories          – lista kategorii z licznikami
 *    GET  /api/seo/topics              – lista seedów dla admina (pomocnicze)
 *    GET  /api/seo/sitemap.xml         – dynamiczna sitemap (cache 1h)
 *    GET  /api/seo/robots.txt          – dynamiczny robots.txt
 *    GET  /api/seo/prerender           – HTML dla crawlerów (publiczny)
 *
 *  Admin (Bearer + rola admin/superadmin):
 *    POST   /api/seo/generate          { topic, hints?, publish? }   → wygeneruj artykuł
 *    POST   /api/seo/generate-bulk     { topics:[], publish? }       → wygeneruj kilka
 *    POST   /api/seo/generate-seed     { count?, publish? }          → wybiera tematy z seed listy
 *    GET    /api/seo/admin/articles    – pełna lista (też drafty)
 *    PATCH  /api/seo/admin/:id         { published, title, contentHtml, ... } – edycja
 *    DELETE /api/seo/admin/:id         – usuń
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const SeoArticle = require('../models/SeoArticle');
const Order = require('../models/Order');
const Service = require('../models/Service');
const Event = require('../models/Event');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const { generateAndStoreArticle } = require('../services/SeoArticleGenerator');
const { SEO_SEED_TOPICS, SEO_SEED_BY_CATEGORY } = require('../utils/seoTopics');
const { TOP_PL_CITIES, TOP_PL_CITIES_BY_SLUG, detectCitySlug } = require('../utils/polishCities');
const MarketplaceStats = require('../services/MarketplaceStatsService');
const { getPublicBaseUrl } = require('../utils/publicUrl');
const SeoLocalPage = require('../models/SeoLocalPage');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

const ADMIN_ROLES = ['admin', 'superadmin'];

function ensureMongoConnected(res) {
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection?.readyState === 1) return true;
  res.status(503).json({
    ok: false,
    message: 'Baza danych niedostępna (MongoDB not connected).'
  });
  return false;
}

function safeIsoDate(value) {
  if (!value) return new Date().toISOString();
  try {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function buildStaticSitemapUrls(base) {
  return [
    { loc: `${base}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${base}/poradniki`, changefreq: 'daily', priority: '0.9' },
    { loc: `${base}/wykonawcy`, changefreq: 'weekly', priority: '0.85' },
    { loc: `${base}/home`, changefreq: 'daily', priority: '0.9' },
    { loc: `${base}/providers`, changefreq: 'daily', priority: '0.8' },
    { loc: `${base}/services`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${base}/about`, changefreq: 'monthly', priority: '0.4' },
    { loc: `${base}/help`, changefreq: 'monthly', priority: '0.4' }
  ];
}

function renderSitemapXml(base, articles = [], localPages = [], providers = [], services = []) {
  const staticUrls = buildStaticSitemapUrls(base);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...staticUrls.map(
      (u) =>
        `<url><loc>${escapeXml(u.loc)}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
    ),
    ...articles.map((a) => {
      const lastmod = safeIsoDate(a.updatedAt || a.publishedAt);
      return `<url><loc>${escapeXml(`${base}/poradnik/${a.slug}`)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    }),
    ...localPages.map((p) => {
      const lastmod = safeIsoDate(p.lastBuiltAt || p.updatedAt);
      return `<url><loc>${escapeXml(`${base}/wykonawcy/${p.serviceSlug}/${p.citySlug}`)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.75</priority></url>`;
    }),
    ...services.map((s) => {
      const lastmod = safeIsoDate(s.updatedAt);
      return `<url><loc>${escapeXml(`${base}/service/${s.slug}`)}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.55</priority></url>`;
    }),
    ...providers.map((p) => {
      const lastmod = safeIsoDate(p.updatedAt);
      return `<url><loc>${escapeXml(`${base}/provider/${p._id}`)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.5</priority></url>`;
    }),
    '</urlset>'
  ].join('\n');
  return xml;
}

async function fetchSitemapEntityUrls() {
  const User = require('../models/User');
  const maxProviders = Math.min(
    2000,
    Math.max(50, parseInt(process.env.SITEMAP_MAX_PROVIDERS, 10) || 500)
  );
  const maxServices = Math.min(
    2000,
    Math.max(50, parseInt(process.env.SITEMAP_MAX_SERVICES, 10) || 500)
  );

  const [providers, services] = await Promise.all([
    User.find({
      role: { $in: ['provider', 'company_owner', 'company_manager'] },
      isActive: true,
      anonymized: { $ne: true },
      deletedAt: null
    })
      .select('_id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(maxProviders)
      .lean(),
    Service.find({ slug: { $exists: true, $nin: [null, ''] } })
      .select('slug updatedAt')
      .sort({ is_top: -1, updatedAt: -1 })
      .limit(maxServices)
      .lean()
  ]);

  return { providers, services };
}

function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ===================== PUBLIC =====================

/**
 * GET /api/seo/articles
 */
router.get('/articles', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const query = { published: true };
    if (req.query.category) query.category = String(req.query.category).toLowerCase();
    if (req.query.q && String(req.query.q).trim().length >= 2) {
      query.$text = { $search: String(req.query.q).trim() };
    }

    const [items, total] = await Promise.all([
      SeoArticle.find(query)
        .select('slug title category problem metaDescription readingTime publishedAt views heroImage keywords')
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SeoArticle.countDocuments(query)
    ]);

    res.json({
      ok: true,
      items,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    });
  } catch (err) {
    logger.error?.('[SEO] /articles error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania listy poradników' });
  }
});

/**
 * GET /api/seo/article/:slug
 */
router.get('/article/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ ok: false, message: 'Brak slug' });

    const article = await SeoArticle.findOne({ slug, published: true }).lean();
    if (!article) return res.status(404).json({ ok: false, message: 'Poradnik nie znaleziony' });

    // Najczęściej brane „related" – inne artykuły z tej samej kategorii
    const related = await SeoArticle.find({
      _id: { $ne: article._id },
      published: true,
      category: article.category
    })
      .select('slug title category readingTime')
      .sort({ publishedAt: -1 })
      .limit(5)
      .lean();

    // Increment views (fire & forget)
    SeoArticle.updateOne({ _id: article._id }, { $inc: { views: 1 } }).catch(() => {});

    res.json({ ok: true, article, related });
  } catch (err) {
    logger.error?.('[SEO] /article/:slug error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania poradnika' });
  }
});

/**
 * GET /api/seo/categories
 */
router.get('/categories', async (_req, res) => {
  try {
    const agg = await SeoArticle.aggregate([
      { $match: { published: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    res.json({
      ok: true,
      categories: agg.map((c) => ({ category: c._id || 'porady', count: c.count }))
    });
  } catch (err) {
    logger.error?.('[SEO] /categories error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania kategorii' });
  }
});

/**
 * GET /api/seo/topics
 * Lista seed-tematów (do widoku administratora)
 */
router.get('/topics', authMiddleware, requireRole(ADMIN_ROLES), async (_req, res) => {
  try {
    // Mapa istniejących tematów żeby admin widział co już zostało wygenerowane
    const existing = await SeoArticle.find({}).select('topic slug published').lean();
    const existingByTopic = new Map(
      existing.map((a) => [String(a.topic || '').toLowerCase(), a])
    );

    const enriched = SEO_SEED_TOPICS.map((t) => {
      const ex = existingByTopic.get(String(t.topic).toLowerCase());
      return {
        ...t,
        existing: ex ? { slug: ex.slug, published: ex.published } : null
      };
    });

    res.json({
      ok: true,
      topics: enriched,
      byCategory: SEO_SEED_BY_CATEGORY,
      total: SEO_SEED_TOPICS.length
    });
  } catch (err) {
    logger.error?.('[SEO] /topics error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania tematów' });
  }
});

/**
 * Sitemap handler – eksportowany, by można było podpiąć go także pod `/sitemap.xml`.
 */
async function sitemapHandler(_req, res) {
  const base = getPublicBaseUrl();
  let articles = [];
  let localPages = [];
  let providers = [];
  let services = [];

  try {
    if (mongoose.connection?.readyState === 1) {
      const entityUrls = await fetchSitemapEntityUrls();
      providers = entityUrls.providers;
      services = entityUrls.services;
      [articles, localPages] = await Promise.all([
        SeoArticle.find({ published: true })
          .select('slug updatedAt publishedAt')
          .sort({ publishedAt: -1 })
          .limit(50000)
          .lean(),
        SeoLocalPage.find({ published: true })
          .select('serviceSlug citySlug updatedAt lastBuiltAt')
          .sort({ lastBuiltAt: -1 })
          .limit(50000)
          .lean()
      ]);
    } else {
      logger.warn?.('[SEO] sitemap: MongoDB not connected — returning static URLs only');
    }
  } catch (err) {
    logger.error?.('[SEO] sitemap DB error (fallback to static):', err);
  }

  try {
    const xml = renderSitemapXml(base, articles, localPages, providers, services);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.send(xml);
  } catch (err) {
    logger.error?.('[SEO] sitemap render error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Sitemap error');
  }
}

function robotsHandler(_req, res) {
  const base = getPublicBaseUrl();
  const body = [
    'User-agent: *',
    'Allow: /',
    'Allow: /poradniki',
    'Allow: /poradnik/',
    'Allow: /wykonawcy/',
    'Allow: /wykonawcy',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /home',
    'Disallow: /admin/',
    'Disallow: /account/',
    'Disallow: /orders/',
    'Disallow: /chat/',
    'Disallow: /api/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    ''
  ].join('\n');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(body);
}

router.get('/sitemap.xml', sitemapHandler);
router.get('/robots.txt', robotsHandler);

const { prerenderHandler } = require('../services/SeoPrerenderService');
router.get('/prerender', prerenderHandler);

/**
 * GET /api/seo/stats?service=&city=
 *  Publiczny, cache'owany endpoint dla LiveStatsCard.
 *  Akceptuje również `cityName` (pełna nazwa polska, np. „Warszawa") — sam wykryje slug.
 */
router.get('/stats', async (req, res) => {
  try {
    const serviceSlug = req.query.service
      ? String(req.query.service).toLowerCase().trim()
      : null;
    let citySlug = req.query.city ? String(req.query.city).toLowerCase().trim() : null;
    if (!citySlug && req.query.cityName) {
      citySlug = detectCitySlug(String(req.query.cityName));
    }
    if (citySlug && !TOP_PL_CITIES_BY_SLUG[citySlug]) {
      // brak wsparcia – zwracamy snapshot ogólnopolski, ale informujemy
      const data = await MarketplaceStats.getServiceCountrywideStats(serviceSlug);
      return res.json({ ok: true, requested: { citySlug, serviceSlug }, snapshot: data, citySupported: false });
    }
    const data = await MarketplaceStats.getCityServiceSnapshot({ citySlug, serviceSlug });
    res.set('Cache-Control', 'public, max-age=600'); // 10 min CDN cache
    res.json({
      ok: true,
      requested: { citySlug, serviceSlug },
      cityName: citySlug ? TOP_PL_CITIES_BY_SLUG[citySlug]?.name : null,
      snapshot: data
    });
  } catch (err) {
    logger.error?.('[SEO] /stats error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania statystyk' });
  }
});

/**
 * GET /api/seo/cities
 *  Lista wspieranych miast (do PSEO + LiveStats wyboru).
 */
router.get('/cities', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400'); // 24h
  res.json({
    ok: true,
    cities: TOP_PL_CITIES.map((c) => ({ name: c.name, slug: c.slug }))
  });
});

// ===================== PROGRAMMATIC SEO (PSEO) =====================

/** Katalog usług/miast dla huba /wykonawcy (musi być przed /local/:service/:city) */
router.get('/local/services', (_req, res) => {
  try {
    const { SEO_LOCAL_SERVICES } = require('../utils/seoCities');
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ ok: true, services: SEO_LOCAL_SERVICES });
  } catch (err) {
    logger.error?.('[SEO] /local/services error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania usług' });
  }
});

router.get('/local/cities', (_req, res) => {
  try {
    const { SEO_CITIES } = require('../utils/seoCities');
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({
      ok: true,
      cities: SEO_CITIES.map((c) => ({ slug: c.slug, name: c.name }))
    });
  } catch (err) {
    logger.error?.('[SEO] /local/cities error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania miast' });
  }
});

/**
 * GET /api/seo/local/:service/:city
 *   Pobierz (lub zbuduj on-the-fly) landing page miasto×usługa.
 *   Jeśli strona nie istnieje, generujemy ją synchronicznie – pierwszy hit jest
 *   wolniejszy (~5s LLM), kolejne natychmiastowe (LRU cache + DB).
 */
router.get('/local/:service/:city', async (req, res) => {
  try {
    const serviceSlug = String(req.params.service || '').toLowerCase().trim();
    const citySlug = String(req.params.city || '').toLowerCase().trim();
    if (!serviceSlug || !citySlug || !TOP_PL_CITIES_BY_SLUG[citySlug]) {
      return res.status(404).json({ ok: false, message: 'Nieznane miasto lub usługa' });
    }

    const SeoLocalPage = require('../models/SeoLocalPage');
    let page = await SeoLocalPage.findOne({ serviceSlug, citySlug, published: true });

    if (!page) {
      const { buildOrUpdateLocalPage } = require('../services/SeoLocalPageGenerator');
      try {
        page = await buildOrUpdateLocalPage({ serviceSlug, citySlug });
      } catch (err) {
        logger.warn?.('[SEO] PSEO build error:', err.message);
        return res.status(404).json({ ok: false, message: err.message });
      }
    }

    // Dolicz odsłonę (nieblokująco)
    SeoLocalPage.updateOne({ _id: page._id }, { $inc: { views: 1 } }).catch(() => {});

    // Live stats – nadpisujemy snapshot świeżymi danymi (cache 1h w service)
    const liveSnapshot = await MarketplaceStats.getCityServiceSnapshot({
      citySlug,
      serviceSlug
    });

    res.set('Cache-Control', 'public, max-age=600'); // 10 min CDN cache
    res.json({
      ok: true,
      page,
      liveSnapshot
    });
  } catch (err) {
    logger.error?.('[SEO] /local error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania strony' });
  }
});

/**
 * GET /api/seo/local
 *   Lista wszystkich opublikowanych PSEO landing pages (do indeksu i sitemap).
 *   Wsparcie filtrów ?service=&city= + page/limit.
 */
router.get('/local', async (req, res) => {
  try {
    const SeoLocalPage = require('../models/SeoLocalPage');
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = { published: true };
    if (req.query.service) filter.serviceSlug = String(req.query.service).toLowerCase();
    if (req.query.city) filter.citySlug = String(req.query.city).toLowerCase();

    const [items, total] = await Promise.all([
      SeoLocalPage.find(filter)
        .select('serviceSlug serviceName citySlug cityName slug title metaDescription statsSnapshot lastBuiltAt')
        .sort({ lastBuiltAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SeoLocalPage.countDocuments(filter)
    ]);

    res.set('Cache-Control', 'public, max-age=600');
    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    logger.error?.('[SEO] /local list error:', err);
    res.status(500).json({ ok: false, message: 'Błąd listy PSEO' });
  }
});

// ===================== ADMIN =====================

router.use(authMiddleware);
router.use(requireRole(ADMIN_ROLES));

/**
 * POST /api/seo/generate
 *  body: { topic, hints?, publish? }
 */
router.post('/generate', async (req, res) => {
  try {
    const { topic, hints, publish } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ ok: false, message: 'Brakuje pola `topic`' });
    }

    const result = await generateAndStoreArticle({
      topic,
      hints: hints || {},
      publish: !!publish,
      generatedBy: req.user?._id || null
    });

    // IndexNow ping przy publikacji
    if (result.article?.published) {
      try {
        const indexNow = require('../services/IndexNowService');
        const base = getPublicBaseUrl();
        indexNow.submit(`${base}/poradnik/${result.article.slug}`).catch(() => {});
      } catch { /* opcjonalne */ }
    }

    res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      provider: result.provider,
      article: result.article
    });
  } catch (err) {
    logger.error?.('[SEO] /generate error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd generowania' });
  }
});

/**
 * POST /api/seo/generate-bulk
 *  body: { topics: ["pralka e20", "kran cieknie", ...], publish? }
 *  Generuje sekwencyjnie z opóźnieniem 500 ms, żeby nie wbić rate limitera LLM.
 */
router.post('/generate-bulk', async (req, res) => {
  try {
    const { topics, publish } = req.body || {};
    if (!Array.isArray(topics) || topics.length === 0) {
      return res.status(400).json({ ok: false, message: 'Brak `topics`' });
    }
    if (topics.length > 50) {
      return res
        .status(400)
        .json({ ok: false, message: 'Maksymalnie 50 tematów naraz (Google lubi jakość)' });
    }

    const results = [];
    for (const topic of topics) {
      try {
        const r = await generateAndStoreArticle({
          topic,
          publish: !!publish,
          generatedBy: req.user?._id || null
        });
        results.push({ topic, ok: true, slug: r.article.slug, created: r.created, provider: r.provider });
      } catch (err) {
        results.push({ topic, ok: false, error: err.message });
      }
      // mały throttling
      await new Promise((r2) => setTimeout(r2, 500));
    }

    res.json({ ok: true, results });
  } catch (err) {
    logger.error?.('[SEO] /generate-bulk error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd generowania masowego' });
  }
});

/**
 * POST /api/seo/generate-seed
 *  body: { count?, publish? }
 *  Bierze pierwsze `count` tematów z seed listy, których jeszcze nie ma.
 */
router.post('/generate-seed', async (req, res) => {
  try {
    const count = Math.min(50, Math.max(1, parseInt(req.body?.count, 10) || 10));
    const publish = !!req.body?.publish;

    const existing = await SeoArticle.find({}).select('topic').lean();
    const taken = new Set(existing.map((a) => String(a.topic || '').toLowerCase()));
    const queue = SEO_SEED_TOPICS.filter((t) => !taken.has(t.topic.toLowerCase())).slice(0, count);

    const results = [];
    for (const t of queue) {
      try {
        const r = await generateAndStoreArticle({
          topic: t.topic,
          hints: { category: t.category, keywords: t.keywords || [] },
          publish,
          generatedBy: req.user?._id || null
        });
        results.push({ topic: t.topic, ok: true, slug: r.article.slug, created: r.created, provider: r.provider });
      } catch (err) {
        results.push({ topic: t.topic, ok: false, error: err.message });
      }
      await new Promise((r2) => setTimeout(r2, 500));
    }

    res.json({ ok: true, planned: queue.length, results });
  } catch (err) {
    logger.error?.('[SEO] /generate-seed error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd generowania z seed listy' });
  }
});

/**
 * GET /api/seo/admin/articles
 *  Pełna lista (też drafty).
 */
router.get('/admin/articles', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.published === 'true') query.published = true;
    if (req.query.published === 'false') query.published = false;
    if (req.query.category) query.category = String(req.query.category).toLowerCase();
    if (req.query.q && String(req.query.q).trim().length >= 2) {
      query.$text = { $search: String(req.query.q).trim() };
    }

    const [items, total] = await Promise.all([
      SeoArticle.find(query)
        .select(
          'slug title topic category published publishedAt views readingTime aiProvider aiGenerated metaTitle wordCount createdAt updatedAt'
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SeoArticle.countDocuments(query)
    ]);

    res.json({
      ok: true,
      items,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    });
  } catch (err) {
    logger.error?.('[SEO] /admin/articles error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania listy admina' });
  }
});

/**
 * GET /api/seo/admin/articles/:id (pełna treść)
 */
router.get('/admin/articles/:id', async (req, res) => {
  try {
    const article = await SeoArticle.findById(req.params.id).lean();
    if (!article) return res.status(404).json({ ok: false, message: 'Nie znaleziono' });
    res.json({ ok: true, article });
  } catch (err) {
    logger.error?.('[SEO] /admin/articles/:id error:', err);
    res.status(500).json({ ok: false, message: 'Błąd pobierania artykułu' });
  }
});

/**
 * PATCH /api/seo/admin/:id
 *  Edycja podstawowych pól + publikacja.
 */
router.patch('/admin/:id', async (req, res) => {
  try {
    const patch = {};
    const allowed = [
      'title', 'metaTitle', 'metaDescription', 'intro', 'contentHtml',
      'category', 'keywords', 'heroImage', 'published', 'faq', 'relatedServiceCodes',
      'ctaCity'
    ];
    for (const k of allowed) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (patch.published === true) {
      patch.publishedAt = patch.publishedAt || new Date();
    }
    const before = await SeoArticle.findById(req.params.id).select('published slug').lean();
    const updated = await SeoArticle.findByIdAndUpdate(
      req.params.id,
      { $set: patch },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return res.status(404).json({ ok: false, message: 'Nie znaleziono' });

    // IndexNow – jeśli właśnie opublikowano (false → true) lub zmieniono treść opublikowanej
    if (updated.published) {
      const wasNotPublished = !before?.published;
      const contentChanged = ['contentHtml', 'metaTitle', 'metaDescription', 'tldr'].some(
        (f) => f in (req.body || {})
      );
      if (wasNotPublished || contentChanged) {
        try {
          const indexNow = require('../services/IndexNowService');
          const base = getPublicBaseUrl();
          indexNow.submit(`${base}/poradnik/${updated.slug}`).catch(() => {});
        } catch { /* opcjonalne */ }
      }
    }

    res.json({ ok: true, article: updated });
  } catch (err) {
    logger.error?.('[SEO] PATCH /admin/:id error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd aktualizacji' });
  }
});

/**
 * DELETE /api/seo/admin/:id
 */
router.delete('/admin/:id', async (req, res) => {
  try {
    const deleted = await SeoArticle.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ ok: false, message: 'Nie znaleziono' });
    res.json({ ok: true });
  } catch (err) {
    logger.error?.('[SEO] DELETE /admin/:id error:', err);
    res.status(500).json({ ok: false, message: 'Błąd usuwania' });
  }
});

// ============ ADMIN: PSEO landing pages ============

/**
 * POST /api/seo/admin/local/rebuild
 *   Body: { service: "hydraulik", city: "warszawa", force: true }
 *   Buduje/odświeża pojedynczą stronę PSEO.
 */
router.post('/admin/local/rebuild', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const { service, city, force = false } = req.body || {};
    if (!service || !city) {
      return res.status(400).json({ ok: false, message: 'Wymagane: service, city' });
    }
    const { buildOrUpdateLocalPage } = require('../services/SeoLocalPageGenerator');
    const page = await buildOrUpdateLocalPage({
      serviceSlug: String(service).toLowerCase(),
      citySlug: String(city).toLowerCase(),
      forceRegenerate: Boolean(force)
    });
    // Trigger IndexNow (jeśli włączony) – fire-and-forget
    try {
      const indexNow = require('../services/IndexNowService');
      const base = getPublicBaseUrl();
      indexNow.submit(`${base}/wykonawcy/${page.serviceSlug}/${page.citySlug}`).catch(() => {});
    } catch { /* IndexNow opcjonalny */ }
    res.json({ ok: true, page });
  } catch (err) {
    logger.error?.('[SEO] PSEO rebuild error:', err);
    const msg = err?.message || 'Błąd rebuilda';
    if (/Nieznana usługa|Nieznane miasto/i.test(msg)) {
      return res.status(400).json({ ok: false, message: msg });
    }
    res.status(500).json({ ok: false, message: msg });
  }
});

/**
 * POST /api/seo/admin/local/bulk-build
 *   Body: { services: ["hydraulik", "elektryk"], cities: ["warszawa", "krakow"], force: false }
 *   Buduje macierz service × city. Throttled (500ms między LLM call).
 *   Domyślnie tylko brakujące — `force: true` regeneruje wszystko.
 */
router.post('/admin/local/bulk-build', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const services = Array.isArray(req.body?.services) ? req.body.services : [];
    const cities = Array.isArray(req.body?.cities) ? req.body.cities : [];
    const force = Boolean(req.body?.force);
    if (!services.length || !cities.length) {
      return res.status(400).json({ ok: false, message: 'Wymagane: services[], cities[]' });
    }
    const pairCount = services.length * cities.length;
    const maxPairs = Math.min(Math.max(parseInt(process.env.PSEO_BULK_MAX_PAIRS, 10) || 15, 1), 50);
    if (pairCount > maxPairs) {
      return res.status(400).json({
        ok: false,
        message:
          `Za dużo par (${pairCount}). Jedno żądanie bulk-build obsługuje max ${maxPairs} — ` +
          'użyj panelu admina (buduje po kolei) lub zmniejsz macierz.'
      });
    }
    const { buildOrUpdateLocalPage } = require('../services/SeoLocalPageGenerator');
    const indexNow = (() => { try { return require('../services/IndexNowService'); } catch { return null; } })();
    const base = getPublicBaseUrl();

    const results = [];
    const indexNowUrls = [];
    for (const svc of services) {
      for (const city of cities) {
        try {
          const page = await buildOrUpdateLocalPage({
            serviceSlug: String(svc).toLowerCase(),
            citySlug: String(city).toLowerCase(),
            forceRegenerate: force
          });
          indexNowUrls.push(`${base}/wykonawcy/${page.serviceSlug}/${page.citySlug}`);
          results.push({ service: svc, city, ok: true, slug: page.slug });
          // throttle żeby nie spamować Claude API
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          results.push({ service: svc, city, ok: false, error: err.message });
        }
      }
    }
    if (indexNow && indexNowUrls.length) {
      indexNow.submitBatch(indexNowUrls).catch(() => {});
    }
    res.json({ ok: true, total: results.length, results });
  } catch (err) {
    logger.error?.('[SEO] PSEO bulk-build error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd bulk-build' });
  }
});

/**
 * GET /api/seo/admin/local/suggest
 *  Podpowiedź "najlepszej" macierzy PSEO (miasta + usługi) na bazie popytu.
 *  Ranking usług: liczba zleceń z 90 dni + preferencja dla usług topowych.
 */
/**
 * GET /api/seo/admin/local/traffic?days=30
 *  Ruch na stronach PSEO i poradnikach (telemetria page_view + licznik views w DB).
 */
router.get('/admin/local/traffic', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const end = new Date();
    const pvMatch = { type: 'page_view', createdAt: { $gte: start, $lte: end } };

    const SiteVisitDaily = require('../models/SiteVisitDaily');
    const dateFrom = start.toISOString().slice(0, 10);
    const dateTo = end.toISOString().slice(0, 10);

    const [
      totalPageViews,
      pseoPageViews,
      poradnikPageViews,
      distinctSessions,
      loggedInVisitors,
      allVisitsTotal,
      dailyPseo,
      topPseoPaths,
      topPoradnikPaths,
      topDbPseo
    ] = await Promise.all([
      Event.countDocuments(pvMatch),
      Event.countDocuments({ ...pvMatch, 'properties.path': { $regex: '^/wykonawcy/', $options: 'i' } }),
      Event.countDocuments({ ...pvMatch, 'properties.path': { $regex: '^/poradnik/', $options: 'i' } }),
      Event.distinct('sessionId', {
        ...pvMatch,
        sessionId: { $nin: [null, ''] }
      }).then((ids) => ids.length),
      Event.distinct('userId', {
        ...pvMatch,
        userId: { $ne: null }
      }).then((ids) => ids.length),
      SiteVisitDaily.aggregate([
        { $match: { date: { $gte: dateFrom, $lte: dateTo }, path: '__total__' } },
        { $group: { _id: null, total: { $sum: '$count' } } }
      ]).then((r) => r[0]?.total || 0),
      Event.aggregate([
        {
          $match: {
            ...pvMatch,
            'properties.path': { $regex: '^/wykonawcy/', $options: 'i' }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            views: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Event.aggregate([
        {
          $match: {
            ...pvMatch,
            'properties.path': { $regex: '^/wykonawcy/', $options: 'i' }
          }
        },
        {
          $group: {
            _id: '$properties.path',
            views: { $sum: 1 },
            sessions: { $addToSet: '$sessionId' }
          }
        },
        {
          $project: {
            path: '$_id',
            views: 1,
            sessions: { $size: '$sessions' }
          }
        },
        { $sort: { views: -1 } },
        { $limit: 25 }
      ]),
      Event.aggregate([
        {
          $match: {
            ...pvMatch,
            'properties.path': { $regex: '^/poradnik/', $options: 'i' }
          }
        },
        {
          $group: {
            _id: '$properties.path',
            views: { $sum: 1 }
          }
        },
        { $sort: { views: -1 } },
        { $limit: 15 }
      ]),
      (async () => {
        const SeoLocalPage = require('../models/SeoLocalPage');
        return SeoLocalPage.find({ published: true })
          .select('serviceSlug citySlug serviceName cityName views slug')
          .sort({ views: -1 })
          .limit(20)
          .lean();
      })()
    ]);

    const telemetryByPath = Object.fromEntries(
      (topPseoPaths || [])
        .filter((r) => r.path)
        .map((r) => [String(r.path).split('?')[0], r.views])
    );

    res.json({
      ok: true,
      range: { days, from: start.toISOString(), to: end.toISOString() },
      summary: {
        totalPageViews,
        allVisits: allVisitsTotal,
        pseoPageViews,
        poradnikPageViews,
        distinctSessions,
        loggedInVisitors
      },
      dailyPseo: dailyPseo.map((r) => ({ date: r._id, views: r.views })),
      topPseoPaths: topPseoPaths.map((r) => ({
        path: r.path,
        views: r.views,
        sessions: r.sessions
      })),
      topPoradnikPaths: topPoradnikPaths.map((r) => ({ path: r._id, views: r.views })),
      topDbPseo: topDbPseo.map((p) => ({
        ...p,
        path: `/wykonawcy/${p.serviceSlug}/${p.citySlug}`,
        telemetryViews: telemetryByPath[`/wykonawcy/${p.serviceSlug}/${p.citySlug}`] || 0
      })),
      note:
        '„Wejścia (sesje)” = anonimowy licznik (1× na sesję przeglądarki). „Telemetria page_view” = odsłony per nawigacja, tylko po zgodzie na analitykę. Licznik views w DB = otwarcia landingów PSEO przez API.'
    });
  } catch (err) {
    logger.error?.('[SEO] PSEO traffic error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd statystyk ruchu' });
  }
});

router.get('/admin/local/suggest', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const serviceLimit = Math.min(20, Math.max(3, parseInt(req.query.serviceLimit, 10) || 8));
    const cityLimit = Math.min(20, Math.max(3, parseInt(req.query.cityLimit, 10) || 10));
    const days = Math.min(365, Math.max(30, parseInt(req.query.days, 10) || 90));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const serviceAgg = await Order.aggregate([
      { $match: { createdAt: { $gte: since }, service: { $exists: true, $ne: '' } } },
      { $group: { _id: { $toLower: '$service' }, orders: { $sum: 1 } } },
      { $sort: { orders: -1 } },
      { $limit: 150 }
    ]);

    const candidateServiceSlugs = serviceAgg.map((x) => x._id).filter(Boolean);
    const catalogServices = await Service.find({ slug: { $in: candidateServiceSlugs } })
      .select('slug name_pl is_top')
      .lean();
    const catalogBySlug = new Map(catalogServices.map((s) => [s.slug, s]));

    const rankedServices = serviceAgg
      .filter((row) => catalogBySlug.has(row._id))
      .map((row) => {
        const svc = catalogBySlug.get(row._id);
        return {
          slug: svc.slug,
          name: svc.name_pl || svc.slug,
          recentOrders: row.orders,
          score: row.orders + (Number(svc.is_top) ? 12 : 0),
          isTop: Boolean(Number(svc.is_top))
        };
      })
      .sort((a, b) => b.score - a.score || b.recentOrders - a.recentOrders)
      .slice(0, serviceLimit);

    const suggestedServices = rankedServices.map(({ slug, name, recentOrders, isTop }) => ({
      slug, name, recentOrders, isTop
    }));

    const suggestedCities = TOP_PL_CITIES
      .slice(0, cityLimit)
      .map((c) => ({ slug: c.slug, name: c.name }));

    res.json({
      ok: true,
      strategy: `Top usługi z ostatnich ${days} dni + największe miasta`,
      services: suggestedServices,
      cities: suggestedCities
    });
  } catch (err) {
    logger.error?.('[SEO] PSEO suggest error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd propozycji PSEO' });
  }
});

/**
 * GET /api/seo/admin/local
 *   Pełna lista PSEO (włącznie z draftami / niepublikowanymi).
 */
router.get('/admin/local', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const SeoLocalPage = require('../models/SeoLocalPage');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.service) filter.serviceSlug = String(req.query.service).toLowerCase();
    if (req.query.city) filter.citySlug = String(req.query.city).toLowerCase();
    const [items, total] = await Promise.all([
      SeoLocalPage.find(filter)
        .sort({ lastBuiltAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SeoLocalPage.countDocuments(filter)
    ]);
    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    logger.error?.('[SEO] /admin/local list error:', err);
    res.status(500).json({ ok: false, message: 'Błąd listy' });
  }
});

/**
 * DELETE /api/seo/admin/local/:id
 */
router.delete('/admin/local/:id', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const SeoLocalPage = require('../models/SeoLocalPage');
    const deleted = await SeoLocalPage.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ ok: false, message: 'Nie znaleziono' });
    res.json({ ok: true });
  } catch (err) {
    logger.error?.('[SEO] DELETE local error:', err);
    res.status(500).json({ ok: false, message: 'Błąd usuwania' });
  }
});

/**
 * POST /api/seo/admin/local/run-pseo-cron
 *  Ręczne uruchomienie crona budowy brakujących stron PSEO (admin).
 */
router.post('/admin/local/run-pseo-cron', async (req, res) => {
  try {
    if (!ensureMongoConnected(res)) return;
    const { runPseoBulkCron } = require('../cron/pseoBulkCron');
    const maxBuild = Math.min(30, Math.max(1, parseInt(req.body?.maxBuild, 10) || 8));
    const out = await runPseoBulkCron({ force: true, maxBuild });
    res.json(out);
  } catch (err) {
    logger.error?.('[SEO] run-pseo-cron error:', err);
    res.status(500).json({ ok: false, message: err.message || 'Błąd crona PSEO' });
  }
});

module.exports = router;
module.exports.sitemapHandler = sitemapHandler;
module.exports.robotsHandler = robotsHandler;
module.exports.prerenderHandler = prerenderHandler;
