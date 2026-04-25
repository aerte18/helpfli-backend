// backend/utils/concierge.js - AI Concierge utilities
const Order = require('../models/Order');
const AIFeedback = require('../models/AIFeedback');

// Załaduj mnożniki cenowe dla miast
let CITY_PRICING_MULTIPLIERS = null;
function loadCityPricingMultipliers() {
  if (CITY_PRICING_MULTIPLIERS) return CITY_PRICING_MULTIPLIERS;
  try {
    CITY_PRICING_MULTIPLIERS = require('../data/city_pricing_multipliers.json');
    return CITY_PRICING_MULTIPLIERS;
  } catch (error) {
    console.warn('Failed to load city pricing multipliers:', error.message);
    return { cities: {}, tiers: {}, default: { multiplier: 1.0 } };
  }
}

// Funkcja do określenia mnożnika cenowego dla miasta
function getCityPricingMultiplier(locationText = '') {
  const multipliers = loadCityPricingMultipliers();
  if (!locationText) return multipliers.default;
  
  const locationLower = locationText.toLowerCase();
  
  // Sprawdź czy to konkretne miasto
  for (const [cityKey, cityData] of Object.entries(multipliers.cities || {})) {
    if (locationLower.includes(cityKey)) {
      return {
        city: cityData.name,
        multiplier: cityData.multiplier,
        description: cityData.description,
        tier: cityData.tier
      };
    }
  }
  
  // Jeśli nie znaleziono konkretnego miasta, użyj domyślnego
  return multipliers.default;
}

// helpers językowych
function t(lang, pl, en) {
  return lang === 'en' ? en : pl;
}

// 1) Kroki + flagi bezpieczeństwa + części
function deriveSelfHelpSteps(description = '', lang = 'pl') {
  const L = lang || 'pl';
  const steps = [];
  const flags = [];

  const s = description.toLowerCase();

  if (/(gniazd|prąd|iskr|bezpiecznik|zwarc)/.test(s)) {
    flags.push('electricity');
    steps.push({ text: t(L, 'Wyłącz główne zasilanie / bezpiecznik obwodu.', 'Turn off main power / circuit breaker.'), done: false });
    steps.push({ text: t(L, 'Sprawdź, czy element nie jest gorący/okopcony.', 'Check if the element is hot/sooty.'), done: false });
  }
  if (/(gaz|zapach gazu|ulatuj)/.test(s)) {
    flags.push('gas');
    steps.push({ text: t(L, 'Zakręć kurek gazu i wywietrz pomieszczenie.', 'Shut off gas valve and ventilate the room.'), done: false });
    steps.push({ text: t(L, 'Nie używaj iskrzących urządzeń / przełączników.', 'Do not use sparking devices/switches.'), done: false });
  }
  if (/(ciekn|zlew|kran|kapie|uszcz)/.test(s)) {
    steps.push({ text: t(L, 'Zakręć zawór wody pod zlewem.', 'Close the under-sink water valve.'), done: false });
    steps.push({ text: t(L, 'Dokręć głowicę baterii i sprawdź kapanie.', 'Tighten the faucet head and check dripping.'), done: false });
    steps.push({ text: t(L, 'Zrób 2–3 zdjęcia miejsca wycieku (zbliżenie i szerzej).', 'Take 2–3 photos of the leak (close & wide).'), done: false });
  }
  if (/(elektryk|instalacj|kabel)/.test(s)) {
    steps.push({ text: t(L, 'Sprawdź czy wszystkie gniazdka działają poprawnie.', 'Check if all sockets work properly.'), done: false });
    steps.push({ text: t(L, 'Zwróć uwagę na iskrzenie lub nietypowe dźwięki.', 'Pay attention to sparking or unusual sounds.'), done: false });
  }
  if (/(sprzątani|czyszczen|porządk)/.test(s)) {
    steps.push({ text: t(L, 'Zbierz podstawowe środki czyszczące.', 'Gather basic cleaning supplies.'), done: false });
    steps.push({ text: t(L, 'Zacznij od najbardziej zanieczyszczonych obszarów.', 'Start with the most contaminated areas.'), done: false });
  }

  return { steps, flags };
}

