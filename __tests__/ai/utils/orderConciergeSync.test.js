const {
  enrichConciergeWithOrderDraft,
  wantsToCreateOrder,
  normalizeAttachmentsFromUrls
} = require('../../../ai/utils/orderConciergeSync');

describe('orderConciergeSync', () => {
  it('detects user intent to create order', () => {
    expect(wantsToCreateOrder('Chcę wystawić zlecenie')).toBe(true);
    expect(wantsToCreateOrder('cieknie kran')).toBe(false);
  });

  it('promotes create_order when draft is complete', () => {
    const concierge = { reply: 'OK', nextStep: 'ask_more' };
    const draft = { ok: true, canCreate: true, missing: [] };
    enrichConciergeWithOrderDraft(concierge, draft);
    expect(concierge.nextStep).toBe('create_order');
    expect(concierge.reply).toMatch(/utworzenie zlecenia|komplet danych/i);
  });

  it('asks for missing fields when user wants order', () => {
    const concierge = { reply: 'Rozumiem.', nextStep: 'suggest_providers' };
    const draft = {
      ok: true,
      canCreate: false,
      missing: ['lokalizacja'],
      nextQuestion: 'W jakiej lokalizacji potrzebujesz pomocy?'
    };
    enrichConciergeWithOrderDraft(concierge, draft, { lastUserText: 'wystaw zlecenie' });
    expect(concierge.nextStep).toBe('ask_more');
    expect(concierge.questions[0]).toMatch(/lokalizac/i);
  });

  it('normalizes image urls to attachments', () => {
    const att = normalizeAttachmentsFromUrls(['https://cdn.example.com/a.jpg']);
    expect(att[0].url).toContain('a.jpg');
    expect(att[0].mimeType).toBe('image/jpeg');
  });
});
