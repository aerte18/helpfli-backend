/**
 * Testy jednostkowe dla Agent DIY
 */

const { runDIYAgent } = require('../../../ai/agents/diyAgent');

describe('DIY Agent', () => {
  test('powinien zwrócić kroki DIY dla prostych problemów', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Cieknie kran w kuchni' }
      ]
    });

    expect(result).toBeDefined();
    expect(result.steps).toBeDefined();
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.length).toBeLessThanOrEqual(10);
  });

  test('powinien zwrócić difficulty', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Cieknie kran' }
      ]
    });

    expect(['easy', 'medium', 'hard']).toContain(result.difficulty);
  });

  test('powinien zwrócić estimatedTimeMinutes', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Cieknie kran' }
      ]
    });

    expect(typeof result.estimatedTimeMinutes).toBe('number');
    expect(result.estimatedTimeMinutes).toBeGreaterThan(0);
  });

  test('powinien zwrócić tools', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Cieknie kran' }
      ]
    });

    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
  });

  test('powinien zwrócić stopConditions', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Cieknie kran' }
      ]
    });

    expect(result.stopConditions).toBeDefined();
    expect(Array.isArray(result.stopConditions)).toBe(true);
    expect(result.stopConditions.length).toBeGreaterThan(0);
  });

  test('powinien ustawić safety.flag=true dla niebezpiecznych sytuacji', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Czuję zapach gazu' }
      ]
    });

    expect(result.safety.flag).toBe(true);
    expect(result.steps.length).toBe(0); // Nie daj kroków DIY dla niebezpiecznych
  });

  test('powinien zwrócić fallback recommendation', async () => {
    const result = await runDIYAgent({
      service: 'hydraulik',
      messages: [
        { role: 'user', content: 'Cieknie kran' }
      ]
    });

    expect(result.fallback).toBeDefined();
    expect(typeof result.fallback.recommendProvider).toBe('boolean');
  });
});