// Załaduj katalog części zamiennych
let PARTS_CATALOG = null;
function loadPartsCatalog() {
  if (PARTS_CATALOG) return PARTS_CATALOG;
  try {
    PARTS_CATALOG = require('../data/parts_catalog.json');
    return PARTS_CATALOG;
  } catch (error) {
    console.warn('Failed to load parts catalog:', error.message);
    return [];
  }
}

function suggestParts(description = '', lang = 'pl', category = null) {
  const L = lang || 'pl';
  const out = [];
  const s = description.toLowerCase();
  
  // Załaduj katalog części
  const catalog = loadPartsCatalog();
  
  // Określ kategorię jeśli nie podana
  let detectedCategory = category;
  if (!detectedCategory) {
    if (/(kran|bateria|woda|cieknie|wyciek|kanalizacja|hydraulik)/.test(s)) {
      detectedCategory = 'hydraulika';
    } else if (/(prąd|elektryk|gniazd|włącznik|oświetlenie|bezpiecznik)/.test(s)) {
      detectedCategory = 'elektryka';
    } else if (/(komputer|laptop|drukarka|sieć|wifi|it|informatyk)/.test(s)) {
      detectedCategory = 'it';
    } else if (/(remont|malowanie|tapetowanie|płytki|gładź)/.test(s)) {
      detectedCategory = 'remont';
    } else if (/(sprzątani|czyszczen)/.test(s)) {
      detectedCategory = 'inne';
    }
  }
  
  // Znajdź części z katalogu dla danej kategorii
  if (detectedCategory && catalog) {
    const categoryData = catalog.find(cat => cat.category === detectedCategory);
    if (categoryData && categoryData.parts) {
      // Zwróć top 3-5 najbardziej prawdopodobnych części
      const relevantParts = categoryData.parts.slice(0, 5).map(part => ({
        name: part.name,
        type: part.type,
        specification: part.specification,
        qty: 1,
        approxPrice: part.typicalPrice?.min || 10,
        maxPrice: part.typicalPrice?.max || 50,
        unit: 'PLN',
        availability: part.availability,
        commonBrands: part.commonBrands || []
      }));
      return relevantParts;
    }
  }
  
  // Fallback do podstawowych części (dla kompatybilności wstecznej)
  if (/(kran|bateria)/.test(s)) {
    out.push({ name: t(L,'Uszczelka 3/8"', '3/8" gasket'), qty: 1, approxPrice: 10, unit: 'PLN' });
    out.push({ name: t(L,'Taśma teflonowa', 'PTFE tape'), qty: 1, approxPrice: 6, unit: 'PLN' });
  }
  if (/(elektryk|gniazd|przewód)/.test(s)) {
    out.push({ name: t(L,'Taśma izolacyjna', 'Insulating tape'), qty: 1, approxPrice: 8, unit: 'PLN' });
    out.push({ name: t(L,'Bezpieczniki różne', 'Various fuses'), qty: 5, approxPrice: 15, unit: 'PLN' });
  }
  if (/(sprzątani|czyszczen)/.test(s)) {
    out.push({ name: t(L,'Środek czyszczący uniwersalny', 'Universal cleaner'), qty: 1, approxPrice: 12, unit: 'PLN' });
    out.push({ name: t(L,'Gąbki i ścierki', 'Sponges and cloths'), qty: 1, approxPrice: 8, unit: 'PLN' });
  }

  return out;
}

// Funkcja do wyszukiwania części po nazwie lub typie
function findPartsByNameOrType(searchTerm = '', category = null) {
  const catalog = loadPartsCatalog();
  if (!catalog || !searchTerm) return [];
  
  const term = searchTerm.toLowerCase();
  const results = [];
  
  catalog.forEach(cat => {
    if (category && cat.category !== category) return;
    
    cat.parts.forEach(part => {
      const partName = part.name.toLowerCase();
      const partType = part.type.toLowerCase();
      const partSpec = (part.specification || '').toLowerCase();
      
      if (partName.includes(term) || partType.includes(term) || partSpec.includes(term)) {
        results.push({
          ...part,
          category: cat.category
        });
      }
    });
  });
  
  return results.slice(0, 10); // Zwróć max 10 wyników
}

