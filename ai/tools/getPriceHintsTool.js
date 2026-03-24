/**
 * Tool: getPriceHints
 * Pobiera widełki cenowe dla usługi w określonej lokalizacji
 */

const { computePriceHints } = require('../../utils/concierge');

async function getPriceHintsTool(params, context) {
  try {
    const { service, location, urgency = 'standard' } = params;

    if (!service) {
      throw new Error('Service is required');
    }

    // Użyj funkcji computePriceHints z utils/concierge.js
    const locationObj = typeof location === 'string' 
      ? { text: location, lat: null, lon: null }
      : location || { text: null, lat: null, lon: null };

    const priceHints = await computePriceHints(service, locationObj);

    if (!priceHints) {
      // Fallback widełki
      return {
        success: true,
        service,
        location: locationObj.text || 'standardowa',
        ranges: {
          basic: { min: 100, max: 200, currency: 'PLN' },
          standard: { min: 150, max: 300, currency: 'PLN' },
          pro: { min: 250, max: 500, currency: 'PLN' }
        },
        urgency,
        note: 'Szacunkowe widełki cenowe (sprawdź lokalne ceny)'
      };
    }

    // Dostosuj do urgency jeśli podano
    const urgencyMultiplier = urgency === 'urgent' ? 1.3 : 1.0;
    
    const ranges = {};
    if (priceHints.basic) {
      ranges.basic = {
        min: Math.round(priceHints.basic.min * urgencyMultiplier / 10) * 10,
        max: Math.round(priceHints.basic.max * urgencyMultiplier / 10) * 10,
        currency: 'PLN'
      };
    }
    if (priceHints.standard) {
      ranges.standard = {
        min: Math.round(priceHints.standard.min * urgencyMultiplier / 10) * 10,
        max: Math.round(priceHints.standard.max * urgencyMultiplier / 10) * 10,
        currency: 'PLN'
      };
    }
    if (priceHints.pro) {
      ranges.pro = {
        min: Math.round(priceHints.pro.min * urgencyMultiplier / 10) * 10,
        max: Math.round(priceHints.pro.max * urgencyMultiplier / 10) * 10,
        currency: 'PLN'
      };
    }

    return {
      success: true,
      service,
      location: locationObj.text || 'standardowa',
      ranges,
      urgency,
      note: 'Widełki cenowe na podstawie rynkowych danych'
    };

  } catch (error) {
    console.error('getPriceHintsTool error:', error);
    throw new Error(`Failed to get price hints: ${error.message}`);
  }
}

module.exports = getPriceHintsTool;

