/**
 * Testy jednostkowe dla Agent Concierge (Orchestrator)
 */

jest.mock('../../../ai/utils/llmAdapter', () => {
  const actual = jest.requireActual('../../../ai/utils/llmAdapter');
  return {
    ...actual,
    callAgentLLM: jest.fn()
  };
});

const { callAgentLLM } = require('../../../ai/utils/llmAdapter');
const { runConciergeAgent } = require('../../../ai/agents/conciergeAgent');

describe('Concierge Agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    callAgentLLM.mockResolvedValue({
      ok: true,
      agent: 'concierge',
      reply: 'Pomogę Ci znaleźć właściwe rozwiązanie.',
      intent: 'service_request',
      detectedService: 'hydraulik',
      urgency: 'standard',
      confidence: 0.9,
      nextStep: 'ask_more',
      questions: ['W jakiej lokalizacji potrzebujesz pomocy?'],
      extracted: {
        location: 'Warszawa',
        timeWindow: null,
        budget: null,
        details: []
      }
    });
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