// 2) Re-analyze draft (po zmianach/załącznikach)
async function reAnalyzeDraft(draft) {
  try {
    const { analyzeWithOllama } = require('../services/llm_local');
    
    // 1) Najpierw spróbuj lokalny LLM (Ollama)
    let llm = null;
    try {
      const imgs = (draft.attachments || []).filter(a => /^image\//.test(a.type)).map(a => a.url);
      llm = await analyzeWithOllama({
        description: draft.description || '',
        imageUrls: imgs,
        lang: draft.language || 'pl'
      });
    } catch (error) {
      console.log('Ollama not available, using fallback:', error.message);
    }

    // 2) Service + priceHints + providers (Twoja logika)
    const Service = require('../models/Service');
    const services = await Service.find({ enabled: true }).lean().catch(() => []);
    const best = pickBestService ? pickBestService(services, draft.description) : draft.serviceCandidate;

    const priceHints = await computePriceHints(best?.code, draft.location).catch(() => draft.priceHints || null);
    const rec = await recommendProviders(best?.code || llm?.serviceCandidate?.code, draft.location?.lat, draft.location?.lon, 3)
                .catch(() => draft.recommendedProviders || []);

    const steps = (llm?.diySteps || []).map(t => ({ text: t, done: false }));
    const flags = llm?.dangerFlags || [];
    const parts = llm?.parts || suggestParts(draft.description || '', draft.language || 'pl');

    draft.serviceCandidate = llm?.serviceCandidate || best || draft.serviceCandidate;
    draft.priceHints = priceHints || draft.priceHints;
    draft.recommendedProviders = rec || draft.recommendedProviders;
    draft.diySteps = steps.length ? steps : draft.diySteps;
    draft.dangerFlags = flags.length ? flags : draft.dangerFlags;
    draft.parts = parts.length ? parts : draft.parts;
    await draft.save();
    return draft;
  } catch (error) {
    console.error('Re-analyze draft error:', error);
    return draft;
  }
}

// 3) Prosta funkcja wyboru serwisu
function pickBestService(services, description = '') {
  const s = description.toLowerCase();
  
  if (/(ciekn|zlew|kran|kapie|uszcz|hydraul)/.test(s)) return { code: 'hydraulik', name: 'Hydraulik' };
  if (/(prąd|elektryk|gniazd|iskr|bezpiecznik|zwarc)/.test(s)) return { code: 'elektryk', name: 'Elektryk' };
  if (/(sprzątani|czyszczen|porządk)/.test(s)) return { code: 'sprzatanie', name: 'Sprzątanie' };
  if (/(agd|rtv|pralk|zmywark|lodówk|lodowk|kuchenk|piekarnik|okap|telewizor|\btv\b)/.test(s)) return { code: 'agd-rtv-naprawa-agd', name: 'Naprawa AGD' };
  
  return services[0] || { code: 'inne', name: 'Inne' };
}

// 4) Dynamiczna funkcja wyliczania widełek cenowych (pora dnia, lokalizacja, popyt)
async function computePriceHints(serviceCode, location = {}) {
  const basePrices = {
    'hydraulik': { basic: { min: 80, max: 150 }, standard: { min: 120, max: 250 }, pro: { min: 200, max: 400 } },
    'elektryk': { basic: { min: 100, max: 200 }, standard: { min: 150, max: 300 }, pro: { min: 250, max: 500 } },
    'sprzatanie': { basic: { min: 50, max: 100 }, standard: { min: 80, max: 150 }, pro: { min: 120, max: 250 } },
    'agd': { basic: { min: 80, max: 150 }, standard: { min: 120, max: 250 }, pro: { min: 200, max: 400 } },
    'agd-rtv': { basic: { min: 120, max: 220 }, standard: { min: 180, max: 350 }, pro: { min: 300, max: 600 } },
    'agd-rtv-naprawa-agd': { basic: { min: 150, max: 250 }, standard: { min: 220, max: 400 }, pro: { min: 400, max: 700 } },
    'agd-rtv-naprawa-rtv': { basic: { min: 120, max: 220 }, standard: { min: 180, max: 350 }, pro: { min: 300, max: 600 } },
    'inne': { basic: { min: 60, max: 120 }, standard: { min: 100, max: 200 }, pro: { min: 150, max: 350 } }
  };
  
  const base = basePrices[serviceCode] || basePrices['inne'];
  
  // 1) Mnożnik pory dnia
  const now = new Date();
  const hour = now.getHours();
  let timeMultiplier = 1.0;
  
  // Wieczór (18-22) i noc (22-6) = wyższe ceny
  if (hour >= 22 || hour < 6) {
    timeMultiplier = 1.3; // +30% w nocy
  } else if (hour >= 18 && hour < 22) {
    timeMultiplier = 1.15; // +15% wieczorem
  } else if (hour >= 6 && hour < 9) {
    timeMultiplier = 1.1; // +10% rano
  }
  
  // Weekend = wyższe ceny
  const dayOfWeek = now.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    timeMultiplier *= 1.1; // +10% w weekend
  }
  
  // 2) Mnożnik lokalizacji (duże miasta = wyższe ceny)
  let locationMultiplier = 1.0;
  const cityText = (location.text || '').toLowerCase();
  const majorCities = ['warszawa', 'kraków', 'wrocław', 'poznań', 'gdańsk', 'łódź', 'katowice', 'lublin'];
  const isMajorCity = majorCities.some(city => cityText.includes(city));
  
  if (isMajorCity) {
    locationMultiplier = 1.2; // +20% w dużych miastach
  }
  
  // 3) Mnożnik popytu (liczba aktywnych zleceń w okolicy)
  let demandMultiplier = 1.0;
  try {
    const Order = require('../models/Order');
    const last24h = new Date(Date.now() - 24*60*60*1000);
    
    // Liczba aktywnych zleceń w ostatnich 24h w okolicy (jeśli mamy współrzędne)
    if (location.lat && location.lon) {
      // Proste przybliżenie: zlecenia w promieniu ~10km
      const activeOrders = await Order.countDocuments({
        status: { $in: ['open', 'matched', 'in_progress'] },
        createdAt: { $gte: last24h },
        locationLat: { $gte: location.lat - 0.1, $lte: location.lat + 0.1 },
        locationLon: { $gte: location.lon - 0.1, $lte: location.lon + 0.1 }
      });
      
      // Wysoki popyt (>10 zleceń) = +15%, średni (5-10) = +5%
      if (activeOrders > 10) {
        demandMultiplier = 1.15;
      } else if (activeOrders > 5) {
        demandMultiplier = 1.05;
      }
    }
  } catch (error) {
    console.error('Error computing demand multiplier:', error);
    // Ignoruj błąd, użyj domyślnego mnożnika
  }
  
  // Zastosuj mnożniki
  const finalMultiplier = timeMultiplier * locationMultiplier * demandMultiplier;
  
  const adjustPrice = (price) => Math.round(price * finalMultiplier);
  
  return {
    basic: {
      min: adjustPrice(base.basic.min),
      max: adjustPrice(base.basic.max)
    },
    standard: {
      min: adjustPrice(base.standard.min),
      max: adjustPrice(base.standard.max)
    },
    pro: {
      min: adjustPrice(base.pro.min),
      max: adjustPrice(base.pro.max)
    },
    // Dodatkowe informacje dla frontendu
    multipliers: {
      time: timeMultiplier,
      location: locationMultiplier,
      demand: demandMultiplier,
      total: finalMultiplier
    },
    factors: {
      timeOfDay: hour >= 22 || hour < 6 ? 'night' : hour >= 18 ? 'evening' : hour < 9 ? 'morning' : 'day',
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      isMajorCity,
      demandLevel: demandMultiplier > 1.1 ? 'high' : demandMultiplier > 1.0 ? 'medium' : 'low'
    }
  };
}

