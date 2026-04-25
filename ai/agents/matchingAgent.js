/**
 * Agent Matching
 * Kryteria matchingu + ranking TOP 3-5 providerów
 */

const { MATCHING_CRITERIA_SYSTEM } = require('../prompts/matchingPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { validateMatchingResponse } = require('../schemas/conciergeSchemas');
const { recommendProviders } = require('../../utils/concierge');
const { normalizeUrgency } = require('../utils/normalize');
const User = require('../../models/User');

/**
 * Główna funkcja agenta Matching
 * @param {Object} params
 * @param {string} params.service - Kategoria usługi
 * @param {string} params.urgency - Pilność
 * @param {Object} params.budget - Budżet (opcjonalnie)
 * @param {Object} params.userContext - Kontekst użytkownika (location, etc.)
 * @returns {Promise<Object>} Response agenta
 */
async function runMatchingAgent({ service, urgency = 'standard', budget = null, userContext = {} }) {
  try {
    const locationText = userContext.location?.text || userContext.location || '';
    const location = {
      text: locationText,
      lat: userContext.location?.lat || null,
      lng: userContext.location?.lng || null,
      radiusKm: 10
    };
    
    // Określ kryteria matchingu
    const recommendedLevel = getRecommendedLevel(budget);
    const minRating = urgency === 'urgent' ? 4.0 : 3.5;
    const availability = urgency === 'urgent' ? 'now' : urgency === 'standard' ? 'today' : 'any';
    const sort = urgency === 'urgent' ? 'eta' : budget ? 'price' : 'rating';
    
    // Pobierz providerów z bazy (użyj istniejącej funkcji recommendProviders)
    let topProviders = [];
    try {
      // Sprawdź cache
      const CacheService = require('../../services/CacheService');
      let providersData = await CacheService.getProviderSearch(
        service, 
        locationText || 'default', 
        5
      );
      
      if (!providersData || providersData.length === 0) {
        // Wywołaj funkcję recommendProviders
        providersData = await recommendProviders(
          service,
          location.lat,
          location.lng,
          5, // limit
          urgency === 'urgent' ? 'now' : urgency === 'standard' ? 'today' : 'normal'
        );
        
        // Zapisz w cache (30 minut)
        if (providersData && providersData.length > 0) {
          await CacheService.setProviderSearch(
            service, 
            locationText || 'default', 
            5, 
            providersData, 
            1800
          );
        }
      }
      
      // Mapuj na format agenta (funkcja recommendProviders zwraca array z polami: _id, name, distanceKm, rating, etc.)
      topProviders = (providersData || []).slice(0, 5).map((provider, index) => {
        const distance = provider.distanceKm || provider.distance || 0;
        const rating = provider.rating || provider.avgRating || 0;
        const providerName = provider.name || provider.companyName || provider.displayName || 'Wykonawca';
        const providerLevel = normalizeProviderLevel(provider.level || provider.providerTier || provider.plan || provider.package || 'basic');
        const isPro = providerLevel === 'pro';
        const isAvailable = provider.isAvailable || provider.availableNow || provider.provider_status?.isOnline || provider.isOnline || false;
        const completedOrders = provider.completedOrders || provider.completed || 0;
        const successRate = provider.successRate || null;
        const baseRankingScore = provider.score || null;
        
        // Oblicz fitScore (0-1)
        const fitScore = calculateFitScore({
          rating,
          distance,
          availability: isAvailable,
          level: providerLevel,
          recommendedLevel,
          urgency,
          completedOrders,
          successRate,
          baseRankingScore,
          isPro
        });

        const match = buildMatchExplanation({
          provider,
          service,
          urgency,
          rating,
          distance,
          isAvailable,
          providerLevel,
          recommendedLevel,
          completedOrders,
          successRate,
          fitScore
        });
        
        return {
          providerId: String(provider._id || provider.id),
          name: providerName,
          rating,
          distanceKm: distance,
          level: providerLevel,
          isPro,
          verified: !!provider.verified,
          isAvailable,
          completedOrders,
          successRate,
          reason: match.reasons,
          fitScore,
          matchScore: match.percent,
          matchLevel: match.level,
          matchLabel: match.label,
          matchReasons: match.reasons,
          matchHighlights: match.highlights,
          matchSummary: match.summary,
          nextBestAction: match.nextBestAction
        };
      });
      topProviders.sort((a, b) => b.matchScore - a.matchScore);
      
    } catch (error) {
      console.warn('Could not fetch providers from DB:', error.message);
    }
    
    // Jeśli brak providerów, spróbuj użyć LLM do wygenerowania kryteriów
    // (dla przyszłego użycia, gdy będziemy mieli więcej danych)
    
    return {
      ok: true,
      agent: 'matching',
      service: service || 'inne',
      urgency: normalizeUrgency(urgency),
      budget: budget || null,
      location,
      criteria: {
        minRating,
        availability,
        recommendedLevel
      },
      topProviders,
      notes: topProviders.length > 0 
        ? ['Wszyscy wykonawcy są zweryfikowani i dostępni w Twojej okolicy']
        : ['Nie znaleziono wykonawców w tej lokalizacji. Spróbuj poszerzyć zakres wyszukiwania.']
    };
    
  } catch (error) {
    console.error('Matching Agent error:', error);
    
    // Fallback response
    return {
      ok: false,
      agent: 'matching',
      service: service || 'inne',
      urgency: normalizeUrgency(urgency),
      budget: budget || null,
      location: {
        text: userContext.location?.text || null,
        lat: null,
        lng: null,
        radiusKm: 10
      },
      criteria: {
        minRating: 4.0,
        availability: 'any',
        recommendedLevel: 'standard'
      },
      topProviders: [],
      notes: ['Nie udało się znaleźć wykonawców. Spróbuj ponownie później.']
    };
  }
}

function getRecommendedLevel(budget) {
  if (!budget || typeof budget !== 'object') return 'standard';
  
  const max = budget.max || Infinity;
  if (max < 200) return 'basic';
  if (max < 400) return 'standard';
  return 'pro';
}

function normalizeProviderLevel(value = '') {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('pro') || raw.includes('premium') || raw.includes('business')) return 'pro';
  if (raw.includes('standard')) return 'standard';
  return raw || 'basic';
}

