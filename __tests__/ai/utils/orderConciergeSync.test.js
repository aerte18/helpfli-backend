const {
  enrichConciergeWithOrderDraft,
  computeUiPhase,
  computeConversationStep,
  wantsToCreateOrder,
  detectChosenPathFromText,
  enrichConciergeWithMatching,
  buildConversationSummary,
  cleanDescriptionText,
  applyDisplayFieldsToDraft
} = require('../../../ai/utils/orderConciergeSync');

describe('orderConciergeSync phased flow', () => {
  it('stays in clarify when missing details', () => {
    const concierge = { reply: 'Jaki kod błędu?', nextStep: 'suggest_providers', questions: ['kod?'] };
    const draft = {
      ok: true,
      canCreate: false,
      missing: ['szczegóły (marka, objawy lub kod błędu)'],
      nextQuestion: 'Jaki objaw widzisz?'
    };
    enrichConciergeWithOrderDraft(concierge, draft, { lastUserText: 'pralka nie działa', userMessageCount: 1 });
    expect(concierge.nextStep).toBe('ask_more');
    expect(concierge.questions).toHaveLength(1);
    expect(concierge.reply).not.toMatch(/komplet danych/i);
    expect(computeUiPhase({ concierge, draft, lastUserText: '', userMessageCount: 1 })).toBe('clarify');
    expect(computeConversationStep('clarify').step).toBe(1);
  });

  it('offers choices after enough context with summary', () => {
    const concierge = { reply: 'Rozumiem problem.', nextStep: 'ask_more', detectedService: 'agd' };
    const draft = {
      ok: true,
      canCreate: true,
      missing: [],
      summary: { service: 'agd', description: 'Pralka Beko E20', location: 'Warszawa' }
    };
    enrichConciergeWithOrderDraft(concierge, draft, { lastUserText: 'beko e20 warszawa', userMessageCount: 3 });
    expect(concierge.nextStep).toBe('offer_choices');
    expect(concierge.conversationSummary).toMatch(/rozumiem/i);
    expect(computeUiPhase({ concierge, draft, lastUserText: '', userMessageCount: 3 })).toBe('choose_action');
    expect(computeConversationStep('choose_action').step).toBe(2);
  });

  it('switches to create_order when user chose order path', () => {
    const concierge = { reply: 'OK', nextStep: 'offer_choices' };
    const draft = { ok: true, canCreate: true, missing: [] };
    enrichConciergeWithOrderDraft(concierge, draft, {
      lastUserText: 'Chcę utworzyć zlecenie',
      userMessageCount: 3,
      chosenPath: 'order'
    });
    expect(concierge.nextStep).toBe('create_order');
    expect(computeUiPhase({
      concierge,
      draft,
      lastUserText: 'utworzyć zlecenie',
      userMessageCount: 3,
      chosenPath: 'order'
    })).toBe('create_order');
    expect(wantsToCreateOrder('wystaw zlecenie')).toBe(true);
    expect(detectChosenPathFromText('Pokaż wykonawców')).toBe('providers');
  });

  it('overrides stored diy path when user asks to find providers', () => {
    expect(detectChosenPathFromText('znajdź proszę', 'diy')).toBe('providers');
    expect(detectChosenPathFromText('i jak masz?', 'diy')).toBe('providers');
    expect(detectChosenPathFromText('ok', 'providers')).toBe('providers');
  });

  it('replaces searching fluff with matching summary', () => {
    const concierge = { reply: 'Szukam hydraulików. Zaraz będą wyniki.' };
    enrichConciergeWithMatching(concierge, {
      topProviders: [{ name: 'Jan K.' }, { name: 'Piotr M.' }]
    });
    expect(concierge.reply).toMatch(/znalazłem/i);
    expect(concierge.reply).not.toMatch(/zaraz będą wyniki/i);
  });

  it('cleans description and location for display', () => {
    const cleaned = cleanDescriptionText('Awaria [Moja lokalizacja: GPS]');
    expect(cleaned).not.toMatch(/lokalizacja/i);
    const summary = buildConversationSummary(
      { summary: { service: 'hydraulik', description: 'Kran', location: 'aktualna lokalizacja klienta' } },
      { fallbackLocation: 'Kraków, ul. Testowa 1' }
    );
    expect(summary).toMatch(/kraków/i);
    const draft = applyDisplayFieldsToDraft(
      { orderPayload: { description: 'Test [Moja lokalizacja: x]', location: 'aktualna lokalizacja klienta' }, summary: {} },
      'Kraków'
    );
    expect(draft.orderPayload.description).toBe('Test');
    expect(draft.summary.location).toMatch(/kraków|gps/i);
  });
});