// 5) Ranking providerów 0–100: skuteczność, %system, ocena, odległość, tier, dostępność, promocje
async function recommendProviders(serviceCode, lat, lon, limit = 3, urgency = 'normal') {
  try {
    const User = require('../models/User');
    const Order = require('../models/Order');
    const Service = require('../models/Service');
    const Rating = require('../models/Rating');

    // Mapowanie kodu usługi na ObjectId
    let serviceId = null;
    if (serviceCode) {
      const service = await Service.findOne({ 
        $or: [
          { code: serviceCode },
          { name: { $regex: serviceCode, $options: 'i' } }
        ]
      });
      serviceId = service?._id;
    }

    // surowa lista providerów kandydatów (po usłudze)
    const query = { role: 'provider' };
    if (serviceId) {
      query.services = serviceId;
    }
    
    // Dla pilnych zleceń preferuj dostępnych teraz
    if (urgency === 'today' || urgency === 'now') {
      query['provider_status.isOnline'] = true;
    }
    
    const base = await User.find(query)
      .select('_id name level providerTier provider_status verified badges rankingPoints locationLat locationLon services avatar').lean();

    // Pobierz oceny dla wszystkich providerów
    const providerIds = base.map(p => p._id);
    const ratings = await Rating.find({ to: { $in: providerIds } });
    const ratingMap = new Map();
    ratings.forEach(r => {
      const pid = String(r.to);
      if (!ratingMap.has(pid)) {
        ratingMap.set(pid, []);
      }
      ratingMap.get(pid).push(r.rating);
    });

    // policz metryki z Orders (ostatnie 180 dni)
    const since = new Date(Date.now() - 180*24*60*60*1000);
    const matchStage = { createdAt: { $gte: since } };
    if (serviceId) {
      matchStage.service = serviceId;
    }
    const orderStats = await Order.aggregate([
      { $match: matchStage },
      { $group: {
          _id: '$provider',
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status','completed'] }, 1, 0] } },
          systemPaid: { $sum: { $cond: [{ $eq: ['$paidInSystem', true] }, 1, 0] } }, // eslint-disable-line
        }
      }
    ]);

    const statMap = new Map(orderStats.map(s => [String(s._id), s]));

    function distKm(aLat, aLon, bLat, bLon) {
      if ([aLat,aLon,bLat,bLon].some(v => typeof v !== 'number')) return null;
      const R = 6371, dLat = (bLat-aLat)*Math.PI/180, dLon = (bLon-aLon)*Math.PI/180;
      const x = Math.sin(dLat/2)**2 + Math.cos(aLat*Math.PI/180)*Math.cos(bLat*Math.PI/180)*Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(x));
    }

    const scored = base.map(p => {
      const st = statMap.get(String(p._id));
      const rate = st?.total ? (st.completed / st.total) : 0.5;          // skuteczność realizacji (default 50% jeśli brak danych)
      const sys = st?.total ? (st.systemPaid / st.total) : 0.3;          // % w systemie (default 30%)
      
      // Średnia ocena
      const providerRatings = ratingMap.get(String(p._id)) || [];
      const rating = providerRatings.length > 0 
        ? providerRatings.reduce((a, b) => a + b, 0) / providerRatings.length 
        : 4.0; // default 4.0 jeśli brak ocen
      
      // Odległość
      const dk = (lat && lon && p.locationLat && p.locationLon) 
        ? distKm(lat, lon, p.locationLat, p.locationLon) 
        : null;
      const distScore = dk == null ? 0.6 : Math.max(0, 1 - Math.min(dk/30, 1)); // 1 przy 0 km, 0 przy 30+ km

      // Dostępność (online teraz)
      const availability = p.provider_status?.isOnline === true ? 1.0 : 0.3;
      
      // Tier boost (PRO > Standard > Basic)
      const tierBoost = p.providerTier === 'pro' ? 0.15 : 
                       p.providerTier === 'standard' ? 0.08 : 0;
      
      // Verified boost
      const verifiedBoost = p.verified ? 0.05 : 0;
      
      // Promocje boost (jeśli ma aktywną promocję)
      const now = new Date();
      const hasActivePromo = (p.badges?.highlightUntil && new Date(p.badges.highlightUntil) > now) ||
                            (p.badges?.topUntil && new Date(p.badges.topUntil) > now);
      const promoBoost = hasActivePromo ? 0.05 : 0;

      // Wagi (dostosowane do nowych czynników)
      const baseScore = (
        rate * 0.25 +           // skuteczność (25%)
        sys  * 0.15 +           // % system (15%)
        (rating/5) * 0.20 +     // ocena (20%)
        distScore * 0.15 +      // odległość (15%)
        availability * 0.10     // dostępność (10%)
      );
      
      const finalScore = (baseScore + tierBoost + verifiedBoost + promoBoost) * 100;

      return { 
        _id: p._id,
        id: p._id,
        name: p.name,
        avatar: p.avatar,
        level: p.level,
        providerTier: p.providerTier,
        verified: p.verified,
        rating: Math.round(rating * 10) / 10,
        ratingCount: providerRatings.length,
        distanceKm: dk ? Math.round(dk * 10) / 10 : null,
        isOnline: p.provider_status?.isOnline === true,
        hasActivePromo,
        score: Math.round(finalScore),
        // Dodatkowe metryki dla UI
        successRate: Math.round(rate * 100),
        systemUsage: Math.round(sys * 100),
        completedOrders: st?.completed || 0,
        totalOrders: st?.total || 0
      };
    });

    return scored.sort((a,b) => b.score - a.score).slice(0, limit);
  } catch (error) {
    console.error('Recommend providers error:', error);
    return [];
  }
}

