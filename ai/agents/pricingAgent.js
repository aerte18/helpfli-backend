/**
 * Agent Kosztowy
 * Widełki cenowe Basic/Standard/Pro + warianty + uzasadnienie
 */

const { PRICING_SYSTEM } = require('../prompts/pricingPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');
const { validatePricingResponse } = require('../schemas/conciergeSchemas');
const { normalizeUrgency } = require('../utils/normalize');
const { computePriceHints, getCityPricingMultiplier } = require('../../utils/concierge');

/**
 * Główna funkcja agenta Kosztowego
 * @param {Object} params
 * @param {string} params.service - Kategoria usługi
 * @param {string} params.urgency - Pilność (low/standard/urgent)
 * @param {Object} params.userContext - Kontekst użytkownika (location, etc.)
 * @param {Object} params.budget - Opcjonalny budżet użytkownika
 * @returns {Promise<Object>} Response agenta
 */
async function runPricingAgent({ service, urgency = 'standard', userContext = {}, budget = null }) {
  try {
    const locationText = userContext.location?.text || userContext.location || '';
    
    // Pobierz mnożnik cenowy dla lokalizacji
    const cityMultiplier = locationText ? getCityPricingMultiplier(locationText) : null;
    const multiplier = cityMultiplier?.multiplier || 1.0;
    
    let ranges = null;
    
    // Oblicz widełki cenowe (użyj istniejącej funkcji z concierge utils)
      // Sprawdź cache przed obliczaniem
      const CacheService = require('../services/CacheService');
      const cacheKey = `${service}_${locationText || 'default'}`;
      
      let priceHints = await CacheService.getPriceHints(service, locationText || 'default');
      
      if (!priceHints) {
        try {
          priceHints = await computePriceHints(service, {
            text: locationText,
            lat: userContext.location?.lat || null,
            lon: userContext.location?.lng || null
          });
          
          // Zapisz w cache (1 godzina)
          if (priceHints) {
            await CacheService.setPriceHints(service, locationText || 'default', priceHints, 3600);
          }
        } catch (error) {
          console.warn('Could not compute price hints:', error.message);
        }
      }
      
      // Jeśli mamy priceHints z funkcji, użyj ich
      if (priceHints && priceHints.basic) {
        ranges = {
          basic: {
            min: priceHints.basic.min,
            max: priceHints.basic.max,
            whatYouGet: [
              'Podstawowa naprawa',
              'Części podstawowe',
              'Gwarancja 30 dni'
            ]
          },
          standard: {
            min: priceHints.standard.min,
            max: priceHints.standard.max,
            whatYouGet: [
              'Naprawa z gwarancją',
              'Lepsze części',
              'Konsultacja i porada',
              'Gwarancja 90 dni'
            ]
          },
          pro: {
            min: priceHints.pro.min,
            max: priceHints.pro.max,
            whatYouGet: [
              'Pełna naprawa',
              'Najlepsze części',
              'Długa gwarancja',
              'Serwis i konserwacja'
            ]
          }
        };
        
        // Dostosuj do pilności - computePriceHints już uwzględnia czas/lokalizację, ale nie urgency
        if (urgency === 'urgent') {
          // Dodatkowo podnieś o 30% dla urgent (ekspresowa wizyta)
          Object.keys(ranges).forEach(level => {
            ranges[level].min = Math.round(ranges[level].min * 1.3 / 10) * 10;
            ranges[level].max = Math.round(ranges[level].max * 1.3 / 10) * 10;
          });
        }
      }
    } catch (error) {
      console.warn('Could not compute price hints:', error.message);
    }
    
    // Jeśli priceHints nie zostały użyte, użyj bazowych widełek
    if (!ranges) {
    
      // Bazowe widełki dla różnych kategorii (PLN)
      const baseRanges = getBaseRangesForService(service);
      
      // Dostosuj do lokalizacji
      const adjustedBasic = [
        Math.round(baseRanges.basic[0] * multiplier / 10) * 10,
        Math.round(baseRanges.basic[1] * multiplier / 10) * 10
      ];
      const adjustedStandard = [
        Math.round(baseRanges.standard[0] * multiplier / 10) * 10,
        Math.round(baseRanges.standard[1] * multiplier / 10) * 10
      ];
      const adjustedPro = [
        Math.round(baseRanges.pro[0] * multiplier / 10) * 10,
        Math.round(baseRanges.pro[1] * multiplier / 10) * 10
      ];
      
      // Dostosuj do pilności (urgent = +30%)
      const urgencyMultiplier = urgency === 'urgent' ? 1.3 : 1.0;
      
      ranges = {
        basic: {
          min: Math.round(adjustedBasic[0] * urgencyMultiplier / 10) * 10,
          max: Math.round(adjustedBasic[1] * urgencyMultiplier / 10) * 10,
          whatYouGet: [
            'Podstawowa naprawa',
            'Części podstawowe',
            'Gwarancja 30 dni'
          ]
        },
        standard: {
          min: Math.round(adjustedStandard[0] * urgencyMultiplier / 10) * 10,
          max: Math.round(adjustedStandard[1] * urgencyMultiplier / 10) * 10,
          whatYouGet: [
            'Naprawa z gwarancją',
            'Lepsze części',
            'Konsultacja i porada',
            'Gwarancja 90 dni'
          ]
        },
        pro: {
          min: Math.round(adjustedPro[0] * urgencyMultiplier / 10) * 10,
          max: Math.round(adjustedPro[1] * urgencyMultiplier / 10) * 10,
          whatYouGet: [
            'Pełna naprawa',
            'Najlepsze części',
            'Długa gwarancja',
            'Serwis i konserwacja'
          ]
        }
      };
    }
    
    // Express fee (tylko jeśli urgent)
    const expressFee = urgency === 'urgent' ? {
      min: 50,
      max: 150,
      note: 'Dopłata za pilną wizytę (dziś/jutro)'
    } : null;
    
    // Price drivers
    const priceDrivers = [];
    if (cityMultiplier && cityMultiplier.multiplier > 1.0) {
      priceDrivers.push(`Lokalizacja: ${cityMultiplier.city || locationText} (+${Math.round((cityMultiplier.multiplier - 1) * 100)}%)`);
    }
    if (urgency === 'urgent') {
      priceDrivers.push('Pilność: ekspresowa wizyta (+30%)');
    }
    priceDrivers.push('Złożoność: standardowa');
    priceDrivers.push('Części: w zależności od potrzeb');
    
    // Spróbuj użyć LLM do doprecyzowania (opcjonalnie)
    // Na razie zwracamy heurystyczne wyniki
    
    return {
      ok: true,
      agent: 'pricing',
      service: service || 'inne',
      urgency: normalizeUrgency(urgency),
      currency: 'PLN',
      ranges,
      expressFee,
      priceDrivers,
      assumptions: [
        'Cena za podstawową naprawę',
        'Części dodatkowo (jeśli potrzebne)',
        'Ceny orientacyjne, mogą się różnić'
      ],
      missing: [],
      questions: []
    };
    
  } catch (error) {
    console.error('Pricing Agent error:', error);
    
    // Fallback response
    return {
      ok: false,
      agent: 'pricing',
      service: service || 'inne',
      urgency: normalizeUrgency(urgency),
      currency: 'PLN',
      ranges: {
        basic: { min: 100, max: 200, whatYouGet: ['Podstawowa naprawa'] },
        standard: { min: 200, max: 400, whatYouGet: ['Naprawa z gwarancją'] },
        pro: { min: 400, max: 600, whatYouGet: ['Pełna naprawa'] }
      },
      expressFee: urgency === 'urgent' ? { min: 50, max: 150, note: 'Dopłata ekspresowa' } : null,
      priceDrivers: ['Ceny orientacyjne'],
      assumptions: ['Ceny mogą się różnić'],
      missing: [],
      questions: []
    };
  }
}

/**
 * Bazowe widełki cenowe dla kategorii usług (PLN)
 */
function getBaseRangesForService(service) {
  const serviceLower = (service || '').toLowerCase();
  
  // Hydraulika
  if (serviceLower.includes('hydraulik') || serviceLower.includes('woda')) {
    return {
      basic: [80, 150],
      standard: [150, 300],
      pro: [300, 500]
    };
  }
  
  // Elektryka
  if (serviceLower.includes('elektryk') || serviceLower.includes('prąd')) {
    return {
      basic: [100, 200],
      standard: [200, 400],
      pro: [400, 700]
    };
  }
  
  // Remont/budowa
  if (serviceLower.includes('remont') || serviceLower.includes('budowa')) {
    return {
      basic: [200, 500],
      standard: [500, 1000],
      pro: [1000, 2000]
    };
  }
  
  // Sprzątanie
  if (serviceLower.includes('sprzątanie') || serviceLower.includes('sprzatanie')) {
    return {
      basic: [80, 150],
      standard: [150, 250],
      pro: [250, 400]
    };
  }
  
  // Złota rączka / inne
  return {
    basic: [100, 200],
    standard: [200, 350],
    pro: [350, 600]
  };
}

module.exports = {
  runPricingAgent
};

