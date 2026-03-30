// backend/routes/services.js
const express = require('express');
const router = express.Router();
const Service = require('../models/Service');
const path = require('path');
const TOP_SERVICE_SLUGS = require('../constants/topServiceSlugs');

// Static fallback (serverless/no-DB mode)
let STATIC_CATALOG = [];
try {
  // Static catalog with basic fields: slug, parent_slug, name_pl, name_en, name, service_kind, is_top, urgency_level, seasonal
  // Repo can store it either at backend/services_catalog.json or backend/data/services_catalog.json.
  const candidates = [
    path.join(__dirname, '..', 'services_catalog.json'),
    path.join(__dirname, '..', 'data', 'services_catalog.json'),
    path.join(__dirname, '..', '..', 'services_catalog.json'), // legacy root-level location
  ];
  let loaded = null;
  for (const p of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const data = require(p);
      if (Array.isArray(data) && data.length > 0) {
        loaded = data;
        break;
      }
    } catch (_) {
      // ignore and try next candidate
    }
  }
  STATIC_CATALOG = loaded || [];
} catch (_) {
  STATIC_CATALOG = [];
}

// --- Normalizacja slugów (underscores -> hyphens, prefiks kategorii) ---
function normalizeSlug(item) {
  const parent = String(item.parent_slug || '').toLowerCase().trim();
  let s = String(item.slug || '').toLowerCase().trim();
  if (!s) return s;
  // zamień underscores na hypheny
  s = s.replace(/_/g, '-');
  // dopnij prefiks kategorii, jeśli go brakuje
  if (parent && !s.startsWith(parent + '-')) {
    s = `${parent}-${s}`;
  }
  return s;
}

function normalizeItems(items) {
  return (items || []).map(it => ({ ...it, slug: normalizeSlug(it) }));
}

function normalizeSlugText(v = '') {
  return String(v).trim().toLowerCase().replace(/_/g, '-');
}

function filterStaticServices({ parent_slug, is_top, kind, seasonal, q, slug, limit = 50, skip = 0 }) {
  let items = STATIC_CATALOG || [];
  if (parent_slug) items = items.filter(s => String(s.parent_slug || '').toLowerCase() === String(parent_slug).toLowerCase());
  if (kind) items = items.filter(s => String(s.service_kind || '').toLowerCase() === String(kind).toLowerCase());
  if (seasonal && seasonal !== 'auto') items = items.filter(s => String(s.seasonal || '').toLowerCase() === String(seasonal).toLowerCase());
  if (is_top) items = items.filter(s => s.is_top === true || s.is_top === 1 || s.is_top === '1');
  if (slug) items = items.filter(s => String(s.slug || '').toLowerCase() === String(slug).toLowerCase());
  if (q) {
    const rx = new RegExp(String(q).trim().replace(/\s+/g, '.*'), 'i');
    items = items.filter(s => rx.test(s.name_pl || '') || rx.test(s.name_en || '') || rx.test(s.name || '') || rx.test(s.description || '') || rx.test(s.tags || ''));
  }
  const start = Number(skip) || 0;
  const end = start + Math.min(Number(limit) || 50, 100);
  let sliced = items.slice(start, end);

  // Statyczny fallback top usług, gdy oznaczeń is_top jest za mało.
  if (
    is_top &&
    !parent_slug &&
    !kind &&
    !q &&
    !slug &&
    (!seasonal || seasonal === 'auto') &&
    sliced.length < Math.min(Number(limit) || 50, 8)
  ) {
    const have = new Set(sliced.map((s) => normalizeSlugText(s.slug)));
    const fromPopular = (STATIC_CATALOG || []).filter((s) =>
      TOP_SERVICE_SLUGS.map(normalizeSlugText).includes(normalizeSlugText(s.slug))
    );
    for (const candidate of fromPopular) {
      const n = normalizeSlugText(candidate.slug);
      if (have.has(n)) continue;
      sliced.push(candidate);
      have.add(n);
      if (sliced.length >= Math.min(Number(limit) || 50, 8)) break;
    }
  }

  const normalized = normalizeItems(sliced);
  return {
    items: normalized,
    total: items.length,
    hasMore: end < items.length
  };
}