// 6) Funkcja scoringu serwisów
function scoreServiceMatch(description = '', service) {
  const s = description.toLowerCase();
  const serviceName = (service.name || '').toLowerCase();
  const serviceCode = (service.code || '').toLowerCase();
  
  let score = 0;
  
  // Hydraulik
  if (/(ciekn|zlew|kran|kapie|uszcz|hydraul|wod)/.test(s)) {
    if (serviceName.includes('hydraul') || serviceCode.includes('hydraul')) score += 100;
  }
  
  // Elektryk
  if (/(prąd|elektryk|gniazd|iskr|bezpiecznik|zwarc|instalacj|kabel)/.test(s)) {
    if (serviceName.includes('elektr') || serviceCode.includes('elektr')) score += 100;
  }
  
  // Sprzątanie
  if (/(sprzątani|czyszczen|porządk|myc)/.test(s)) {
    if (serviceName.includes('sprząt') || serviceCode.includes('sprząt')) score += 100;
  }
  
  // AGD
  if (/(agd|pralk|lodówk|kuchenk|piekarn|zmyw)/.test(s)) {
    if (serviceName.includes('agd') || serviceCode.includes('agd')) score += 100;
  }
  
  // Złota rączka
  if (/(montaż|montow|meble|ram|obraz|półk)/.test(s)) {
    if (serviceName.includes('złot') || serviceCode.includes('złot')) score += 80;
  }
  
  // Inne
  if (/(inne|inne|ogólne|uniwersal)/.test(s)) {
    if (serviceName.includes('inne') || serviceCode.includes('inne')) score += 60;
  }
  
  return score;
}

