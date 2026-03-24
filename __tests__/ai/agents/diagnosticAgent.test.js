/**
 * Testy jednostkowe dla Agent Diagnostyczny
 */

const { runDiagnosticAgent } = require('../../../ai/agents/diagnosticAgent');

describe('Diagnostic Agent', () => {
  test('powinien wykryć wysokie ryzyko dla gazu', async () => {
    const result = await runDiagnosticAgent({
      messages: [
        { role: 'user', content: 'Czuję zapach gazu w kuchni' }
      ],
      detectedService: 'hydraulik',
      userContext: {}
    });

    expect(result).toBeDefined();
    expect(result.risk).toBe('high');
    expect(result.urgency).toBe('urgent');
    expect(result.safety.flag).toBe(true);
    expect(result.immediateActions.length).toBeGreaterThan(0);
  });

  test('powinien wykryć wysokie ryzyko dla prądu', async () => {
    const result = await runDiagnosticAgent({
      messages: [
        { role: 'user', content: 'Iskrzenie w gniazdku, czuję zapach spalenizny' }
      ],
      detectedService: 'elektryk',
      userContext: {}
    });

    expect(result).toBeDefined();
    expect(result.risk).toBe('high');
    expect(result.urgency).toBe('urgent');
    expect(result.safety.flag).toBe(true);
  });

  test('powinien zasugerować DIY dla prostych problemów', async () => {
    const result = await runDiagnosticAgent({
      messages: [
        { role: 'user', content: 'Luźny kran, trochę kapie' }
      ],
      detectedService: 'hydraulik',
      userContext: {}
    });

    expect(result).toBeDefined();
    expect(result.risk).toBe('none');
    expect(['diy', 'provider']).toContain(result.recommendedPath);
  });

  test('powinien zasugerować express dla pilnych sytuacji', async () => {
    const result = await runDiagnosticAgent({
      messages: [
        { role: 'user', content: 'Zalewa mnie woda, potrzebuję pomocy teraz!' }
      ],
      detectedService: 'hydraulik',
      userContext: {}
    });

    expect(result).toBeDefined();
    expect(result.urgency).toBe('urgent');
    expect(['express', 'provider']).toContain(result.recommendedPath);
  });

  test('powinien zwrócić immediateActions dla niebezpiecznych sytuacji', async () => {
    const result = await runDiagnosticAgent({
      messages: [
        { role: 'user', content: 'Wyciek gazu w mieszkaniu' }
      ],
      detectedService: 'hydraulik',
      userContext: {}
    });

    expect(result.immediateActions.length).toBeGreaterThan(0);
    expect(result.immediateActions.length).toBeLessThanOrEqual(4);
  });

  test('powinien zwrócić recommendedPath', async () => {
    const result = await runDiagnosticAgent({
      messages: [
        { role: 'user', content: 'Potrzebuję hydraulika' }
      ],
      detectedService: 'hydraulik',
      userContext: {}
    });

    expect(['express', 'provider', 'diy', 'teleconsult']).toContain(result.recommendedPath);
  });
});

