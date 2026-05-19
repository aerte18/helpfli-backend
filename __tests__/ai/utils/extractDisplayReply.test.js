const { extractDisplayReply, safeParseJSON } = require('../../../ai/utils/llmAdapter');

describe('extractDisplayReply', () => {
  test('zwraca zwykły tekst bez zmian', () => {
    expect(extractDisplayReply('Cześć, jak mogę pomóc?')).toBe('Cześć, jak mogę pomóc?');
  });

  test('wyciąga reply z obiektu JSON', () => {
    const raw = JSON.stringify({
      ok: true,
      agent: 'concierge',
      reply: 'Oto widełki cenowe dla naprawy pralki.',
      intent: 'pricing'
    });
    expect(extractDisplayReply(raw)).toBe('Oto widełki cenowe dla naprawy pralki.');
  });

  test('wyciąga reply z bloku markdown json', () => {
    const raw = '```json\n{"ok":true,"agent":"concierge","reply":"Znalazłem specjalistę."}\n```';
    expect(extractDisplayReply(raw)).toBe('Znalazłem specjalistę.');
  });

  test('safeParseJSON parsuje markdown json', () => {
    const raw = '```json\n{"reply":"test"}\n```';
    expect(safeParseJSON(raw)?.reply).toBe('test');
  });
});