// GET /api/services?parent=hydraulika&is_top=1&kind=remote&seasonal=summer&q=kran&limit=12
router.get('/', async (req, res) => {
  try {
    const {
      parent: parent_slug,
      is_top,
      kind,            // 'onsite' | 'remote'
      seasonal,        // 'winter'|'spring'|'summer'|'autumn'|'none'
      q,
      slug,            // wyszukiwanie po konkretnym slug
      limit = 50,
      skip = 0,
    } = req.query;

    const filter = {};
    
    // Filtry podstawowe
    if (parent_slug) filter.parent_slug = parent_slug;
    if (kind) filter.service_kind = kind;
    if (seasonal && seasonal !== 'auto') filter.seasonal = seasonal;
    if (is_top) {
      // is_top jest typu Number (default: 0), więc filtrujemy po wartości > 0
      filter.is_top = { $gt: 0 };
    }
    if (slug) filter.slug = slug;

    // Wyszukiwanie tekstowe
    if (q) {
      const rx = new RegExp(q.trim().replace(/\s+/g, '.*'), 'i');
      filter.$or = [
        { name_pl: rx }, 
        { name_en: rx },
        { description: rx }, 
        { tags: rx }, 
        { intent_keywords: rx }
      ];
    }

    console.log('🔍 SERVICES_REQUEST:', { filter, limit, skip, is_top });

    // Jeśli is_top, upewnij się że sortujemy najpierw po is_top
    const sortOrder = is_top 
      ? { is_top: -1, urgency_level: -1, name_pl: 1, name: 1 }
      : { urgency_level: -1, is_top: -1, name_pl: 1, name: 1 };
    
    const MAX_LIMIT = 1000;
    const requestedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_LIMIT);
    
    const items = await Service.find(filter)
      .sort(sortOrder)
      .skip(+skip)
      .limit(requestedLimit)
      .lean();

    // Fallback dla sekcji "Popularne usługi":
    // gdy is_top=1 ma za mało rekordów, dopełnij z listy popularnych slugów.
    if (
      is_top &&
      !parent_slug &&
      !kind &&
      !q &&
      !slug &&
      (!seasonal || seasonal === 'auto')
    ) {
      const minWanted = Math.min(requestedLimit, 8);
      if (items.length < minWanted) {
        const existing = new Set(items.map((x) => normalizeSlugText(x.slug)));
        const candidateSlugs = TOP_SERVICE_SLUGS
          .map(normalizeSlugText)
          .filter((s) => !existing.has(s));
        if (candidateSlugs.length > 0) {
          const needed = minWanted - items.length;
          const topFallback = await Service.find({ slug: { $in: candidateSlugs } })
            .sort({ is_top: -1, urgency_level: -1, name_pl: 1, name: 1 })
            .limit(needed)
            .lean();
          items.push(...topFallback);
        }
      }
    }

    // Jeśli baza jest pusta (częste na świeżym deployu), użyj statycznego katalogu,
    // żeby onboarding i formularze zawsze miały listę usług.
    if (items.length === 0 && Array.isArray(STATIC_CATALOG) && STATIC_CATALOG.length > 0) {
      const data = filterStaticServices({
        parent_slug,
        is_top,
        kind,
        seasonal,
        q,
        slug,
        limit: requestedLimit,
        skip,
      });
      return res.json({ ...data, count: data.items.length });
    }

    console.log('🔍 SERVICES_RESULTS:', { 
      count: items.length, 
      is_top_filter: !!is_top,
      sample: items.slice(0, 3).map(s => ({ name: s.name_pl || s.name, is_top: s.is_top }))
    });

    res.json({
      items,
      total: items.length,
      count: items.length,
      hasMore: items.length >= requestedLimit
    });

  } catch (error) {
    console.warn('⚠️ SERVICES_ERROR (fallback to static catalog):', error?.message || error);
    // Fallback to static catalog so the UI can work without DB
    try {
      const data = filterStaticServices({
        parent_slug: req.query.parent,
        is_top: req.query.is_top,
        kind: req.query.kind,
        seasonal: req.query.seasonal,
        q: req.query.q,
        slug: req.query.slug,
        limit: req.query.limit,
        skip: req.query.skip
      });
      return res.json({ ...data, count: data.items.length });
    } catch (e2) {
      console.error('❌ SERVICES_FALLBACK_ERROR:', e2);
      // Zwróć przynajmniej pustą listę zamiast błędu 500
      return res.json({ items: [], total: 0, count: 0, hasMore: false });
    }
  }
});