/**
 * Podobne zakończone zlecenia (kontekst dla AI) — uproszczona heurystyka.
 */
async function findSimilarOrders(description, serviceCode, locationText, limit = 5) {
  try {
    if (!description) return [];
    const q = { status: 'completed' };
    if (serviceCode) q.service = serviceCode;
    const orders = await Order.find(q)
      .sort({ completedAt: -1 })
      .limit(Math.min(Number(limit) || 5, 20))
      .select('service description amountTotal completedAt')
      .lean();
    return (orders || []).map((o) => ({
      id: o._id,
      service: o.service,
      description: (o.description || '').slice(0, 400),
      amountTotal: o.amountTotal
    }));
  } catch (e) {
    console.warn('findSimilarOrders:', e.message);
    return [];
  }
}

/**
 * Feedback oznaczony jako „zadziałało” (dla kontekstu LLM).
 */
async function findSuccessfulFeedback(description, serviceCode, locationText, limit = 3) {
  try {
    const q = { 'feedback.worked': true };
    if (serviceCode) q.serviceCode = serviceCode;
    const list = await AIFeedback.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 3, 20))
      .lean();
    return list || [];
  } catch (e) {
    console.warn('findSuccessfulFeedback:', e.message);
    return [];
  }
}

module.exports = {
  deriveSelfHelpSteps,
  suggestParts,
  findPartsByNameOrType,
  reAnalyzeDraft,
  recommendProviders,
  pickBestService,
  computePriceHints,
  findSimilarOrders,
  findSuccessfulFeedback,
  scoreServiceMatch,
  getCityPricingMultiplier
};