/**
 * Testy jednostkowe dla Agent Order Draft
 */

const { runOrderDraftAgent } = require('../../../ai/agents/orderDraftAgent');

describe('Order Draft Agent', () => {
  test('powinien utworzyć orderPayload gdy wszystkie dane są dostępne', async () => {
    const result = await runOrderDraftAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję hydraulika w Warszawie, cieknie kran' }
      ],
      extracted: {
        location: { text: 'Warszawa' },
        budget: { min: 100, max: 200, currency: 'PLN' }
      },
      detectedService: 'hydraulik',
      urgency: 'standard'
    });

    expect(result.canCreate).toBe(true);
    expect(result.orderPayload).toBeDefined();
    expect(result.orderPayload.service).toBe('hydraulik');
    expect(result.orderPayload.description).toBeDefined();
    expect(result.orderPayload.location).toBe('Warszawa');
    expect(result.orderPayload.status).toBe('draft');
  });

  test('powinien zwrócić canCreate=false gdy brakuje danych', async () => {
    const result = await runOrderDraftAgent({
      messages: [],
      extracted: {},
      detectedService: null,
      urgency: 'standard'
    });

    expect(result.canCreate).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.questions.length).toBeGreaterThan(0);
  });

  test('powinien zwrócić missing dla brakujących pól', async () => {
    const result = await runOrderDraftAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję pomocy' }
      ],
      extracted: {},
      detectedService: null,
      urgency: 'standard'
    });

    expect(result.missing).toContain('kategoria usługi');
    expect(result.missing).toContain('lokalizacja');
  });

  test('powinien zwrócić questions gdy brakuje danych', async () => {
    const result = await runOrderDraftAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję pomocy' }
      ],
      extracted: {},
      detectedService: null,
      urgency: 'standard'
    });

    expect(Array.isArray(result.questions)).toBe(true);
    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.questions.length).toBeLessThanOrEqual(3);
  });

  test('powinien wyekstraktować description z messages', async () => {
    const result = await runOrderDraftAgent({
      messages: [
        { role: 'user', content: 'Cieknie mi kran w kuchni, potrzebuję hydraulika' }
      ],
      extracted: {
        location: { text: 'Warszawa' }
      },
      detectedService: 'hydraulik',
      urgency: 'standard'
    });

    expect(result.orderPayload.description.length).toBeGreaterThan(0);
    expect(result.orderPayload.description.length).toBeLessThanOrEqual(200);
  });

  test('powinien zwrócić orderPayload z urgency', async () => {
    const result = await runOrderDraftAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję hydraulika' }
      ],
      extracted: {
        location: { text: 'Warszawa' }
      },
      detectedService: 'hydraulik',
      urgency: 'urgent'
    });

    expect(result.orderPayload.urgency).toBe('urgent');
  });
});

