/**
 * Testy jednostkowe dla Agent Post-Order
 */

const { runPostOrderAgent } = require('../../../ai/agents/postOrderAgent');

describe('Post-Order Agent', () => {
  test('powinien zwrócić messageToClient dla completed order', async () => {
    const result = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'completed',
      paidInApp: true,
      rating: null
    });

    expect(result).toBeDefined();
    expect(result.messageToClient).toBeDefined();
    expect(typeof result.messageToClient).toBe('string');
    expect(result.messageToClient.length).toBeLessThanOrEqual(200);
  });

  test('powinien zwrócić ratingPrompt.ask=true dla completed bez oceny', async () => {
    const result = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'completed',
      paidInApp: true,
      rating: null
    });

    expect(result.ratingPrompt.ask).toBe(true);
    expect(result.ratingPrompt.text).toBeDefined();
  });

  test('powinien zwrócić ratingPrompt.ask=false gdy już jest ocena', async () => {
    const result = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'completed',
      paidInApp: true,
      rating: 5
    });

    expect(result.ratingPrompt.ask).toBe(false);
  });

  test('powinien zasugerować follow-up dla hydrauliki', async () => {
    const result = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'completed',
      paidInApp: true,
      rating: 5
    });

    expect(result.followUp.suggested).toBe(true);
    expect(result.followUp.service).toBe('hydraulik_konserwacja');
    expect(result.followUp.reason).toBeDefined();
  });

  test('powinien zwrócić follow-up.suggested=false dla cancelled', async () => {
    const result = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'cancelled',
      paidInApp: false,
      rating: null
    });

    expect(result.followUp.suggested).toBe(false);
  });

  test('powinien dostosować messageToClient do wyniku', async () => {
    const completedResult = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'completed',
      paidInApp: true,
      rating: 5
    });

    const cancelledResult = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'cancelled',
      paidInApp: false,
      rating: null
    });

    expect(completedResult.messageToClient).not.toBe(cancelledResult.messageToClient);
  });

  test('powinien obsłużyć wysoką ocenę', async () => {
    const result = await runPostOrderAgent({
      service: 'hydraulik',
      outcome: 'completed',
      paidInApp: true,
      rating: 5
    });

    expect(result.messageToClient).toContain('Dziękujemy');
  });
});

