const { analyzeOrderGaps, detectServiceFamily } = require('../../../ai/utils/orderGapAnalyzer');

describe('orderGapAnalyzer', () => {
  it('detects AGD family', () => {
    expect(detectServiceFamily('agd-rtv-naprawa-agd', 'pralka nie wiruje')).toBe('agd');
  });

  it('requires brand and term in strict order mode for AGD', () => {
    const result = analyzeOrderGaps({
      messages: [{ role: 'user', content: 'Pralka nie działa, potrzebuję fachowca w Warszawie' }],
      orderPayload: {
        service: 'agd-rtv-naprawa-agd',
        description: 'Pralka nie działa',
        location: 'Warszawa'
      },
      extracted: {},
      detectedService: 'agd-rtv-naprawa-agd',
      chosenPath: 'order',
      lastUserText: 'Chcę utworzyć zlecenie'
    });

    expect(result.strictMode).toBe(true);
    expect(result.missingLabels).toEqual(
      expect.arrayContaining(['marka i model', 'termin wizyty'])
    );
    expect(result.nextGap?.field).toBeDefined();
  });

  it('passes when AGD details and term are present', () => {
    const result = analyzeOrderGaps({
      messages: [
        {
          role: 'user',
          content: 'Pralka Beko E20 pokazuje kod E20, nie wiruje. Warszawa, może być jutro.'
        }
      ],
      orderPayload: {
        service: 'agd-rtv-naprawa-agd',
        description: 'Pralka Beko E20 kod E20 nie wiruje',
        location: 'Warszawa',
        preferredTime: 'jutro'
      },
      extracted: { timeWindow: 'jutro', brand: 'Beko' },
      detectedService: 'agd-rtv-naprawa-agd',
      chosenPath: 'order',
      lastUserText: 'utwórz zlecenie'
    });

    expect(result.blockers.length).toBe(0);
    expect(result.filled.length).toBeGreaterThan(0);
  });
});
