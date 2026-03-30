const express = require("express");
const User = require("../models/User");
const Rating = require("../models/Rating");
const Service = require("../models/Service");
const Verification = require("../models/Verification");
const ProviderSchedule = require("../models/ProviderSchedule");
const UserSubscription = require("../models/UserSubscription");
const { getPromoBoost } = require("../utils/promo");
const { computeScore } = require("../utils/rank");
const { computeProviderRankScore } = require("../utils/billingUtils");
const { fetchActiveCampaigns, capForUser, injectSponsored } = require("../utils/sponsor");
const { validateSearch } = require("../middleware/inputValidator");
const { calculateDistance, estimateETA } = require("../utils/geo");
const router = express.Router();

// Szukaj usługodawców po usłudze i lokalizacji
router.get("/", validateSearch, async (req, res) => {
  const { 
    service, 
    location, 
    lat,              // MVP: latitude for geo search
    lng,              // MVP: longitude for geo search
    radius = 50,      // MVP: search radius in km
    verifiedOnly, 
    q, 
    availableNow,
    level,           // basic|standard|pro
    minRating,       // minimalna ocena (0-5)
    available,        // now|today|tomorrow|offline
    budgetMin,       // minimalny budżet
    budgetMax,       // maksymalny budżet
    b2b,             // czy B2B
    paymentType,     // system|external|both – filtr metody płatności (dla klienta)
    sort = 'relevance' // MVP: sort=price|eta|rating
  } = req.query;

  console.log("🔍 SEARCH REQUEST:", { 
    service, location, verifiedOnly, q, availableNow, 
    level, minRating, available, budgetMin, budgetMax, b2b 
  });

  try {
    console.log("🔍 SEARCH: Starting search with match criteria...");
    const match = {
      role: "provider",
    };
    console.log("🔍 SEARCH: Initial match:", match);
    
    // MVP: Geo search (priorytet nad tekstowym location)
    const latNum = lat ? parseFloat(lat) : null;
    const lngNum = lng ? parseFloat(lng) : null;
    const radiusNum = radius ? parseFloat(radius) : 50;
    
    let searchLocation = null;
    if (latNum && lngNum) {
      // Geo search - użyj ProviderProfile jeśli dostępne
      try {
        const ProviderProfile = require('../models/ProviderProfile');
        // Geo search będzie wykonany po pobraniu providerów
        searchLocation = { lat: latNum, lng: lngNum, radius: radiusNum };
      } catch (profileError) {
        // Fallback: użyj locationCoords z User
        searchLocation = { lat: latNum, lng: lngNum, radius: radiusNum };
      }
    } else if (location) {
      // Tekstowe wyszukiwanie po lokalizacji
      match.location = { $regex: new RegExp(location, "i") };
    }

    // Wyszukiwanie tekstowe (q)
    const hasQ = q && q.trim();
    const hasLevel = level && level !== 'any';
    
    if (hasQ) {
      const searchRegex = new RegExp(q, "i");
      if (hasLevel) {
        // Jeśli mamy zarówno q jak i level, użyj $and
        match.$and = [
          { $or: [
            { name: searchRegex },
            { bio: searchRegex },
            { "kyc.companyName": searchRegex }
          ]},
          { $or: [
            { level: level },
            { providerTier: level }
          ]}
        ];
      } else {
        // Tylko q
        match.$or = [
          { name: searchRegex },
          { bio: searchRegex },
          { "kyc.companyName": searchRegex }
        ];
      }
    } else if (hasLevel) {
      // Tylko level/providerTier
      match.$or = [
        { level: level },
        { providerTier: level }
      ];
    }

    // Filtr "Tylko Verified"
    const verifiedOnlyFilter = String(verifiedOnly || "").toLowerCase() === "true";
    if (verifiedOnlyFilter) {
      match.badges = { $in: ["verified"] };
    }
    
    // MVP: Filtr "Dostępny teraz" - użyj ProviderProfile jeśli dostępne
    if (availableNow === 'true') {
      // Najpierw spróbuj użyć ProviderProfile
      try {
        const ProviderProfile = require('../models/ProviderProfile');
        // Jeśli ProviderProfile istnieje, użyj go do filtrowania
        // W przeciwnym razie użyj podstawowego isOnline
        match["provider_status.isOnline"] = true;
      } catch (profileError) {
        // Fallback do podstawowego isOnline
        match["provider_status.isOnline"] = true;
      }
    } else if (available && available !== 'any') {
      // Filtr dostępności (now/today/tomorrow/offline)
      if (available === 'now') {
        match["provider_status.isOnline"] = true;
      } else if (available === 'offline') {
        match["provider_status.isOnline"] = false;
      }
      // "today" i "tomorrow" - sprawdź harmonogram (będzie zastosowane po pobraniu providerów)
    }

    // Filtr B2B
    if (b2b === 'true' || b2b === true) {
      match.b2b = true;
    }

    // Filtr metody płatności (klient szuka wykonawców akceptujących dany typ)
    // system = wykonawcy akceptujący Helpfli (providerPaymentPreference: system lub both)
    // external = wykonawcy akceptujący płatność poza systemem (external lub both)
    // both = tylko wykonawcy akceptujący oba typy (providerPaymentPreference === 'both')
    if (paymentType === 'system') {
      match.$or = [
        { providerPaymentPreference: 'system' },
        { providerPaymentPreference: 'both' },
        { providerPaymentPreference: { $exists: false } }
      ];
    } else if (paymentType === 'external') {
      match.$or = [
        { providerPaymentPreference: 'external' },
        { providerPaymentPreference: 'both' },
        { providerPaymentPreference: { $exists: false } }
      ];
    } else if (paymentType === 'both') {
      match.providerPaymentPreference = 'both';
    }

    // Filtry budżetu (będą zastosowane po pobraniu providerów, bo cena jest w polu price)
    const budgetMinNum = budgetMin ? parseFloat(budgetMin) : null;
    const budgetMaxNum = budgetMax ? parseFloat(budgetMax) : null;
    if (budgetMinNum || budgetMaxNum) {
      match.price = {};
      if (budgetMinNum) match.price.$gte = budgetMinNum;
      if (budgetMaxNum) match.price.$lte = budgetMaxNum;
    }
    
    // Obsługa wielu usług (service="id1,id2,id3" lub category="hydraulika,elektryka")
    if (service) {
      const serviceList = String(service).split(",").filter(Boolean);
      
      // Sprawdź czy to są ID usług czy nazwy kategorii
      const isServiceId = serviceList[0].length === 24; // ObjectId ma 24 znaki
      
      if (isServiceId) {
        // Tradycyjne wyszukiwanie po ID usług
        if (serviceList.length === 1) {
          match.services = serviceList[0];
        } else {
          match.services = { $in: serviceList };
        }
      } else {
        // Wyszukiwanie po kategoriach lub konkretnych slugach usług
        console.log("🔍 SEARCH: Looking for services with parent_slug/slug:", serviceList);
        const categoryServices = await Service.find({ 
          $or: [
            { parent_slug: { $in: serviceList } },
            { slug: { $in: serviceList } }
          ]
        }).select('_id parent_slug name_pl');
        
        console.log("🔍 SEARCH: Found", categoryServices.length, "services with matching parent_slug");
        if (categoryServices.length > 0) {
          console.log("🔍 SEARCH: Sample services:", categoryServices.slice(0, 3).map(s => ({ id: s._id, parent_slug: s.parent_slug, name: s.name_pl })));
        }
        
        const serviceIds = categoryServices.map(s => s._id);
        if (serviceIds.length > 0) {
          match.services = { $in: serviceIds };
          console.log("🔍 SEARCH: Filtering providers by service IDs:", serviceIds.length, "services");
        } else {
          console.warn("⚠️ SEARCH: No services found for parent_slug:", serviceList);
        }
      }
    }

    const { getDemoUserIds } = require('../utils/demoAccounts');
    if (process.env.HIDE_DEMO_DATA !== '0') {
      const demoIds = await getDemoUserIds();
      if (demoIds.length) match._id = { $nin: demoIds };
    }
    
    let providers = await User.find(match)
      .select("name level location locationCoords price time services provider_status promo badges kyc rankingPoints providerTier isTopProvider hasHelpfliGuarantee b2b company")
      .lean();
    
    // Populate company tylko jeśli pole company istnieje i nie jest null
    // Zrób to ręcznie, aby uniknąć błędów jeśli model Company nie istnieje
    try {
      if (providers.some(p => p.company)) {
        const Company = require('../models/Company');
        const companyIds = [...new Set(providers.filter(p => p.company).map(p => String(p.company)))];
        if (companyIds.length > 0) {
          const companies = await Company.find({ _id: { $in: companyIds } })
            .select('name logo')
            .lean();
          const companiesMap = new Map(companies.map(c => [String(c._id), c]));
          providers = providers.map(p => {
            if (p.company) {
              const company = companiesMap.get(String(p.company));
              if (company) {
                p.company = company;
              } else {
                p.company = null;
              }
            }
            return p;
          });
        }
      }
    } catch (error) {
      console.warn('⚠️ SEARCH: Error populating companies (non-fatal):', error?.message || error);
      // Nie rzucaj błędu - kontynuuj bez company data
      providers = providers.map(p => {
        if (p.company && typeof p.company === 'object') {
          // Jeśli już jest zpopulowane, zostaw
        } else {
          p.company = null;
        }
        return p;
      });
    }
    
    // MVP: Geo filtering jeśli podano lat/lng
    if (searchLocation) {
      try {
        const ProviderProfile = require('../models/ProviderProfile');
        // Pobierz ProviderProfile dla wszystkich providerów
        const providerIds = providers.map(p => p._id);
        const profiles = await ProviderProfile.find({ userId: { $in: providerIds } })
          .select('userId location radius')
          .lean();
        
        const profileMap = new Map(profiles.map(p => [String(p.userId), p]));
        
        // Filtruj providerów po odległości
        const filteredProviders = [];
        for (const provider of providers) {
          const profile = profileMap.get(String(provider._id));
          
          if (profile && profile.location && profile.location.coordinates) {
            // Użyj ProviderProfile location
            const [profileLng, profileLat] = profile.location.coordinates;
            const distance = calculateDistance(
              searchLocation.lat,
              searchLocation.lng,
              profileLat,
              profileLng
            );
            
            const providerRadius = profile.radius || radiusNum;
            if (distance <= providerRadius) {
              provider._distance = distance; // Dodaj odległość do wyniku
              filteredProviders.push(provider);
            }
          } else if (provider.locationCoords && provider.locationCoords.lat && provider.locationCoords.lng) {
            // Fallback: użyj locationCoords z User
            const distance = calculateDistance(
              searchLocation.lat,
              searchLocation.lng,
              provider.locationCoords.lat,
              provider.locationCoords.lng
            );
            
            if (distance <= radiusNum) {
              provider._distance = distance;
              filteredProviders.push(provider);
            }
          }
        }
        
        providers = filteredProviders;
        console.log(`🔍 GEO_SEARCH: Found ${providers.length} providers within ${radiusNum}km`);
      } catch (geoError) {
        console.warn('⚠️ GEO_SEARCH_ERROR:', geoError.message);
        // Fallback: kontynuuj bez geo filtrowania
      }
    }
    
    console.log("🔍 SEARCH: Found providers:", providers.length);
    
    if (!providers || providers.length === 0) {
      console.log("⚠️ SEARCH: No providers found, returning empty array");
      return res.json([]);
    }
    
    console.log("🔍 SEARCH: First provider sample:", {
      id: providers[0]?._id,
      name: providers[0]?.name,
      location: providers[0]?.location,
      company: providers[0]?.company
    });
    
    // Pobierz subscription plans dla wszystkich providerów
    console.log("🔍 SEARCH: Fetching subscriptions...");
    const providerIds = providers.map(p => p._id);
    const subscriptions = await UserSubscription.find({
      user: { $in: providerIds },
      status: 'active'
    }).lean();
    console.log("🔍 SEARCH: Found subscriptions:", subscriptions.length);
    const subscriptionMap = new Map();
    subscriptions.forEach(sub => {
      subscriptionMap.set(String(sub.user), sub.planKey);
    });
    
    // Filtruj po harmonogramie jeśli wybrano "today" lub "tomorrow"
    if (available && (available === 'today' || available === 'tomorrow')) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const targetDate = new Date(today);
      if (available === 'tomorrow') {
        targetDate.setDate(targetDate.getDate() + 1);
      }
      
      // Pobierz harmonogramy dla wszystkich providerów
      const providerIds = providers.map(p => p._id);
      const schedules = await ProviderSchedule.find({ 
        $or: [
          { user: { $in: providerIds } },
          { provider: { $in: providerIds } } // Kompatybilność wsteczna
        ],
        useCalendar: true
      }).lean();
      
      // Importuj helper z providerSchedule
      const { isProviderAvailable } = require('./providerSchedule');
      
      // Filtruj providerów używając helpera
      const filteredProviders = [];
      for (const p of providers) {
        const isAvailable = await isProviderAvailable(p._id, targetDate);
        if (isAvailable) {
          filteredProviders.push(p);
        }
      }
      
      providers = filteredProviders;
    }
    
    // Pobierz nazwy dopasowanych usług
    let namesById = {};
    let matchedServiceNames = [];
    if (service) {
      const serviceList = String(service).split(",").filter(Boolean);
      const found = await Service.find({ _id: { $in: serviceList } }).lean();
      namesById = Object.fromEntries(found.map(s => [String(s._id), s.name_pl || s.name_en]));
      matchedServiceNames = serviceList.map(id => namesById[id]).filter(Boolean);
    }
    
    // Pobierz nazwy wszystkich usług (dla wszystkich providerów)
    const allServiceIds = [...new Set(providers.flatMap(p => p.services || []))];
    const allServices = await Service.find({ _id: { $in: allServiceIds } }).lean();
    const allNamesById = Object.fromEntries(allServices.map(s => [String(s._id), s.name_pl || s.name_en]));

    // Pobierz informacje o dostępności "teraz" dla wszystkich providerów
    const { isProviderAvailableNow } = require('./providerSchedule');
    
    // Oblicz dostępność "teraz" dla wszystkich providerów (batch dla wydajności)
    const availabilityPromises = providers.map(async (p) => {
      try {
        const availableNow = await isProviderAvailableNow(p._id);
        return { providerId: String(p._id), availableNow };
      } catch (error) {
        console.error(`Error checking availability for provider ${p._id}:`, error);
        // W przypadku błędu, użyj podstawowego statusu online
        return { providerId: String(p._id), availableNow: p.provider_status?.isOnline || false };
      }
    });
    const availabilityMap = new Map();
    (await Promise.all(availabilityPromises)).forEach(({ providerId, availableNow }) => {
      availabilityMap.set(providerId, availableNow);
    });
    
    let results = await Promise.all(
      providers.map(async (p) => {
        try {
          const ratings = await Rating.find({ to: p._id });
          const avg =
            ratings.reduce((sum, r) => sum + r.rating, 0) / (ratings.length || 1);

        // Pobierz status weryfikacji
        const verification = await Verification.findOne({ user: p._id });
        
        // Generuj unikalne współrzędne dla wykonawców bez locationCoords
        const baseLat = 52.2297; // Warszawa
        const baseLng = 21.0122;
        const offset = 0.01; // ~1km offset
        
        // Użyj ID użytkownika do generowania deterministycznego przesunięcia
        const userId = String(p._id);
        const latOffset = (parseInt(userId.slice(-4), 16) % 100 - 50) / 1000 * offset;
        const lngOffset = (parseInt(userId.slice(-8, -4), 16) % 100 - 50) / 1000 * offset;
        
        // Pobierz plan subskrypcji
        const planKey = subscriptionMap.get(String(p._id)) || null;
        
        // Pobierz boosty dla providera
        const Boost = require('../models/Boost');
        const boosts = await Boost.find({
          provider: p._id,
          $or: [
            { endsAt: { $gt: new Date() } },
            { endsAt: null }
          ]
        }).lean();
        
        // Pobierz dostępność "teraz" z harmonogramu (lub użyj podstawowego isOnline)
        const availableNow = availabilityMap.get(String(p._id)) || p.provider_status?.isOnline || false;
        
        // MVP: Calculate ETA based on distance if available
        const providerLevel = p.level || "basic";
        let eta = p.time || estimateTime(providerLevel);
        let etaRange = null;
        
        if (p._distance !== undefined) {
          // v2: ETA based on distance
          etaRange = estimateETA(providerLevel, p._distance);
          eta = Math.round((etaRange.min + etaRange.max) / 2); // Średnia ETA
        } else {
          // v1: Fixed ETA per level
          etaRange = estimateETA(providerLevel);
        }
        
        const providerData = {
          _id: p._id,
          name: p.name,
          level: providerLevel,
          lat: p.locationCoords?.lat || (baseLat + latOffset),
          lng: p.locationCoords?.lng || (baseLng + lngOffset),
          location: {
            lat: p.locationCoords?.lat || (baseLat + latOffset),
            lng: p.locationCoords?.lng || (baseLng + lngOffset),
          },
          price: p.price || estimatePrice(providerLevel),
          eta: eta,
          etaRange: etaRange, // MVP: Add ETA range
          distance: p._distance || null, // MVP: Distance in km
          averageRating: Number(avg.toFixed(2)),
          ratingCount: ratings.length,
          matchedServiceName: matchedServiceNames[0] || null, // pierwsza dopasowana usługa
          matchedServiceNames, // wszystkie dopasowane usługi
          matchedServices: service ? String(service).split(",").filter(Boolean) : [], // ID dopasowanych usług
          provider_status: {
            ...(p.provider_status || { isOnline: false }),
            isOnline: availableNow, // Nadpisz isOnline dostępnością z harmonogramu
            availableNow: availableNow // Dodaj również jako osobne pole dla czytelności
          },
          promo: p.promo || {},
          avgRating: Number(avg.toFixed(2)), // dla computeScore
          qualityScore: p.qualityScore || 0, // dla computeScore
          badges: p.badges || [], // dodane badges
          rankingPoints: p.rankingPoints || 0, // punkty rankingowe
          verification: verification ? {
            status: verification.status,
            verified: verification.status === "verified"
          } : null,
          kyc: p.kyc || { status: 'not_started' }, // status KYC dla badge'ów
          service: p.service || null, // główna usługa
          verified: p.verified || false, // status weryfikacji
          b2b: p.b2b || false, // czy B2B
          providerTier: p.providerTier || 'basic', // tier providera
          isTopProvider: p.isTopProvider || false, // Top Provider na mapie
          hasHelpfliGuarantee: p.hasHelpfliGuarantee || false, // Gwarancja Helpfli+
          allServices: (p.services || []).map(id => allNamesById[String(id)]).filter(Boolean), // wszystkie usługi providera
          // B2B i subscription data
          company: p.company ? {
            _id: p.company._id,
            name: p.company.name,
            logo: p.company.logo
          } : null,
          subscriptionPlan: planKey,
          planKey: planKey,
          boosts: boosts.map(b => ({
            code: b.code,
            endsAt: b.endsAt
          }))
        };

          const dynamicScore = await computeProviderRankScore({
            _id: p._id,
            avgRating: providerData.avgRating,
            completedOrders: p.completedOrders || 0,
          });

          return {
            ...providerData,
            _score: computeScore(providerData),
            rankScore: typeof p.rankScore === 'number' ? p.rankScore : dynamicScore,
          };
        } catch (error) {
          console.error(`❌ SEARCH: Error processing provider ${p._id}:`, error?.message || error);
          console.error(`❌ SEARCH: Stack:`, error?.stack);
          // Zwróć null zamiast rzucać błąd - będzie filtrowane później
          return null;
        }
      })
    );
    
    // Filtruj null values (błędy podczas przetwarzania)
    results = results.filter(p => p !== null);

    // Nowy system rankingowy z promocjami i tierami
    results = results.map(p => {
      const quality = p.averageRating * 20 || 0; // 0-100
      const availability = p.provider_status?.isOnline ? 100 : 0;
      const responseRate = 85; // TODO: rzeczywista wartość
      const distanceScore = 100; // TODO: rzeczywista wartość
      const recency = 80; // TODO: rzeczywista wartość

      const promoBoost = getPromoBoost(p);
      
      // Boost za tier providera
      const tierBoost = p.providerTier === 'pro' ? 50 : 
                       p.providerTier === 'standard' ? 20 : 0;

      const score = 0.5 * quality + 0.1 * availability + 0.1 * responseRate
                  + 0.1 * distanceScore + 0.1 * recency + promoBoost + tierBoost;

      return { ...p, rankScore: score, promoBoost, tierBoost };
    });

    // MVP: Sortowanie zgodnie z parametrem sort
    switch (sort) {
      case 'rating':
        results.sort((a, b) => b.averageRating - a.averageRating);
        break;
      case 'price':
        results.sort((a, b) => a.price - b.price);
        break;
      case 'eta':
        results.sort((a, b) => (a.eta || 999) - (b.eta || 999));
        break;
      case 'relevance':
      default:
        // Sortowanie po rankScore (cache/dynamic), fallback _score
        results.sort((a, b) => (b.rankScore - a.rankScore) || (b._score - a._score));
        break;
    }

    // sponsorowane sloty
    try {
      const campaigns = await fetchActiveCampaigns({ service, city: location });
      const allowed = await capForUser({ campaigns, userId: req.user?._id });
      const injected = injectSponsored({ list: results, campaigns: allowed });
      console.log("🔍 SEARCH RESULTS:", { count: injected.length, firstResult: injected[0]?.name });
      return res.json(injected);
    } catch (e) {
      console.warn('⚠️ SPONSOR_INJECT_WARN:', e?.message || e);
      console.warn('⚠️ SPONSOR_INJECT_WARN stack:', e?.stack);
      // Nie rzucaj błędu - zwróć wyniki bez sponsorowanych
      console.log("🔍 SEARCH RESULTS (fallback - bez sponsorów):", { count: results.length, firstResult: results[0]?.name });
      return res.json(results);
    }
  } catch (err) {
    console.error("❌ Błąd w /api/search:", err);
    console.error("❌ Stack trace:", err.stack);
    res.status(500).json({ 
      message: "Błąd wyszukiwania wykonawców",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Estymacje ceny i czasu
function estimatePrice(level) {
  switch (level) {
    case "pro":
      return 250;
    case "standard":
      return 150;
    case "basic":
    default:
      return 100;
  }
}

function estimateTime(level) {
  switch (level) {
    case "pro":
      return 30;
    case "standard":
      return 60;
    case "basic":
    default:
      return 90;
  }
}

// Prosty in-memory cache dla /top (TTL: 30 sekund)
const topCache = {
  data: null,
  timestamp: null,
  ttl: 30000 // 30 sekund
};

// Endpoint dla top providerów
router.get("/top", async (req, res) => {
  try {
    const { limit = 6, proPercentage = 0.5 } = req.query;
    
    // Sprawdź cache
    const nowTimestamp = Date.now();
    if (topCache.data && topCache.timestamp && (nowTimestamp - topCache.timestamp) < topCache.ttl) {
      // Zwróć z cache (ale z limitem)
      const cached = Array.isArray(topCache.data) ? topCache.data.slice(0, parseInt(limit) || 6) : topCache.data;
      return res.json(cached);
    }
    
    console.log("🌟 TOP_PROVIDERS_REQUEST:", { limit, proPercentage });
    
    // Pobierz subskrypcje dla wszystkich providerów
    const subscriptions = await UserSubscription.find({
      status: 'active',
      validUntil: { $gt: new Date() }
    }).select('user planKey').lean();
    
    const subscriptionMap = new Map();
    subscriptions.forEach(sub => {
      subscriptionMap.set(String(sub.user), sub.planKey);
    });
    
    // Pobierz szerszy zestaw kandydatów (zwiększamy limit, bo nowy system ma ostrzejsze filtry)
    const now = new Date();
    const providers = await User.find({ 
      role: "provider",
      $or: [
        // Aktywne promocje
        { "promo.highlightUntil": { $gt: now } },
        { "promo.topBadgeUntil": { $gt: now } },
        { "promo.aiTopTagUntil": { $gt: now } },
        // Pakiet PRO (ale sprawdzimy wymagania jakościowe później)
        { providerTier: "pro" },
        // Standard/Basic z weryfikacją (będą sprawdzeni przez wymagania jakościowe)
        { verified: true, providerTier: { $in: ["standard", "basic"] } }
      ]
    })
      .select("name level location locationCoords price time services provider_status promo badges kyc rankingPoints verified service providerTier isTopProvider hasHelpfliGuarantee avatar bio headline")
      .limit(parseInt(limit) * 5) // Pobierz więcej kandydatów (nowy system ma ostre filtry)
      .lean();

    // Pobierz nazwy wszystkich usług (dla wszystkich providerów)
    const allServiceIds = [...new Set(providers.flatMap(p => p.services || []))];
    const allServices = await Service.find({ _id: { $in: allServiceIds } }).lean();
    const allNamesById = Object.fromEntries(allServices.map(s => [String(s._id), s.name_pl || s.name_en]));

    // Użyj nowego systemu rankingowego
    const { rankTopProviders } = require('../utils/rankingTopProviders');
    const rankedProviders = await rankTopProviders(
      providers, 
      parseInt(limit) || 6,
      parseFloat(proPercentage) || 0.5
    );

    // Pobierz dostępność "teraz" dla wszystkich TOP providerów
    const { isProviderAvailableNow } = require('./providerSchedule');
    const availabilityPromisesTop = rankedProviders.map(async (p) => {
      try {
        const availableNow = await isProviderAvailableNow(p._id);
        return { providerId: String(p._id), availableNow };
      } catch (error) {
        return { providerId: String(p._id), availableNow: p.provider_status?.isOnline || false };
      }
    });
    const availabilityMapTop = new Map();
    (await Promise.all(availabilityPromisesTop)).forEach(({ providerId, availableNow }) => {
      availabilityMapTop.set(providerId, availableNow);
    });

    // Przygotuj dane do zwrócenia (kompatybilność z frontendem)
    const topProviders = await Promise.all(
      rankedProviders.map(async (p) => {
        const ratings = await Rating.find({ to: p._id });
        const avg = ratings.reduce((sum, r) => sum + r.rating, 0) / (ratings.length || 1);

        // Pobierz status weryfikacji
        const verification = await Verification.findOne({ user: p._id });
        
        // Generuj unikalne współrzędne
        const baseLat = 52.2297;
        const baseLng = 21.0122;
        const offset = 0.01;
        const userId = String(p._id);
        const latOffset = (parseInt(userId.slice(-4), 16) % 100 - 50) / 1000 * offset;
        const lngOffset = (parseInt(userId.slice(-8, -4), 16) % 100 - 50) / 1000 * offset;
        
        // Pobierz plan subskrypcji
        const planKey = subscriptionMap.get(String(p._id)) || null;
        
        // Pobierz boosty dla providera
        const Boost = require('../models/Boost');
        const boosts = await Boost.find({
          provider: p._id,
          $or: [
            { endsAt: { $gt: new Date() } },
            { endsAt: null }
          ]
        }).lean();
        
        // Pobierz dostępność "teraz" z harmonogramu
        const availableNow = availabilityMapTop.get(String(p._id)) || p.provider_status?.isOnline || false;
        
        return {
          _id: p._id,
          name: p.name,
          level: p.level || "basic",
          lat: p.locationCoords?.lat || (baseLat + latOffset),
          lng: p.locationCoords?.lng || (baseLng + lngOffset),
          location: {
            lat: p.locationCoords?.lat || (baseLat + latOffset),
            lng: p.locationCoords?.lng || (baseLng + lngOffset),
          },
          price: p.price || estimatePrice(p.level),
          eta: p.time || estimateTime(p.level),
          averageRating: Number(avg.toFixed(2)),
          ratingCount: ratings.length,
          provider_status: {
            ...(p.provider_status || { isOnline: false }),
            isOnline: availableNow,
            availableNow: availableNow
          },
          promo: p.promo || {},
          badges: p.badges || [],
          rankingPoints: p.rankingPoints || 0,
          verification: verification ? {
            status: verification.status,
            verified: verification.status === "verified"
          } : null,
          kyc: p.kyc || { status: 'not_started' },
          service: p.service || null,
          verified: p.verified || false,
          b2b: p.b2b || false,
          providerTier: p.providerTier || 'basic',
          isTopProvider: p.isTopProvider || false,
          hasHelpfliGuarantee: p.hasHelpfliGuarantee || false,
          allServices: (p.services || []).map(id => allNamesById[String(id)]).filter(Boolean),
          bio: p.bio || '',
          headline: p.headline || '',
          avatar: p.avatar || null,
          // Pola promocyjne (z nowego systemu rankingowego)
          hasHighlight: p.hasHighlight,
          hasTopBadge: p.hasTopBadge,
          hasAiTag: p.hasAiTag,
          hasActivePromo: p.hasActivePromo,
          // Informacje o firmie (jeśli provider należy do firmy)
          company: p.company ? {
            _id: p.company._id,
            name: p.company.name,
            logo: p.company.logo
          } : null,
          // B2B i subscription data
          subscriptionPlan: planKey,
          planKey: planKey,
          boosts: boosts.map(b => ({
            code: b.code,
            endsAt: b.endsAt
          })),
          // Dodatkowe metryki jakościowe (z nowego systemu)
          qualityStats: p.qualityStats ? {
            completedOrders: p.qualityStats.completedOrders,
            acceptanceRate: Math.round(p.qualityStats.acceptanceRate * 100),
            onTimeRate: Math.round(p.qualityStats.onTimeRate * 100),
            responseTimeMin: p.qualityStats.responseTimeMin
          } : null,
          finalScore: p.finalScore
        };
      })
    );

    const response = { providers: topProviders };
    
    // Zapisz do cache
    topCache.data = response;
    topCache.timestamp = Date.now();
    
    res.json(response);
  } catch (error) {
    console.error("Error fetching top providers:", error);
    res.status(500).json({ message: "Błąd serwera" });
  }
});

// Endpoint dla katalogu providerów z zaawansowanymi filtrami
router.get("/providers", async (req, res) => {
  const { 
    service, 
    city, 
    radius = 50, 
    availableNow, 
    verified, 
    b2b, 
    tier,
    level, // Akceptuj też level dla kompatybilności z AdvancedFilters
    minRating = 0, 
    maxPrice, 
    minPrice = 0,
    budgetMin, // Akceptuj też budgetMin dla kompatybilności
    budgetMax, // Akceptuj też budgetMax dla kompatybilności
    maxTime, 
    instantChat, 
    vatInvoice,
    sort = 'relevance',
    page = 1,
    limit = 20
  } = req.query;

  console.log("🔍 PROVIDERS_CATALOG_REQUEST:", { 
    service, city, radius, availableNow, verified, b2b, tier, 
    minRating, maxPrice, minPrice, maxTime, instantChat, vatInvoice, 
    sort, page, limit 
  });

  try {
    const match = {
      role: "provider",
    };
    
    // Filtr usługi - używamy tej samej logiki co w głównym wyszukiwaniu
    if (service) {
      const serviceList = String(service).split(",").filter(Boolean);
      
      // Sprawdź czy to są ID usług czy nazwy kategorii
      const isServiceId = serviceList[0].length === 24; // ObjectId ma 24 znaki
      
      if (isServiceId) {
        // Tradycyjne wyszukiwanie po ID usług
        if (serviceList.length === 1) {
          match.services = serviceList[0];
        } else {
          match.services = { $in: serviceList };
        }
      } else {
        // Wyszukiwanie po kategoriach lub konkretnych slugach usług
        const categoryServices = await Service.find({ 
          $or: [
            { parent_slug: { $in: serviceList } },
            { slug: { $in: serviceList } }
          ]
        }).select('_id');
        
        const serviceIds = categoryServices.map(s => s._id);
        if (serviceIds.length > 0) {
          match.services = { $in: serviceIds };
        }
      }
    }

    // Filtr miasta
    if (city) {
      match.location = { $regex: new RegExp(city, "i") };
    }

    // Filtr dostępności
    if (availableNow === 'true') {
      match["provider_status.isOnline"] = true;
    }

    // Filtr weryfikacji
    if (verified === 'true') {
      match.badges = { $in: ["verified"] };
    }

    // Filtr B2B
    if (b2b === 'true') {
      match.b2b = true;
    }

    // Filtr tier/level (akceptuj oba dla kompatybilności)
    const tierValue = tier || level;
    if (tierValue && tierValue !== 'all' && tierValue !== 'any') {
      match.providerTier = tierValue;
    }

    // Filtr ceny - parse to numbers (akceptuj też budgetMin/budgetMax dla kompatybilności)
    const parsedMinPrice = parseInt(minPrice || budgetMin) || 0;
    const parsedMaxPrice = parseInt(maxPrice || budgetMax);
    // Filtruj tylko jeśli maxPrice jest podane i mniejsze niż rozsądna wartość (np. 10000)
    if (parsedMinPrice > 0 || (parsedMaxPrice && parsedMaxPrice < 10000)) {
      match.price = {};
      if (parsedMinPrice > 0) match.price.$gte = parsedMinPrice;
      if (parsedMaxPrice && parsedMaxPrice < 10000) match.price.$lte = parsedMaxPrice;
    }

    // Filtr czasu realizacji - parse to number (nie filtruj jeśli maxTime >= 30)
    const parsedMaxTime = parseInt(maxTime);
    if (parsedMaxTime && parsedMaxTime < 30) {
      match.time = { $lte: parsedMaxTime };
    }

    // Filtr chat natychmiastowy
    if (instantChat === 'true') {
      match.instantChat = true;
    }

    // Filtr faktura VAT
    if (vatInvoice === 'true') {
      match.vatInvoice = true;
    }

    const { getDemoUserIds: getDemoIdsForCatalog } = require('../utils/demoAccounts');
    if (process.env.HIDE_DEMO_DATA !== '0') {
      const demoIds = await getDemoIdsForCatalog();
      if (demoIds.length) match._id = { $nin: demoIds };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const providers = await User.find(match)
      .select("name level location locationCoords price time services provider_status promo badges kyc rankingPoints providerTier isTopProvider hasHelpfliGuarantee b2b instantChat vatInvoice bio headline avatar")
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(match);
    
    // Pobierz nazwy wszystkich usług
    const allServiceIds = [...new Set(providers.flatMap(p => p.services || []))];
    const allServices = await Service.find({ _id: { $in: allServiceIds } }).lean();
    const allNamesById = Object.fromEntries(allServices.map(s => [String(s._id), s.name_pl || s.name_en]));

    // Pobierz dostępność "teraz" dla wszystkich providerów
    const { isProviderAvailableNow } = require('./providerSchedule');
    const availabilityPromises2 = providers.map(async (p) => {
      try {
        const availableNow = await isProviderAvailableNow(p._id);
        return { providerId: String(p._id), availableNow };
      } catch (error) {
        return { providerId: String(p._id), availableNow: p.provider_status?.isOnline || false };
      }
    });
    const availabilityMap2 = new Map();
    (await Promise.all(availabilityPromises2)).forEach(({ providerId, availableNow }) => {
      availabilityMap2.set(providerId, availableNow);
    });
    
    let results = await Promise.all(
      providers.map(async (p) => {
        const ratings = await Rating.find({ to: p._id });
        const avg = ratings.reduce((sum, r) => sum + r.rating, 0) / (ratings.length || 1);

        // Pobierz status weryfikacji
        const verification = await Verification.findOne({ user: p._id });
        
        // Generuj unikalne współrzędne
        const baseLat = 52.2297;
        const baseLng = 21.0122;
        const offset = 0.01;
        const userId = String(p._id);
        const latOffset = (parseInt(userId.slice(-4), 16) % 100 - 50) / 1000 * offset;
        const lngOffset = (parseInt(userId.slice(-8, -4), 16) % 100 - 50) / 1000 * offset;
        
        // Pobierz dostępność "teraz" z harmonogramu
        const availableNow = availabilityMap2.get(String(p._id)) || p.provider_status?.isOnline || false;
        
        const providerData = {
          _id: p._id,
          id: p._id,
          name: p.name,
          level: p.level || "basic",
          lat: p.locationCoords?.lat || (baseLat + latOffset),
          lng: p.locationCoords?.lng || (baseLng + lngOffset),
          location: {
            lat: p.locationCoords?.lat || (baseLat + latOffset),
            lng: p.locationCoords?.lng || (baseLng + lngOffset),
          },
          price: p.price || estimatePrice(p.level),
          eta: p.time || estimateTime(p.level),
          averageRating: Number(avg.toFixed(2)),
          ratingCount: ratings.length,
          provider_status: {
            ...(p.provider_status || { isOnline: false }),
            isOnline: availableNow,
            availableNow: availableNow
          },
          promo: p.promo || {},
          badges: p.badges || [],
          rankingPoints: p.rankingPoints || 0,
          verification: verification ? {
            status: verification.status,
            verified: verification.status === "verified"
          } : null,
          kyc: p.kyc || { status: 'not_started' },
          service: p.service || null,
          verified: p.verified || false,
          b2b: p.b2b || false,
          providerTier: p.providerTier || 'basic',
          isTopProvider: p.isTopProvider || false,
          hasHelpfliGuarantee: p.hasHelpfliGuarantee || false,
          instantChat: p.instantChat || false,
          vatInvoice: p.vatInvoice || false,
          bio: p.bio || '',
          allServices: (p.services || []).map(id => allNamesById[String(id)]).filter(Boolean),
        };

        const dynamicScore = await computeProviderRankScore({
          _id: p._id,
          avgRating: providerData.averageRating,
          completedOrders: p.completedOrders || 0,
        });

        return {
          ...providerData,
          _score: computeScore(providerData),
          rankScore: typeof p.rankScore === 'number' ? p.rankScore : dynamicScore,
        };
      })
    );

    // MVP: Sortowanie (zgodnie z planem MVP)
    switch (sort) {
      case 'rating':
        results.sort((a, b) => b.averageRating - a.averageRating);
        break;
      case 'price':
      case 'price_asc':
        results.sort((a, b) => a.price - b.price);
        break;
      case 'price_desc':
        results.sort((a, b) => b.price - a.price);
        break;
      case 'eta':
        // MVP: Sortuj po ETA (Estimated Time of Arrival)
        results.sort((a, b) => (a.eta || 999) - (b.eta || 999));
        break;
      case 'distance':
        // TODO: implement distance sorting
        break;
      case 'response_time':
        // TODO: implement response time sorting
        break;
      case 'relevance':
      default:
        results.sort((a, b) => (b.rankScore - a.rankScore) || (b._score - a._score));
        break;
    }

    // Filtruj po ocenie - parse to number
    const parsedMinRating = parseFloat(minRating) || 0;
    if (parsedMinRating > 0) {
      results = results.filter(p => p.averageRating >= parsedMinRating);
    }

    const hasMore = skip + results.length < total;

    console.log("🔍 PROVIDERS_CATALOG_RESULTS:", { 
      count: results.length, 
      total, 
      hasMore, 
      firstResult: results[0]?.name 
    });

    res.json({ 
      providers: results, 
      total, 
      hasMore,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error("Błąd w /api/search/providers:", err);
    res.status(500).json({ message: "Błąd wyszukiwania wykonawców" });
  }
});

module.exports = router;