// GET /api/services/categories - pobierz kategorie z podkategoriami
router.get('/categories', async (req, res) => {
  try {
    // Spróbuj załadować kategorie z pliku JSON (zawiera podkategorie)
    let categoriesData = [];
    try {
      categoriesData = require('../data/categories_pl.json');
      if (!Array.isArray(categoriesData)) {
        console.warn('categories_pl.json is not an array');
        categoriesData = [];
      }
    } catch (jsonError) {
      console.warn('Failed to load categories_pl.json:', jsonError.message);
    }
    
    // Jeśli mamy dane z JSON, zwróć je
    if (categoriesData.length > 0) {
      console.log('🔍 CATEGORIES_FROM_JSON:', { count: categoriesData.length });
      return res.json({ 
        success: true,
        items: categoriesData,
        categories: categoriesData,
        count: categoriesData.length
      });
    }
    
    // Fallback: pobierz z bazy danych (tylko parent_slug, bez podkategorii)
    const categories = await Service.distinct('parent_slug');
    const filtered = categories.filter(Boolean);
    
    console.log('🔍 CATEGORIES_FROM_DB:', { count: filtered.length, categories: filtered.slice(0, 5) });
    
    if (filtered.length > 0) {
      // Zwróć w formacie zgodnym z ServiceCategoryDropdown (bez podkategorii)
      const formatted = filtered.map(cat => ({
        id: cat,
        slug: cat,
        name: cat,
        parent_slug: cat,
        subcategories: [] // Pusta lista podkategorii
      }));
      return res.json({ 
        success: true,
        items: formatted,
        categories: formatted,
        count: filtered.length
      });
    }
    
    // Jeśli wszystko zawiodło, użyj statycznego katalogu
    console.warn('⚠️ CATEGORIES_ALL_FAILED - using static catalog');
    throw new Error('No categories available');
  } catch (error) {
    console.error('❌ CATEGORIES_ERROR:', error);
    // Fallback do statycznego katalogu
    try {
      const staticCategories = [...new Set((STATIC_CATALOG || []).map(s => s.parent_slug).filter(Boolean))];
      const formatted = staticCategories.map(cat => ({
        id: cat,
        slug: cat,
        name: cat,
        parent_slug: cat,
        subcategories: []
      }));
      return res.json({ 
        success: true,
        items: formatted,
        categories: formatted,
        count: staticCategories.length
      });
    } catch (e2) {
      console.error('❌ CATEGORIES_FALLBACK_ERROR:', e2);
      res.status(500).json({ 
        success: false,
        error: 'Błąd podczas pobierania kategorii',
        message: error.message || e2.message
      });
    }
  }
});

