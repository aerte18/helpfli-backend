/**
 * Setup file dla testów Fazy 2
 * Mockujemy problematyczne moduły
 */

// Mock concierge.js żeby uniknąć problemów z MongoDB aggregation syntax w Jest
jest.mock('../../utils/concierge', () => ({
  recommendProviders: jest.fn(() => Promise.resolve([
    { _id: '1', name: 'Test Provider', distanceKm: 5, avgRating: 4.5, providerTier: 'standard' }
  ])),
  computePriceHints: jest.fn(() => Promise.resolve({
    basic: { min: 100, max: 200 },
    standard: { min: 150, max: 300 },
    pro: { min: 250, max: 500 },
    multipliers: { total: 1.0 }
  })),
  getCityPricingMultiplier: jest.fn(() => ({ multiplier: 1.0 })),
  deriveSelfHelpSteps: jest.fn(() => []),
  suggestParts: jest.fn(() => [])
}));

