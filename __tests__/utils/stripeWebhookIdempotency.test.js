const {
  stripeSourceDate,
  stripeEffectKey,
  mergeEffectMarker,
  applyStripeEffectOnce,
} = require('../../utils/stripeWebhookIdempotency');

describe('Stripe business-effect idempotency', () => {
  test('uses the Stripe source timestamp instead of retry wall clock', () => {
    expect(stripeSourceDate(
      { created: 1792411200 },
      { created: 1 },
      new Date('2030-01-01T00:00:00.000Z')
    )).toEqual(new Date(1792411200 * 1000));
  });

  test('builds stable keys from the business source, not the delivery event', () => {
    expect(stripeEffectKey('promotion_purchase', 'pi_123'))
      .toBe('promotion_purchase:pi_123');
    expect(() => stripeEffectKey('promotion_purchase', '')).toThrow(/required/i);
  });

  test('records marker in the same atomic update as the additive effect', async () => {
    const Model = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    await expect(applyStripeEffectOnce(
      Model,
      { _id: 'user-1' },
      'promotion_purchase:pi_123',
      { $inc: { rankingPoints: 40 } }
    )).resolves.toBe(true);

    expect(Model.updateOne).toHaveBeenCalledWith(
      {
        _id: 'user-1',
        stripeAppliedEffects: { $ne: 'promotion_purchase:pi_123' },
      },
      {
        $inc: { rankingPoints: 40 },
        $addToSet: { stripeAppliedEffects: 'promotion_purchase:pi_123' },
      },
      undefined
    );
  });

  test('does not silently merge conflicting marker updates', () => {
    expect(() => mergeEffectMarker(
      { $addToSet: { stripeAppliedEffects: 'other:key' } },
      'promotion_purchase:pi_123'
    )).toThrow(/conflicting/i);
  });
});