// --- AUTOSUGGEST: GET /api/services/suggest?q=...&limit=8
// WAŻNE: Musi być PRZED /:slug, żeby Express nie traktował 'suggest' jako slug
router.get('/suggest', async (req, res) => {
  try {
    const qRaw = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit || '8', 10), 20);
    const season = (req.query.seasonal || '').toString(); // 'winter'|'spring'|'summer'|'autumn'|''

    if (!qRaw) return res.json({ terms: [], services: [], subcategories: [] });

    const rx = new RegExp(qRaw.replace(/\s+/g, '.*'), 'i');
    const filter = {
      $or: [
        { name_pl: rx }, { name_en: rx },
        { description: rx }, { tags: rx }, { intent_keywords: rx }
      ]
    };
    if (season && season !== 'auto') filter.seasonal = season;

    // 1) Załaduj podkategorie z categories_pl.json
    let categoriesData = [];
    try {
      categoriesData = require('../data/categories_pl.json');
      if (!Array.isArray(categoriesData)) categoriesData = [];
    } catch (jsonError) {
      console.warn('Failed to load categories_pl.json for suggest:', jsonError.message);
    }

    // 2) Zbierz kandydatów (lekko nadmiarowo, żeby spokojnie policzyć scoring)
    const items = await Service.find(filter)
      .select('slug parent_slug name_pl name_en name intent_keywords is_top urgency_level seasonal service_kind')
      .limit(120)
      .lean();

    // 3) Wyciągnij keywords i policz score
    const q = qRaw.toLowerCase();
    const seen = new Map(); // term -> score
    const pushTerm = (term, baseScore = 0, s) => {
      const t = (term || '').toLowerCase().trim();
      if (!t || t.length < 2) return;
      let score = baseScore;
      if (t.startsWith(q)) score += 10;
      else if (t.includes(q)) score += 6;
      if (s?.is_top) score += 4;
      if (s?.urgency_level) score += Math.min(3, s.urgency_level);
      if (season && s?.seasonal === season) score += 2;
      score += (t.length <= 12 ? 1 : 0); // preferuj krótsze
      const prev = seen.get(t) || 0;
      if (score > prev) seen.set(t, score);
    };

    for (const s of items) {
      const kw = (s.intent_keywords || '').split(',').map(x => x.trim()).filter(Boolean);
      kw.forEach(k => pushTerm(k, 5, s));
      // dodaj także synonimy z name_pl/en/name (obsługa starych i nowych formatów)
      pushTerm(s.name_pl, 4, s);
      pushTerm(s.name_en, 3, s);
      pushTerm(s.name, 3, s); // stary format
    }

    // 4) Dodaj podkategorie do podpowiedzi
    const subcategories = [];
    for (const category of categoriesData) {
      if (!category.subcategories || !Array.isArray(category.subcategories)) continue;
      for (const subcat of category.subcategories) {
        const subcatName = subcat.name || '';
        if (rx.test(subcatName)) {
          const score = subcatName.toLowerCase().startsWith(q) ? 8 : 5;
          subcategories.push({
            id: subcat.id,
            name: subcatName,
            categoryId: category.id,
            categoryName: category.name,
            score
          });
        }
      }
    }
    // Sortuj podkategorie po score i weź top
    subcategories.sort((a, b) => b.score - a.score);
    const topSubcategories = subcategories.slice(0, Math.min(5, limit));

    const terms = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term, score]) => ({ term, score }));

    // 5) Zwróć również top usługi – do szybkich trafień
    const topServices = items
      .sort((a, b) => {
        const aScore = (a.is_top ? 5 : 0) + (a.urgency_level || 0) + (a.seasonal === season ? 2 : 0);
        const bScore = (b.is_top ? 5 : 0) + (b.urgency_level || 0) + (b.seasonal === season ? 2 : 0);
        return bScore - aScore;
      })
      .slice(0, Math.min(5, limit))
      .map(s => ({ slug: s.slug, name: s.name_pl || s.name_en || s.name, parent: s.parent_slug, kind: s.service_kind }));

    console.log('🔍 SUGGEST_REQUEST:', { q: qRaw, season, results: { terms: terms.length, services: topServices.length, subcategories: topSubcategories.length } });

    res.json({ terms, services: topServices, subcategories: topSubcategories });
  } catch (error) {
    console.error('❌ SUGGEST_ERROR:', error);
    res.status(500).json({ 
      error: 'Błąd podczas pobierania podpowiedzi',
      message: error.message 
    });
  }
});

// GET /api/services/:slug - pobierz konkretną usługę
// WAŻNE: Musi być NA KOŃCU, żeby nie przechwytywał innych route'ów (np. /suggest, /categories)
router.get('/:slug', async (req, res) => {
  try {
    const raw = String(req.params.slug || '').trim();
    const normalized = raw.toLowerCase().replace(/_/g, '-');
    const underscored = normalized.replace(/-/g, '_');
    const variants = [...new Set([raw, raw.toLowerCase(), normalized, underscored])].filter(Boolean);

    const service = await Service.findOne({ slug: { $in: variants } }).lean();
    
    if (!service) {
      return res.status(404).json({ 
        error: 'Usługa nie została znaleziona' 
      });
    }

    res.json(service);
  } catch (error) {
    console.error('❌ SERVICE_ERROR:', error);
    res.status(500).json({ 
      error: 'Błąd podczas pobierania usługi',
      message: error.message 
    });
  }
});

module.exports = router;