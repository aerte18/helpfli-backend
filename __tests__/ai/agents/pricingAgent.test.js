/**
 * Testy jednostkowe dla Agent Kosztowy
 */

const { runPricingAgent } = require('../../../ai/agents/pricingAgent');

describe('Pricing Agent', () => {
  test('powinien zwrócić widełki cenowe dla wszystkich poziomów', async () => {
    const result = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      userContext: { location: { text: 'Warszawa' } },
      budget: null
    });

    expect(result).toBeDefined();
    expect(result.ranges).toBeDefined();
    expect(result.ranges.basic).toBeDefined();
    expect(result.ranges.standard).toBeDefined();
    expect(result.ranges.pro).toBeDefined();
    
    expect(typeof result.ranges.basic.min).toBe('number');
    expect(typeof result.ranges.basic.max).toBe('number');
    expect(result.ranges.basic.min).toBeLessThan(result.ranges.basic.max);
  });

  test('powinien uwzględnić pilność (urgent = wyższe ceny)', async () => {
    const standardResult = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      userContext: { location: { text: 'Warszawa' } }
    });

    const urgentResult = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'urgent',
      userContext: { location: { text: 'Warszawa' } }
    });

    expect(urgentResult.ranges.basic.min).toBeGreaterThanOrEqual(standardResult.ranges.basic.min);
    expect(urgentResult.expressFee).toBeDefined();
    expect(standardResult.expressFee).toBeNull();
  });

  test('powinien zwrócić expressFee dla urgent', async () => {
    const result = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'urgent',
      userContext: {}
    });

    expect(result.expressFee).toBeDefined();
    expect(result.expressFee.min).toBeGreaterThan(0);
    expect(result.expressFee.max).toBeGreaterThan(result.expressFee.min);
  });

  test('powinien zwrócić priceDrivers', async () => {
    const result = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      userContext: { location: { text: 'Warszawa' } }
    });

    expect(result.priceDrivers).toBeDefined();
    expect(Array.isArray(result.priceDrivers)).toBe(true);
    expect(result.priceDrivers.length).toBeGreaterThan(0);
  });

  test('powinien zwrócić whatYouGet dla każdego poziomu', async () => {
    const result = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      userContext: {}
    });

    expect(result.ranges.basic.whatYouGet).toBeDefined();
    expect(Array.isArray(result.ranges.basic.whatYouGet)).toBe(true);
    expect(result.ranges.basic.whatYouGet.length).toBeGreaterThan(0);
  });

  test('powinien zwrócić currency PLN', async () => {
    const result = await runPricingAgent({
      service: 'hydraulik',
      urgency: 'standard',
      userContext: {}
    });

    expect(result.currency).toBe('PLN');
  });
});

