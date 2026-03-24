/**
 * Pricing Provider Agent
 * Pomoc z ceną dla providerów
 */

const { PRICING_PROVIDER_SYSTEM } = require('../prompts/pricingProviderPrompt');
const { computePriceHints } = require('../../utils/concierge');
const { normalizeUrgency } = require('../utils/normalize');

/**
 * Główna funkcja Pricing Provider Agent
 */
async function runPricingProviderAgent({ orderContext, providerInfo, marketData = null }) {
  try {
    const service = orderContext.service || 'inne';
    const location = orderContext.location?.city || orderContext.location || '';
    const urgency = normalizeUrgency(orderContext.urgency || 'standard');
    
    // Oblicz widełki cenowe rynku
    let priceHints = null;
    try {
      priceHints = await computePriceHints(service, {
        text: location,
        lat: orderContext.location?.lat || null,
        lon: orderContext.location?.lng || null
      });
    } catch (error) {
      console.warn('Could not compute price hints:', error.message);
    }
    
    // Określ poziom providera
    const providerLevel = providerInfo.level || providerInfo.providerTier || 'standard';
    const levelMultiplier = {
      'basic': 0.85,
      'standard': 1.0,
      'pro': 1.2
    };
    const multiplier = levelMultiplier[providerLevel] || 1.0;
    
    // Mnożnik pilności
    const urgencyMultiplier = urgency === 'urgent' ? 1.3 : 1.0;
    
    // Oblicz sugerowany zakres
    let suggestedRange = null;
    if (priceHints && priceHints.standard) {
      const baseMin = priceHints.standard.min * multiplier * urgencyMultiplier;
      const baseMax = priceHints.standard.max * multiplier * urgencyMultiplier;
      suggestedRange = {
        min: Math.round(baseMin / 10) * 10,
        max: Math.round(baseMax / 10) * 10,
        currency: 'PLN',
        recommended: Math.round((baseMin + baseMax) / 2 / 10) * 10
      };
    } else {
      suggestedRange = {
        min: 100,
        max: 300,
        currency: 'PLN',
        recommended: 200
      };
    }
    
    // Uzasadnienie
    const rationale = [];
    if (providerLevel === 'pro') {
      rationale.push('Wysoki poziom doświadczenia i jakości');
    }
    if (urgency === 'urgent') {
      rationale.push('Pilna realizacja - wyższa cena');
    }
    rationale.push(`Lokalizacja: ${location || 'standardowa'}`);
    rationale.push('Uwzględnienie kosztów materiałów i czasu');
    
    // Porównanie z rynkiem
    const marketAverage = priceHints?.standard ? (priceHints.standard.min + priceHints.standard.max) / 2 : suggestedRange.recommended;
    const yourPosition = suggestedRange.recommended < marketAverage * 0.9 ? 'below' :
                        suggestedRange.recommended > marketAverage * 1.1 ? 'above' : 'at';
    
    const marketComparison = {
      average: Math.round(marketAverage),
      range: priceHints?.standard || { min: suggestedRange.min, max: suggestedRange.max },
      yourPosition
    };
    
    // Czynniki
    const factors = {
      complexity: orderContext.description?.length > 200 ? 'high' : 'medium',
      urgency,
      location: location || 'standardowa',
      providerLevel
    };
    
    // Strategia cenowa
    const pricingStrategy = providerLevel === 'pro' ? 'premium' :
                           providerLevel === 'basic' ? 'budget' : 'competitive';
    
    // Wskazówki
    const tips = [];
    if (yourPosition === 'below') {
      tips.push('Twoja cena jest konkurencyjna - masz szansę wygrać zlecenie');
    } else if (yourPosition === 'above') {
      tips.push('Wyższa cena jest uzasadniona poziomem - podkreśl swoją wartość');
    }
    tips.push('Uwzględnij koszty materiałów i czasu');
    tips.push('Zaproponuj kilka opcji cenowych dla elastyczności');
    
    return {
      ok: true,
      agent: 'pricing_provider',
      suggestedRange,
      rationale: rationale.slice(0, 4),
      marketComparison,
      factors,
      pricingStrategy,
      tips: tips.slice(0, 3)
    };
    
  } catch (error) {
    console.error('Pricing Provider Agent error:', error);
    
    return {
      ok: false,
      agent: 'pricing_provider',
      suggestedRange: { min: 100, max: 300, currency: 'PLN', recommended: 200 },
      rationale: ['Sprawdź lokalne ceny rynkowe'],
      marketComparison: { average: 200, range: { min: 150, max: 250 }, yourPosition: 'at' },
      factors: { complexity: 'medium', urgency: 'standard', location: 'standardowa', providerLevel: 'standard' },
      pricingStrategy: 'competitive',
      tips: ['Sprawdź konkurencję w okolicy']
    };
  }
}

module.exports = {
  runPricingProviderAgent
};

