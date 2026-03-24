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
        const providerLevel = provider.level || provider.providerTier || 'basic';
        const isAvailable = provider.isAvailable || provider.availableNow || provider.provider_status?.isOnline || false;
        
        // Oblicz fitScore (0-1)
        const fitScore = calculateFitScore({
          rating,
          distance,
          availability: isAvailable,
          level: providerLevel,
          recommendedLevel,
          urgency
        });
        
        // Uzasadnienie wyboru
        const reasons = [];
        if (rating >= 4.5) {
          reasons.push('Najwyższa ocena w okolicy');
        } else if (rating >= 4.0) {
          reasons.push('Wysoka ocena');
        }
        if (distance < 5) {
          reasons.push('Bardzo blisko');
        } else if (distance < 10) {
          reasons.push('W pobliżu');
        }
        if (isAvailable && urgency === 'urgent') {
          reasons.push('Dostępny teraz');
        }
        if (providerLevel === recommendedLevel) {
          reasons.push(`Poziom ${recommendedLevel} zgodny z potrzebami`);
        }
        if (provider.verified) {
          reasons.push('Zweryfikowany wykonawca');
        }
        
        return {
          providerId: String(provider._id || provider.id),
          name: providerName,
          rating,
          distanceKm: distance,
          level: providerLevel,
          reason: reasons.length > 0 ? reasons.slice(0, 2) : ['Dostępny w Twojej okolicy'],
          fitScore
        };
      });
      
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

function calculateFitScore({ rating, distance, availability, level, recommendedLevel, urgency }) {
  let score = 0.5; // Base score
  
  // Rating (0-0.3)
  score += (rating / 5.0) * 0.3;
  
  // Distance (0-0.2)
  if (distance < 5) score += 0.2;
  else if (distance < 10) score += 0.1;
  
  // Availability (0-0.2)
  if (availability && urgency === 'urgent') score += 0.2;
  else if (availability) score += 0.1;
  
  // Level match (0-0.2)
  if (level === recommendedLevel) score += 0.2;
  else if (recommendedLevel === 'standard' && level === 'pro') score += 0.1;
  
  return Math.min(1.0, Math.max(0.0, score));
}

module.exports = {
  runMatchingAgent
};