function calculateFitScore({ rating, distance, availability, level, recommendedLevel, urgency, completedOrders = 0, successRate = null, baseRankingScore = null, isPro = false }) {
  let score = 0.35; // Base score

  // Rating (0-0.22)
  score += (Math.min(Number(rating) || 0, 5) / 5.0) * 0.22;

  // Distance (0-0.18)
  if (distance === null || distance === undefined || Number(distance) === 0) score += 0.08;
  else if (distance < 5) score += 0.18;
  else if (distance < 10) score += 0.12;
  else if (distance < 20) score += 0.06;

  // Availability (0-0.18)
  if (availability && urgency === 'urgent') score += 0.18;
  else if (availability) score += 0.1;

  // Level match (0-0.14)
  if (level === recommendedLevel) score += 0.14;
  else if (recommendedLevel === 'standard' && level === 'pro') score += 0.1;
  else if (level === 'pro') score += 0.06;

  // PRO boost jest jakościowy i mały. Nie powinien przebić słabego dopasowania.
  if (isPro && (Number(rating) >= 4.2 || completedOrders >= 5 || successRate === null || successRate >= 60)) {
    score += 0.04;
  }

  // Track record (0-0.13)
  if (completedOrders >= 20) score += 0.08;
  else if (completedOrders >= 5) score += 0.05;
  if (successRate !== null && successRate >= 80) score += 0.05;

  // Existing ranking signal from recommendProviders (0-0.1)
  if (baseRankingScore !== null) {
    score += Math.min(Math.max(Number(baseRankingScore) || 0, 0), 100) / 1000;
  }

  return Math.min(1.0, Math.max(0.0, score));
}

