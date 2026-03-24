/**
 * Testy jednostkowe dla Agent Concierge (Orchestrator)
 */

const { runConciergeAgent } = require('../../../ai/agents/conciergeAgent');

describe('Concierge Agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('powinien zwrócić odpowiedź dla podstawowego problemu', async () => {
    const result = await runConciergeAgent({
      messages: [
        { role: 'user', content: 'Cieknie mi kran w kuchni' }
      ],
      userContext: { location: { text: 'Warszawa' } },
      allowedServicesHint: []
    });

    expect(result).toBeDefined();
    expect(result.ok).toBeDefined();
    expect(result.nextStep).toBeDefined();
    expect(['ask_more', 'suggest_diy', 'suggest_providers', 'show_pricing']).toContain(result.nextStep);
  });

  test('powinien wykryć kategorię usługi', async () => {
    const result = await runConciergeAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję hydraulika, cieknie kran' }
      ],
      userContext: {},
      allowedServicesHint: []
    });

    expect(result.detectedService).toBeDefined();
    expect(typeof result.detectedService).toBe('string');
  });

  test('powinien określić pilność', async () => {
    const result = await runConciergeAgent({
      messages: [
        { role: 'user', content: 'PILNE! Zalewa mnie woda, potrzebuję hydraulika teraz!' }
      ],
      userContext: {},
      allowedServicesHint: []
    });

    expect(result.urgency).toBeDefined();
    expect(['low', 'standard', 'urgent']).toContain(result.urgency);
  });

  test('powinien zwrócić fallback response przy błędzie', async () => {
    // Symuluj błąd przez przekazanie nieprawidłowych danych
    const result = await runConciergeAgent({
      messages: null, // Nieprawidłowe dane
      userContext: {},
      allowedServicesHint: []
    });

    expect(result).toBeDefined();
    expect(result.ok).toBeDefined();
  });

  test('powinien wyekstraktować lokalizację z kontekstu', async () => {
    const result = await runConciergeAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję hydraulika' }
      ],
      userContext: { location: { text: 'Kraków', lat: 50.0647, lng: 19.9450 } },
      allowedServicesHint: []
    });

    expect(result.extracted).toBeDefined();
    expect(result.extracted?.location).toBeDefined();
  });
});

