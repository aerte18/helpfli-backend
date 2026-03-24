/**
 * Testy jednostkowe dla Agent Matching
 */

const { runMatchingAgent } = require('../../../ai/agents/matchingAgent');

// Mock recommendProviders
jest.mock('../../../utils/concierge', () => ({
  recommendProviders: jest.fn(),
  computePriceHints: jest.fn()
}));

const { recommendProviders } = require('../../../utils/concierge');

describe('Matching Agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('powinien zwrócić strukturę odpowiedzi', async () => {
    recommendProviders.mockResolvedValue([]);

    const result = await runMatchingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      budget: null,
      userContext: { location: { text: 'Warszawa' } }
    });

    expect(result).toBeDefined();
    expect(result.ok).toBeDefined();
    expect(result.service).toBe('hydraulik');
    expect(result.urgency).toBeDefined();
    expect(result.location).toBeDefined();
    expect(result.criteria).toBeDefined();
    expect(result.topProviders).toBeDefined();
    expect(Array.isArray(result.topProviders)).toBe(true);
  });

  test('powinien zwrócić kryteria matchingu', async () => {
    recommendProviders.mockResolvedValue([]);

    const result = await runMatchingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      budget: null,
      userContext: {}
    });

    expect(result.criteria).toBeDefined();
    expect(result.criteria.minRating).toBeDefined();
    expect(typeof result.criteria.minRating).toBe('number');
    expect(['now', 'today', 'any']).toContain(result.criteria.availability);
    expect(['basic', 'standard', 'pro']).toContain(result.criteria.recommendedLevel);
  });

  test('powinien zwrócić TOP providerów', async () => {
    const mockProviders = [
      {
        _id: 'provider1',
        name: 'Test Provider 1',
        rating: 4.5,
        distanceKm: 2.5,
        level: 'standard',
        verified: true
      },
      {
        _id: 'provider2',
        name: 'Test Provider 2',
        rating: 4.8,
        distanceKm: 5.0,
        level: 'pro',
        verified: true
      }
    ];

    recommendProviders.mockResolvedValue(mockProviders);

    const result = await runMatchingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      budget: null,
      userContext: { location: { text: 'Warszawa' } }
    });

    expect(result.topProviders.length).toBe(2);
    expect(result.topProviders[0].providerId).toBe('provider1');
    expect(result.topProviders[0].name).toBe('Test Provider 1');
    expect(result.topProviders[0].rating).toBe(4.5);
    expect(result.topProviders[0].fitScore).toBeDefined();
  });

  test('powinien obliczyć fitScore', async () => {
    const mockProviders = [
      {
        _id: 'provider1',
        name: 'Test Provider',
        rating: 5.0,
        distanceKm: 1.0,
        level: 'standard',
        availableNow: true,
        verified: true
      }
    ];

    recommendProviders.mockResolvedValue(mockProviders);

    const result = await runMatchingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      budget: null,
      userContext: { location: { text: 'Warszawa' } }
    });

    expect(result.topProviders[0].fitScore).toBeDefined();
    expect(result.topProviders[0].fitScore).toBeGreaterThanOrEqual(0);
    expect(result.topProviders[0].fitScore).toBeLessThanOrEqual(1);
  });

  test('powinien zwrócić reason dla każdego providera', async () => {
    const mockProviders = [
      {
        _id: 'provider1',
        name: 'Test Provider',
        rating: 4.5,
        distanceKm: 2.0,
        level: 'standard',
        verified: true
      }
    ];

    recommendProviders.mockResolvedValue(mockProviders);

    const result = await runMatchingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      budget: null,
      userContext: {}
    });

    expect(result.topProviders[0].reason).toBeDefined();
    expect(Array.isArray(result.topProviders[0].reason)).toBe(true);
  });

  test('powinien obsłużyć brak providerów', async () => {
    recommendProviders.mockResolvedValue([]);

    const result = await runMatchingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      budget: null,
      userContext: {}
    });

    expect(result.topProviders.length).toBe(0);
    expect(result.notes).toBeDefined();
  });
});