function buildMatchExplanation({ provider, service, urgency, rating, distance, isAvailable, providerLevel, recommendedLevel, completedOrders, successRate, fitScore }) {
  const percent = Math.round(fitScore * 100);
  const reasons = [];
  const highlights = [];

  reasons.push(`Pasuje do usługi: ${humanizeService(service)}`);
  highlights.push({ type: 'service', label: 'Usługa', detail: humanizeService(service) });

  if (rating >= 4.7) {
    reasons.push(`Bardzo wysoka ocena ${rating.toFixed(1)}/5`);
    highlights.push({ type: 'rating', label: 'Ocena', detail: `${rating.toFixed(1)}/5` });
  } else if (rating >= 4.2) {
    reasons.push(`Dobra ocena ${rating.toFixed(1)}/5`);
    highlights.push({ type: 'rating', label: 'Ocena', detail: `${rating.toFixed(1)}/5` });
  }

  if (distance && distance < 5) {
    reasons.push(`Bardzo blisko klienta (${distance.toFixed(1)} km)`);
    highlights.push({ type: 'distance', label: 'Blisko', detail: `${distance.toFixed(1)} km` });
  } else if (distance && distance < 12) {
    reasons.push(`W rozsądnej odległości (${distance.toFixed(1)} km)`);
    highlights.push({ type: 'distance', label: 'Dystans', detail: `${distance.toFixed(1)} km` });
  }

  if (isAvailable && urgency === 'urgent') {
    reasons.push('Dostępny teraz przy pilnym problemie');
    highlights.push({ type: 'availability', label: 'Dostępność', detail: 'teraz' });
  } else if (isAvailable) {
    reasons.push('Aktualnie dostępny');
    highlights.push({ type: 'availability', label: 'Dostępność', detail: 'online' });
  }

  if (providerLevel === recommendedLevel) {
    reasons.push(`Poziom ${recommendedLevel} pasuje do zakresu zlecenia`);
  } else if (providerLevel === 'pro') {
    reasons.push('Wykonawca PRO dla bardziej wymagających zleceń');
  }

  if (completedOrders >= 20) {
    reasons.push(`Duże doświadczenie: ${completedOrders} zakończonych zleceń`);
    highlights.push({ type: 'experience', label: 'Doświadczenie', detail: `${completedOrders} zleceń` });
  } else if (completedOrders >= 5) {
    reasons.push(`${completedOrders} zakończonych zleceń w historii`);
  }

  if (successRate >= 80) {
    reasons.push(`Wysoka skuteczność realizacji (${successRate}%)`);
  }

  if (provider.verified) {
    reasons.push('Zweryfikowany wykonawca');
  }

  const level = percent >= 90 ? 'excellent' : percent >= 80 ? 'strong' : percent >= 65 ? 'good' : 'basic';
  const label = {
    excellent: 'Najlepsze dopasowanie',
    strong: 'Bardzo dobre dopasowanie',
    good: 'Dobre dopasowanie',
    basic: 'Podstawowe dopasowanie'
  }[level];

  return {
    percent,
    level,
    label,
    reasons: reasons.slice(0, 5),
    highlights: highlights.slice(0, 4),
    summary: `${percent}% dopasowania: ${reasons.slice(0, 3).join(', ')}.`,
    nextBestAction: urgency === 'urgent' && isAvailable
      ? 'Wyślij pilne zapytanie'
      : 'Poproś o wycenę'
  };
}

function humanizeService(service = '') {
  const labels = {
    'agd-rtv-naprawa-agd': 'naprawa AGD',
    'agd-rtv-naprawa-rtv': 'naprawa RTV',
    hydraulik_naprawa: 'hydraulik',
    elektryk_naprawa: 'elektryk',
    zlota_raczka: 'złota rączka',
    sprzatanie: 'sprzątanie',
    remont: 'remont'
  };
  return labels[service] || String(service || 'wybrana usługa').replace(/[-_]/g, ' ');
}

module.exports = {
  runMatchingAgent,
  calculateFitScore
};

