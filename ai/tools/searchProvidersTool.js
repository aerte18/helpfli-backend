/**
 * Tool: searchProviders
 * Wyszukuje wykonawców dla określonej usługi i lokalizacji
 */

const { recommendProviders } = require('../../utils/concierge');

async function searchProvidersTool(params, context) {
  try {
    const { service, location, lat = null, lng = null, limit = 5 } = params;

    if (!service) {
      throw new Error('Service is required');
    }

    // Użyj funkcji recommendProviders z utils/concierge.js
    const providers = await recommendProviders(
      service,
      lat,
      lng,
      limit,
      'standard' // urgency - można później dodać jako parametr
    );

    return {
      success: true,
      providers: providers.map(p => ({
        id: p._id.toString(),
        name: p.name,
        rating: p.avgRating || 0,
        distanceKm: p.distanceKm || null,
        level: p.providerTier || 'standard',
        verified: p.verified || false,
        reason: p.reason || []
      })),
      count: providers.length,
      message: `Znaleziono ${providers.length} wykonawców`
    };

  } catch (error) {
    console.error('searchProvidersTool error:', error);
    throw new Error(`Failed to search providers: ${error.message}`);
  }
}

module.exports = searchProvidersTool;

