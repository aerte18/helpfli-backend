const User = require('../models/User');
const Order = require('../models/Order');
const Rating = require('../models/Rating');

/**
 * Wymagania jakościowe dla TOP providerów
 */
const TOP_QUALITY_REQUIREMENTS = {
  // Wymagania dla PRO tier
  PRO: {
    minRating: 4.0,
    minCompletedOrders: 5,
    minAcceptanceRate: 0.25,  // 25%
    minOnTimeRate: 0.70,      // 70%
    maxResponseTimeMin: 60    // maksymalny czas odpowiedzi (minuty)
  },
  // Wymagania dla Standard/Basic tier (bez pakietu PRO)
  NON_PRO: {
    minRating: 4.5,
    minCompletedOrders: 10,
    minAcceptanceRate: 0.30,  // 30%
    minOnTimeRate: 0.75,      // 75%
    maxResponseTimeMin: 45
  }
};

/**
 * Pobiera statystyki providera (rating, zlecenia, acceptance rate, on-time rate, response time)
 */
async function getProviderQualityStats(providerId) {
  try {
    // Rating
    const rAgg = await Rating.aggregate([
      { $match: { to: providerId } },
      { $group: { _id: '$to', avg: { $avg: '$rating' }, cnt: { $sum: 1 } } }
    ]);
    const ratingAvg = rAgg?.[0]?.avg || 0;
    const ratingCount = rAgg?.[0]?.cnt || 0;

    // Statystyki zleceń (ostatnie 180 dni)
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    
    const orderStats = await Order.aggregate([
      {
        $match: {
          provider: providerId,
          createdAt: { $gte: since }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          accepted: {
            $sum: {
              $cond: [
                { $in: ['$status', ['accepted', 'in_progress', 'completed', 'done', 'closed']] },
                1,
                0
              ]
            }
          },
          completed: {
            $sum: {
              $cond: [
                { $in: ['$status', ['completed', 'done', 'closed']] },
                1,
                0
              ]
            }
          },
          onTime: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$status', ['completed', 'done', 'closed']] },
                    { $eq: ['$deliveredOnTime', true] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const stats = orderStats[0] || { total: 0, accepted: 0, completed: 0, onTime: 0 };
    
    // Acceptance rate: przyjmujemy że "received" to total (wszystkie zlecenia które otrzymał)
    // W rzeczywistości powinno być zlecenia do których został zaproszony, ale na razie używamy total
    const received = Math.max(stats.total, stats.accepted + 3); // heurystyka
    const acceptanceRate = received > 0 ? stats.accepted / received : 0;
    
    // On-time rate
    const onTimeRate = stats.completed > 0 ? stats.onTime / stats.completed : 0;

    // Response time (z user.meta.responseTimeMin lub domyślnie 30)
    const user = await User.findById(providerId).select('meta').lean();
    const responseTimeMin = user?.meta?.responseTimeMin ?? 30;

    return {
      ratingAvg,
      ratingCount,
      completedOrders: stats.completed,
      totalOrders: stats.total,
      acceptanceRate,
      onTimeRate,
      responseTimeMin
    };
  } catch (error) {
    console.error(`Error getting quality stats for provider ${providerId}:`, error);
    return {
      ratingAvg: 0,
      ratingCount: 0,
      completedOrders: 0,
      totalOrders: 0,
      acceptanceRate: 0,
      onTimeRate: 0,
      responseTimeMin: 60
    };
  }
}

/**
 * Sprawdza czy provider spełnia wymagania jakościowe dla TOP
 */
async function meetsTopQualityRequirements(provider, stats) {
  const tier = provider.providerTier || 'basic';
  const requirements = tier === 'pro' ? TOP_QUALITY_REQUIREMENTS.PRO : TOP_QUALITY_REQUIREMENTS.NON_PRO;

  // Sprawdź wszystkie wymagania
  const meetsRating = stats.ratingAvg >= requirements.minRating || stats.ratingCount === 0; // Jeśli brak ocen, nie blokuj
  const meetsOrders = stats.completedOrders >= requirements.minCompletedOrders;
  const meetsAcceptance = stats.acceptanceRate >= requirements.minAcceptanceRate || stats.totalOrders < 5; // Jeśli < 5 zleceń, nie blokuj
  const meetsOnTime = stats.onTimeRate >= requirements.minOnTimeRate || stats.completedOrders === 0;
  const meetsResponseTime = stats.responseTimeMin <= requirements.maxResponseTimeMin;

  // Dla nowych providerów (mniej niż 5 zleceń) - mniej rygorystyczne
  if (stats.completedOrders < 5) {
    return meetsRating && meetsResponseTime;
  }

  return meetsRating && meetsOrders && meetsAcceptance && meetsOnTime && meetsResponseTime;
}

/**
 * Oblicza zaawansowany score dla TOP ranking
 * 
 * @param {Object} provider - Provider object
 * @param {Object} stats - Quality stats from getProviderQualityStats
 * @param {Object} promoBoost - Promo boost value
 * @returns {Number} Final score (0-1000)
 */
function calculateTopScore(provider, stats, promoBoost = 0) {
  const tier = provider.providerTier || 'basic';
  
  // Wagi dla różnych metryk
  const weights = {
    rating: 0.30,           // 30% - ocena klientów
    completedOrders: 0.20,  // 20% - doświadczenie (ilość zleceń)
    acceptanceRate: 0.15,   // 15% - akceptacja zleceń
    onTimeRate: 0.15,       // 15% - terminowość
    responseTime: 0.10,     // 10% - czas odpowiedzi
    tierBoost: 0.10         // 10% - tier providera
  };

  // Normalizacja rating (0-5 -> 0-100)
  const ratingScore = Math.min(100, (stats.ratingAvg / 5) * 100);
  
  // Normalizacja zleceń (0-100 zleceń -> 0-100, max 100)
  const ordersScore = Math.min(100, (stats.completedOrders / 100) * 100);
  
  // Acceptance rate (0-1 -> 0-100)
  const acceptanceScore = stats.acceptanceRate * 100;
  
  // On-time rate (0-1 -> 0-100)
  const onTimeScore = stats.onTimeRate * 100;
  
  // Response time (im szybciej, tym lepiej: 0-60 min -> 100-0)
  const responseTimeScore = Math.max(0, 100 - (stats.responseTimeMin / 60) * 100);
  
  // Tier boost (PRO > Standard > Basic)
  const tierBoostScore = tier === 'pro' ? 100 : tier === 'standard' ? 50 : 0;
  
  // Base score (suma ważona)
  const baseScore = (
    ratingScore * weights.rating +
    ordersScore * weights.completedOrders +
    acceptanceScore * weights.acceptanceRate +
    onTimeScore * weights.onTimeRate +
    responseTimeScore * weights.responseTime +
    tierBoostScore * weights.tierBoost
  );

  // Promo boost (dodatkowe punkty za promocje)
  const finalScore = baseScore + promoBoost;

  return Math.round(finalScore);
}

/**
 * Rotacja czasowa - dodaje bonus za ostatnią aktywność
 * Providerzy aktywni w ostatnich 7 dniach dostają bonus
 */
function getRecencyBonus(provider) {
  const lastSeenAt = provider.provider_status?.lastSeenAt;
  if (!lastSeenAt) return 0;

  const daysSinceLastSeen = (Date.now() - new Date(lastSeenAt).getTime()) / (1000 * 60 * 60 * 24);
  
  if (daysSinceLastSeen <= 1) return 20;      // Aktywny dzisiaj/wczoraj
  if (daysSinceLastSeen <= 3) return 15;      // Aktywny w ciągu 3 dni
  if (daysSinceLastSeen <= 7) return 10;      // Aktywny w ciągu tygodnia
  if (daysSinceLastSeen <= 30) return 5;      // Aktywny w ciągu miesiąca
  return 0;                                    // Nieaktywny > 30 dni
}

/**
 * Główna funkcja do oceny i sortowania TOP providerów
 * 
 * @param {Array} providers - Lista providerów
 * @param {Number} limit - Limit wyników
 * @param {Number} proPercentage - Procent miejsc dla PRO (0-1, domyślnie 0.5 = 50%)
 * @returns {Array} Posortowana lista TOP providerów
 */
async function rankTopProviders(providers, limit = 6, proPercentage = 0.5) {
  const { getPromoBoost } = require('./promo');
  
  // Pobierz statystyki dla wszystkich providerów
  const providersWithStats = await Promise.all(
    providers.map(async (provider) => {
      const stats = await getProviderQualityStats(provider._id);
      const meetsRequirements = await meetsTopQualityRequirements(provider, stats);
      const promoBoost = getPromoBoost(provider);
      const score = calculateTopScore(provider, stats, promoBoost);
      const recencyBonus = getRecencyBonus(provider);
      const finalScore = score + recencyBonus;

      // Sprawdź aktywne promocje
      const now = new Date();
      const hasHighlight = provider.promo?.highlightUntil && new Date(provider.promo.highlightUntil) > now;
      const hasTopBadge = provider.promo?.topBadgeUntil && new Date(provider.promo.topBadgeUntil) > now;
      const hasAiTag = provider.promo?.aiTopTagUntil && new Date(provider.promo.aiTopTagUntil) > now;
      const hasActivePromo = hasHighlight || hasTopBadge || hasAiTag;

      return {
        ...provider,
        qualityStats: stats,
        meetsQualityRequirements: meetsRequirements,
        promoBoost,
        recencyBonus,
        finalScore,
        hasHighlight,
        hasTopBadge,
        hasAiTag,
        hasActivePromo
      };
    })
  );

  // Filtruj tylko tych, którzy spełniają wymagania jakościowe
  const qualifiedProviders = providersWithStats.filter(p => p.meetsQualityRequirements);

  // Podziel na PRO i NON_PRO
  const proProviders = qualifiedProviders.filter(p => p.providerTier === 'pro');
  const nonProProviders = qualifiedProviders.filter(p => p.providerTier !== 'pro');

  // Sortuj każdą grupę
  proProviders.sort((a, b) => {
    // Priorytet: promocje > score > rating > zlecenia
    if (a.hasActivePromo !== b.hasActivePromo) return b.hasActivePromo - a.hasActivePromo;
    if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
    if (a.qualityStats.ratingAvg !== b.qualityStats.ratingAvg) {
      return b.qualityStats.ratingAvg - a.qualityStats.ratingAvg;
    }
    return b.qualityStats.completedOrders - a.qualityStats.completedOrders;
  });

  nonProProviders.sort((a, b) => {
    // Priorytet: promocje > score > rating > zlecenia
    if (a.hasActivePromo !== b.hasActivePromo) return b.hasActivePromo - a.hasActivePromo;
    if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
    if (a.qualityStats.ratingAvg !== b.qualityStats.ratingAvg) {
      return b.qualityStats.ratingAvg - a.qualityStats.ratingAvg;
    }
    return b.qualityStats.completedOrders - a.qualityStats.completedOrders;
  });

  // Oblicz limity (z zaokrągleniem w górę dla PRO, reszta dla NON_PRO)
  const proLimit = Math.ceil(limit * proPercentage);
  const nonProLimit = limit - proLimit;

  // Połącz wyniki
  const topProviders = [
    ...proProviders.slice(0, proLimit),
    ...nonProProviders.slice(0, nonProLimit)
  ];

  // Jeśli brakuje miejsc, uzupełnij najlepszymi z pozostałych (bez podziału na PRO/NON_PRO)
  if (topProviders.length < limit) {
    const remaining = qualifiedProviders
      .filter(p => !topProviders.find(tp => String(tp._id) === String(p._id)))
      .sort((a, b) => {
        if (a.hasActivePromo !== b.hasActivePromo) return b.hasActivePromo - a.hasActivePromo;
        if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
        return b.qualityStats.ratingAvg - a.qualityStats.ratingAvg;
      })
      .slice(0, limit - topProviders.length);
    
    topProviders.push(...remaining);
  }

  // Finalne sortowanie wszystkich wyników
  topProviders.sort((a, b) => {
    // 1. Aktywne promocje (aiTag > topBadge > highlight)
    if (a.hasActivePromo && b.hasActivePromo) {
      const aPromoScore = (a.hasAiTag ? 3 : 0) + (a.hasTopBadge ? 2 : 0) + (a.hasHighlight ? 1 : 0);
      const bPromoScore = (b.hasAiTag ? 3 : 0) + (b.hasTopBadge ? 2 : 0) + (b.hasHighlight ? 1 : 0);
      if (aPromoScore !== bPromoScore) return bPromoScore - aPromoScore;
    }
    if (a.hasActivePromo !== b.hasActivePromo) return b.hasActivePromo - a.hasActivePromo;

    // 2. Final score
    if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;

    // 3. Rating
    if (a.qualityStats.ratingAvg !== b.qualityStats.ratingAvg) {
      return b.qualityStats.ratingAvg - a.qualityStats.ratingAvg;
    }

    // 4. Ilość zleceń
    return b.qualityStats.completedOrders - a.qualityStats.completedOrders;
  });

  return topProviders.slice(0, limit);
}

module.exports = {
  TOP_QUALITY_REQUIREMENTS,
  getProviderQualityStats,
  meetsTopQualityRequirements,
  calculateTopScore,
  getRecencyBonus,
  rankTopProviders
};

