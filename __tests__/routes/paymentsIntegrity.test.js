const paymentsRouter = require('../../routes/payments');

const {
  acquireStripeEventLock,
  markStripeEventProcessed,
  handleAdditionalPaymentFailure,
  applyExternalCommissionOrderState,
  getExternalCommissionReadiness,
  getPlatformOwnedFeeAmount,
  normalizeFeeRate,
  resolveMainPaymentAmounts,
  getSystemPaymentReadiness,
  paymentIntentMatchesExpected,
  classifyRetryableIntent,
  upsertPaymentForIntent,
  paymentOrIntentHasRefund,
  classifyOneTimeCheckoutSettlement,
  authorizeOneTimeCheckoutFulfillment,
  verifyLegacyOrderCheckoutSettlement,
  normalizeStripeRefundEvent,
  refundAuditStatus,
  classifyStripeRefundResult,
  refundAuditMatchesRequest,
  recordAmbiguousRefundError,
  reconcilePaymentRefundAudit,
  requiresManualBenefitRefund,
  promotionPurchaseEffectKeys,
  buildPromotionRefundUserPipeline,
  reversePromotionPurchaseBenefit,
  resolveRefundRequest,
  resolvePaymentType,
  isPaymentOwnedByUser,
  isCanonicalMainEscrowIntent,
  isDestinationChargeBindingValid,
  orderHasPurchasedGuarantee,
  isContactUnlockBindingValid,
  applyCanonicalMainCancellation,
  applyOrderFundedFromStripeIntent,
  reconcileCapturableEscrowFromWebhook,
  applyAdditionalPaymentSuccess,
  claimPaymentSucceededFromWebhook,
  classifyPaymentReturnStatus,
  isCanonicalMainEscrowRefund,
  applyPaymentRefundToOrder,
  createPaymentIntentPreferLocalWallets,
} = paymentsRouter.__test;

function duplicateKeyError() {
  const error = new Error('duplicate key');
  error.code = 11000;
  return error;
}

function modelWithExisting(existing, overrides = {}) {
  return {
    create: jest.fn().mockRejectedValue(duplicateKeyError()),
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(existing),
    }),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    ...overrides,
  };
}

describe('Stripe webhook event lease', () => {
  const event = { id: 'evt_123', type: 'payment_intent.succeeded' };
  const now = new Date('2026-10-19T12:00:00.000Z');

  test('a new event is claimed as processing, not processed', async () => {
    const model = { create: jest.fn().mockResolvedValue({}) };

    const result = await acquireStripeEventLock(model, event, {
      now,
      lockToken: 'lock-new',
    });

    expect(result).toEqual({ acquired: true, lockToken: 'lock-new', recovered: false });
    expect(model.create).toHaveBeenCalledWith(expect.objectContaining({
      eventId: event.id,
      status: 'processing',
      processedAt: null,
      attempts: 1,
    }));
  });

  test('a processed or legacy event is acknowledged as a duplicate', async () => {
    const processed = modelWithExisting({ _id: 'row-1', status: 'processed' });
    const legacy = modelWithExisting({ _id: 'row-2' });

    await expect(acquireStripeEventLock(processed, event, { now }))
      .resolves.toEqual({ acquired: false, duplicate: true });
    await expect(acquireStripeEventLock(legacy, event, { now }))
      .resolves.toEqual({ acquired: false, duplicate: true });
  });

  test('a fresh concurrent lease is not executed twice', async () => {
    const model = modelWithExisting({
      _id: 'row-1',
      status: 'processing',
      lockedAt: new Date('2026-10-19T11:59:30.000Z'),
    });

    const result = await acquireStripeEventLock(model, event, {
      now,
      lockTimeoutMs: 60_000,
    });

    expect(result).toEqual({ acquired: false, inProgress: true });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each([
    ['failed', new Date('2026-10-19T11:59:50.000Z')],
    ['processing', new Date('2026-10-19T11:55:00.000Z')],
  ])('a %s event can be safely reclaimed', async (status, lockedAt) => {
    const model = modelWithExisting(
      { _id: 'row-1', status, lockedAt },
      { findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'row-1' }) }
    );

    const result = await acquireStripeEventLock(model, event, {
      now,
      lockTimeoutMs: 60_000,
      lockToken: 'lock-retry',
    });

    expect(result).toEqual({ acquired: true, lockToken: 'lock-retry', recovered: true });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'row-1', status }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'processing', lockToken: 'lock-retry' }),
        $inc: { attempts: 1 },
      }),
      { new: true }
    );
  });

  test('only the current lease token can finalize the event', async () => {
    const model = { updateOne: jest.fn().mockResolvedValue({ matchedCount: 0 }) };

    await expect(markStripeEventProcessed(model, event.id, 'stale-token'))
      .rejects.toThrow(/lock lost/i);
    expect(model.updateOne).toHaveBeenCalledWith(
      { eventId: event.id, status: 'processing', lockToken: 'stale-token' },
      expect.any(Object)
    );
  });
});

describe('payment state isolation and pricing', () => {
  test('failed additional payment changes only additional-payment state', async () => {
    const models = {
      Order: { updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) },
      Payment: { updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) },
    };
    const intent = {
      id: 'pi_additional',
      metadata: { orderId: 'order-1', type: 'additional_payment' },
    };

    await handleAdditionalPaymentFailure(intent, models);

    const orderUpdate = models.Order.updateOne.mock.calls[0][1].$set;
    expect(orderUpdate).toEqual({ additionalPaymentStatus: 'failed' });
    expect(orderUpdate).not.toHaveProperty('paymentStatus');
    expect(orderUpdate).not.toHaveProperty('paidInSystem');
    expect(orderUpdate).not.toHaveProperty('protectionStatus');
    expect(models.Payment.updateOne).toHaveBeenCalledWith(
      {
        stripePaymentIntentId: 'pi_additional',
        status: { $nin: ['succeeded', 'refunded', 'partial_refund'] },
      },
      { $set: { status: 'failed' } }
    );
  });

  test('destination charge retains both commission and guarantee fee', () => {
    const order = { pricing: { guaranteeFee: 7.25 } };
    expect(getPlatformOwnedFeeAmount(order, 500)).toBe(1225);
  });

  test('fee rates accept both percent points and fractional snapshots', () => {
    expect(normalizeFeeRate(5)).toBe(0.05);
    expect(normalizeFeeRate(0.07)).toBe(0.07);
    expect(Math.round(10_000 * normalizeFeeRate(5))).toBe(500);
  });

  test('main escrow retry matches amount, currency, order and type', () => {
    const expected = { amount: 12_300, orderId: 'order-1', type: 'order_escrow' };
    const intent = {
      amount: 12_300,
      currency: 'pln',
      metadata: { orderId: 'order-1', type: 'order_escrow' },
    };

    expect(paymentIntentMatchesExpected(intent, expected)).toBe(true);
    expect(paymentIntentMatchesExpected(
      { ...intent, amount: 12_301 },
      expected
    )).toBe(false);
    expect(paymentIntentMatchesExpected(
      { ...intent, metadata: { orderId: 'order-2', type: 'order_escrow' } },
      expected
    )).toBe(false);
    // Legacy main intents did not have metadata.type.
    expect(paymentIntentMatchesExpected(
      { ...intent, metadata: { orderId: 'order-1' } },
      expected
    )).toBe(true);
  });

  test('requires_action main escrow is reused and processing remains pending', () => {
    const expected = { amount: 12_300, orderId: 'order-1', type: 'order_escrow' };
    const base = {
      amount: 12_300,
      currency: 'pln',
      metadata: { orderId: 'order-1', type: 'order_escrow' },
      client_secret: 'pi_secret',
    };

    expect(classifyRetryableIntent(
      { ...base, status: 'requires_action' },
      expected
    )).toEqual({ kind: 'reusable' });
    expect(classifyRetryableIntent(
      { ...base, status: 'processing' },
      expected
    )).toEqual({ kind: 'busy' });
  });

  test('main escrow amount resolution is stable for retry matching', () => {
    expect(resolveMainPaymentAmounts({
      amountTotal: 12_000,
      platformFeeAmount: 500,
      pricing: { discountPoints: 3 },
    })).toEqual({
      amount: 12_000,
      platformFeeAmount: 500,
      pointsDiscount: 300,
      stripeAmount: 12_000,
    });
  });

  test('system service payments fail closed without Connect and provider payouts', () => {
    expect(getSystemPaymentReadiness({
      enabled: false,
      paysThroughHelpfli: true,
      provider: null,
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 503,
      code: 'STRIPE_CONNECT_DISABLED',
    }));

    expect(getSystemPaymentReadiness({
      enabled: true,
      paysThroughHelpfli: true,
      provider: {
        stripeAccountId: 'acct_1',
        stripeConnectStatus: { chargesEnabled: true, payoutsEnabled: false },
      },
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'PROVIDER_PAYOUTS_NOT_READY',
    }));

    expect(getSystemPaymentReadiness({
      enabled: true,
      paysThroughHelpfli: true,
      provider: {
        stripeAccountId: 'acct_1',
        stripeConnectStatus: { chargesEnabled: false, payoutsEnabled: true },
      },
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'PROVIDER_PAYOUTS_NOT_READY',
    }));

    expect(getSystemPaymentReadiness({
      enabled: true,
      paysThroughHelpfli: true,
      provider: {
        stripeAccountId: 'acct_1',
        stripeConnectStatus: { chargesEnabled: true, payoutsEnabled: true },
      },
    })).toEqual({ ok: true });
  });

  test('abandoned checkout can reuse only the matching active intent', () => {
    const base = {
      amount: 2400,
      currency: 'pln',
      metadata: { orderId: 'order-1', type: 'contact_unlock' },
      client_secret: 'secret',
    };
    expect(classifyRetryableIntent(
      { ...base, status: 'requires_payment_method' },
      { amount: 2400, orderId: 'order-1', type: 'contact_unlock' }
    )).toEqual({ kind: 'reusable' });
    expect(classifyRetryableIntent(
      { ...base, status: 'requires_payment_method', amount: 2500 },
      { amount: 2400, orderId: 'order-1', type: 'contact_unlock' }
    )).toEqual({ kind: 'terminal' });
    expect(classifyRetryableIntent(
      { ...base, status: 'processing' },
      { amount: 2400, orderId: 'order-1', type: 'contact_unlock' }
    )).toEqual({ kind: 'busy' });
  });

  test('side payments cannot be classified as the main escrow on return', () => {
    expect(resolvePaymentType(
      { metadata: { type: 'additional_payment' } },
      { metadata: {} }
    )).toBe('additional_payment');
    expect(resolvePaymentType(
      { metadata: {} },
      { metadata: { type: 'contact_unlock' } }
    )).toBe('contact_unlock');
    expect(resolvePaymentType({ metadata: {} }, { metadata: {} }))
      .toBe('order_escrow');
  });

  test('only an explicit or canonical legacy escrow can mutate the main order payment', () => {
    const order = {
      _id: 'order-1',
      paymentId: 'payment-main',
      payment: { intentId: 'pi-main' },
    };
    const mainPayment = {
      _id: 'payment-main',
      order: 'order-1',
      metadata: { type: 'order_escrow' },
    };

    expect(isCanonicalMainEscrowIntent(
      { id: 'pi-main', metadata: { orderId: 'order-1', type: 'order_escrow' } },
      mainPayment,
      order
    )).toBe(true);
    expect(isCanonicalMainEscrowIntent(
      { id: 'pi-main', metadata: { orderId: 'order-1', type: 'order_boost' } },
      mainPayment,
      order
    )).toBe(false);
    expect(isCanonicalMainEscrowIntent(
      { id: 'pi-main', metadata: { orderId: 'order-1' } },
      { ...mainPayment, metadata: {} },
      order
    )).toBe(true);
    expect(isCanonicalMainEscrowIntent(
      { id: 'pi-unknown', metadata: { orderId: 'order-1' } },
      { _id: 'payment-unknown', order: 'order-1', metadata: {} },
      order
    )).toBe(false);
  });

  test('non-order return is visible only to its recorded owner', () => {
    const intent = {
      metadata: { type: 'subscription', userId: 'user-1' },
    };
    const payment = { subscriptionUser: 'user-1' };

    expect(isPaymentOwnedByUser(intent, payment, { _id: 'user-1' })).toBe(true);
    expect(isPaymentOwnedByUser(intent, payment, { _id: 'user-2' })).toBe(false);
    expect(isPaymentOwnedByUser(
      { metadata: { type: 'sponsor_ad_renewal', advertiserEmail: 'owner@example.com' } },
      null,
      { _id: 'user-3', email: 'OWNER@example.com' }
    )).toBe(true);
  });

  test('successful additional payment reconstructs its order pointers after a partial write', () => {
    const order = { payment: {}, clientCompletionStatus: 'pending' };
    const paidAt = new Date('2026-10-19T12:30:00.000Z');

    applyAdditionalPaymentSuccess(
      order,
      { _id: 'payment-additional' },
      { id: 'pi-additional' },
      paidAt
    );

    expect(order).toEqual(expect.objectContaining({
      additionalPaymentStatus: 'succeeded',
      additionalPaymentPaidAt: paidAt,
      clientCompletionStatus: 'accepted',
      clientCompletionAcceptedAt: paidAt,
      payment: {
        additionalIntentId: 'pi-additional',
        additionalPaymentId: 'payment-additional',
      },
    }));
  });

  test('processing return stays pending and cannot fund escrow', () => {
    expect(classifyPaymentReturnStatus('processing', true)).toEqual({
      accepted: false,
      pending: true,
      httpStatus: 202,
    });
    expect(classifyPaymentReturnStatus('requires_capture', true).accepted).toBe(true);
    expect(classifyPaymentReturnStatus('requires_capture', false).accepted).toBe(false);
  });

  test('canceled current escrow returns a funded order to accepted without touching side intents', () => {
    const order = {
      _id: 'order-1',
      status: 'funded',
      paymentStatus: 'processing',
      paidInSystem: true,
      protectionEligible: true,
      protectionStatus: 'active',
      protectionExpiresAt: new Date('2026-11-19T12:00:00.000Z'),
      paymentId: 'payment-main',
      payment: { intentId: 'pi-main', status: 'paid', protected: true },
    };
    const payment = {
      _id: 'payment-main',
      order: 'order-1',
      metadata: { type: 'order_escrow' },
    };

    expect(applyCanonicalMainCancellation(
      order,
      payment,
      { id: 'pi-main', metadata: { orderId: 'order-1', type: 'order_escrow' } }
    )).toBe(true);
    expect(order).toEqual(expect.objectContaining({
      status: 'accepted',
      paymentStatus: 'failed',
      paidInSystem: false,
      protectionEligible: false,
      protectionStatus: 'inactive',
      protectionExpiresAt: null,
      payment: expect.objectContaining({ status: 'failed', protected: false }),
    }));

    const unchanged = { ...order, payment: { intentId: 'pi-main' }, status: 'funded' };
    expect(applyCanonicalMainCancellation(
      unchanged,
      { _id: 'payment-side', order: 'order-1', metadata: { type: 'order_boost' } },
      { id: 'pi-side', metadata: { orderId: 'order-1', type: 'order_boost' } }
    )).toBe(false);
    expect(unchanged.status).toBe('funded');
  });

  test('a delayed cancellation cannot downgrade a refunded escrow or its order', () => {
    const order = {
      _id: 'order-1',
      status: 'funded',
      paymentStatus: 'refunded',
      paymentId: 'payment-main',
      payment: { intentId: 'pi-main', status: 'refunded' },
    };
    const payment = {
      _id: 'payment-main',
      order: 'order-1',
      status: 'refunded',
      metadata: { type: 'order_escrow' },
    };

    expect(applyCanonicalMainCancellation(order, payment, {
      id: 'pi-main',
      metadata: { orderId: 'order-1', type: 'order_escrow' },
    })).toBe(false);
    expect(order).toEqual(expect.objectContaining({
      status: 'funded',
      paymentStatus: 'refunded',
      payment: { intentId: 'pi-main', status: 'refunded' },
    }));
  });

  test('destination charge is bound to current provider, offer and Connect account', () => {
    const order = {
      _id: 'order-1',
      provider: 'provider-1',
      acceptedOfferId: 'offer-1',
    };
    const payment = {
      order: 'order-1',
      provider: 'provider-1',
      metadata: {
        providerId: 'provider-1',
        acceptedOfferId: 'offer-1',
        destinationAccountId: 'acct_1',
      },
    };
    const intent = {
      metadata: {
        providerId: 'provider-1',
        acceptedOfferId: 'offer-1',
        destinationAccountId: 'acct_1',
      },
      transfer_data: { destination: 'acct_1' },
    };

    expect(isDestinationChargeBindingValid(
      intent,
      payment,
      order,
      { stripeAccountId: 'acct_1' }
    )).toBe(true);
    expect(isDestinationChargeBindingValid(
      { ...intent, transfer_data: { destination: 'acct_old' } },
      payment,
      order,
      { stripeAccountId: 'acct_1' }
    )).toBe(false);
  });

  test('external commission requires the accepted external flow without main escrow', () => {
    const order = {
      status: 'accepted',
      paymentPreference: 'external',
      provider: 'provider-1',
      acceptedOfferId: 'offer-1',
      payment: {},
    };
    expect(getExternalCommissionReadiness(order)).toEqual({
      ok: true,
      providerId: 'provider-1',
      acceptedOfferId: 'offer-1',
    });
    expect(getExternalCommissionReadiness(
      { ...order, paymentPreference: 'system' }
    )).toEqual({ ok: false, code: 'EXTERNAL_PAYMENT_REQUIRED' });
    expect(getExternalCommissionReadiness(
      { ...order, paymentId: 'payment-main' }
    )).toEqual({ ok: false, code: 'MAIN_ESCROW_ALREADY_EXISTS' });
    expect(getExternalCommissionReadiness(
      order,
      { hasMainEscrow: true }
    )).toEqual({ ok: false, code: 'MAIN_ESCROW_ALREADY_EXISTS' });
  });

  test('protection is activated only when the accepted pricing purchased it', () => {
    expect(orderHasPurchasedGuarantee({
      pricing: { includeGuarantee: true, guaranteeFee: 0 },
    })).toBe(true);
    expect(orderHasPurchasedGuarantee({
      pricing: { includeGuarantee: false, guaranteeFee: 7 },
    })).toBe(true);
    expect(orderHasPurchasedGuarantee({
      pricing: { includeGuarantee: false, guaranteeFee: 0 },
    })).toBe(false);
  });

  test('refund of a side payment never voids main escrow protection', () => {
    const order = {
      _id: 'order-1',
      paymentStatus: 'succeeded',
      protectionStatus: 'active',
      protectionEligible: true,
      contactUnlockStatus: 'succeeded',
      contactUnlockedAt: new Date('2026-10-19T10:00:00.000Z'),
      payment: { intentId: 'pi-main' },
      paymentId: 'payment-main',
    };
    const contactPayment = {
      _id: 'payment-contact',
      order: 'order-1',
      stripePaymentIntentId: 'pi-contact',
      status: 'refunded',
      metadata: { type: 'contact_unlock' },
    };

    expect(applyPaymentRefundToOrder(order, contactPayment, 'pi-contact'))
      .toEqual({ paymentType: 'contact_unlock', isMainEscrow: false });
    expect(order).toEqual(expect.objectContaining({
      paymentStatus: 'succeeded',
      protectionStatus: 'active',
      protectionEligible: true,
      contactUnlockStatus: 'unpaid',
      contactUnlockedAt: null,
    }));
  });

  test('destination-charge escrow refund is canonical from persisted Order pointers', () => {
    const order = {
      _id: 'order-1',
      paymentId: 'payment-main',
      paymentStatus: 'succeeded',
      paidInSystem: true,
      protectionStatus: 'active',
      protectionEligible: true,
      protectionExpiresAt: new Date('2026-11-20T12:00:00.000Z'),
      payment: { intentId: 'pi-main', status: 'paid', protected: true },
    };
    const payment = {
      _id: 'payment-main',
      order: 'order-1',
      stripePaymentIntentId: 'pi-main',
      status: 'refunded',
      metadata: {
        type: 'order_escrow',
        providerId: 'provider-1',
        acceptedOfferId: 'offer-1',
        destinationAccountId: 'acct_1',
      },
    };

    expect(isCanonicalMainEscrowRefund(payment, order, 'pi-main')).toBe(true);
    expect(applyPaymentRefundToOrder(order, payment, 'pi-main')).toEqual({
      paymentType: 'order_escrow',
      isMainEscrow: true,
    });
    expect(order).toEqual(expect.objectContaining({
      paymentStatus: 'refunded',
      paidInSystem: false,
      protectionStatus: 'void',
      protectionEligible: false,
      protectionExpiresAt: null,
      payment: expect.objectContaining({ status: 'refunded', protected: false }),
    }));
    expect(isCanonicalMainEscrowRefund(
      { ...payment, _id: 'stale-payment' },
      order,
      'pi-main'
    )).toBe(false);
  });

  test('delayed success claims Payment only while no refund tombstone exists', async () => {
    const PaymentModel = { findOneAndUpdate: jest.fn().mockResolvedValue(null) };
    const payment = {
      _id: 'payment-1',
      stripePaymentIntentId: 'pi-1',
      method: 'unknown',
    };
    const intent = {
      id: 'pi-1',
      payment_method_types: ['card'],
      amount: 4900,
      currency: 'pln',
    };

    await expect(claimPaymentSucceededFromWebhook(
      payment,
      intent,
      { PaymentModel }
    )).resolves.toBeNull();
    expect(PaymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'payment-1',
        stripePaymentIntentId: 'pi-1',
        status: { $nin: ['refunded', 'partial_refund'] },
      },
      { $set: { status: 'succeeded', method: 'card' } },
      { new: true }
    );
  });

  test('external commission state never overwrites canonical escrow references', () => {
    const order = {
      externalCommissionStatus: 'unpaid',
      paidInSystem: false,
      paymentId: 'main-payment',
      payment: {
        intentId: 'pi_main',
        status: 'requires_payment',
        method: 'card',
      },
    };

    applyExternalCommissionOrderState(order, 'processing');

    expect(order).toEqual(expect.objectContaining({
      externalCommissionStatus: 'processing',
      paidInSystem: false,
      paymentId: 'main-payment',
      payment: {
        intentId: 'pi_main',
        status: 'requires_payment',
        method: 'card',
      },
    }));

    order.externalCommissionStatus = 'succeeded';
    applyExternalCommissionOrderState(order, 'failed');
    expect(order.externalCommissionStatus).toBe('succeeded');
  });

  test('abandoned external commission reuses the matching intent and recognizes success', () => {
    const commission = {
      amount: 500,
      currency: 'pln',
      metadata: { orderId: 'order-1', type: 'commission_external' },
      client_secret: 'commission-secret',
    };
    const expected = {
      amount: 500,
      orderId: 'order-1',
      type: 'commission_external',
    };

    expect(classifyRetryableIntent(
      { ...commission, status: 'requires_payment_method' },
      expected
    )).toEqual({ kind: 'reusable' });
    expect(classifyRetryableIntent(
      { ...commission, status: 'succeeded' },
      expected
    )).toEqual({ kind: 'succeeded' });
  });

  test('refunded payments can never be promoted back to succeeded by PI replay', () => {
    const intent = {
      amount: 500,
      currency: 'pln',
      status: 'succeeded',
      metadata: { orderId: 'order-1', type: 'commission_external' },
    };
    const payment = { status: 'partial_refund' };
    const expected = { amount: 500, orderId: 'order-1', type: 'commission_external' };

    expect(paymentOrIntentHasRefund(payment, intent)).toBe(true);
    expect(classifyRetryableIntent(intent, expected, payment)).toEqual({ kind: 'refunded' });
    expect(paymentOrIntentHasRefund(null, {
      latest_charge: { amount_refunded: 100 },
    })).toBe(true);
  });

  test('contact unlock is bound to the currently accepted offer and provider', () => {
    const order = {
      _id: 'order-1',
      orderMode: 'offers_only',
      status: 'accepted',
      provider: 'provider-1',
      acceptedOfferId: 'offer-1',
    };
    const intent = {
      metadata: {
        orderId: 'order-1',
        providerId: 'provider-1',
        acceptedOfferId: 'offer-1',
      },
    };
    const payment = {
      order: 'order-1',
      provider: 'provider-1',
      metadata: { providerId: 'provider-1', acceptedOfferId: 'offer-1' },
    };

    expect(isContactUnlockBindingValid(intent, payment, order)).toBe(true);
    expect(isContactUnlockBindingValid(
      { metadata: { ...intent.metadata, acceptedOfferId: 'offer-old' } },
      payment,
      order
    )).toBe(false);
  });

  test('canceled escrow after work started opens a dispute and removes false protection', () => {
    const order = {
      _id: 'order-1',
      status: 'in_progress',
      paymentStatus: 'processing',
      paidInSystem: false,
      protectionEligible: true,
      protectionStatus: 'active',
      paymentId: 'payment-main',
      payment: { intentId: 'pi-main', status: 'paid', protected: true },
    };
    const payment = {
      _id: 'payment-main',
      order: 'order-1',
      metadata: { type: 'order_escrow' },
    };
    const canceledAt = 1792411200;

    expect(applyCanonicalMainCancellation(order, payment, {
      id: 'pi-main',
      canceled_at: canceledAt,
      metadata: { orderId: 'order-1', type: 'order_escrow' },
    })).toBe(true);
    expect(order).toEqual(expect.objectContaining({
      status: 'disputed',
      disputeStatus: 'reported',
      paymentStatus: 'failed',
      protectionEligible: false,
      protectionStatus: 'inactive',
      disputeReportedAt: new Date(canceledAt * 1000),
    }));
  });

  test('authorized escrow activates only purchased protection without claiming capture', async () => {
    const order = {
      _id: 'order-1',
      status: 'accepted',
      pricing: { includeGuarantee: true, guaranteeFee: 5 },
      payment: {},
      save: jest.fn().mockResolvedValue(undefined),
    };
    const payment = {
      _id: 'payment-main',
      save: jest.fn().mockResolvedValue(undefined),
    };
    const intent = {
      id: 'pi-main',
      status: 'requires_capture',
      created: 1792411200,
    };

    await applyOrderFundedFromStripeIntent(order, intent, payment);

    expect(order).toEqual(expect.objectContaining({
      status: 'funded',
      paymentStatus: 'processing',
      paidInSystem: false,
      protectionEligible: true,
      protectionStatus: 'active',
    }));
    expect(order.protectionExpiresAt).toEqual(
      new Date(1792411200 * 1000 + 30 * 24 * 60 * 60 * 1000)
    );
  });

  test('capturable webhook re-reads Stripe and atomically claims only current bindings', async () => {
    const intent = {
      id: 'pi-main',
      status: 'requires_capture',
      amount: 4900,
      currency: 'pln',
      created: 1792411200,
      metadata: {
        orderId: 'order-1',
        type: 'order_escrow',
        providerId: 'provider-1',
        acceptedOfferId: 'offer-1',
        destinationAccountId: 'acct_1',
      },
      transfer_data: { destination: 'acct_1' },
    };
    const payment = {
      _id: 'payment-main',
      order: 'order-1',
      provider: 'provider-1',
      status: 'processing',
      stripePaymentIntentId: 'pi-main',
      metadata: { ...intent.metadata },
    };
    const order = {
      _id: 'order-1',
      status: 'accepted',
      amountTotal: 4900,
      provider: 'provider-1',
      acceptedOfferId: 'offer-1',
      paymentId: 'payment-main',
      payment: { intentId: 'pi-main' },
      pricing: { includeGuarantee: false, guaranteeFee: 0 },
    };
    const claimedPayment = { ...payment };
    const claimedOrder = { ...order, status: 'funded' };
    const PaymentModel = {
      findOne: jest.fn().mockResolvedValue(payment),
      findOneAndUpdate: jest.fn().mockResolvedValue(claimedPayment),
    };
    const OrderModel = {
      findById: jest.fn().mockResolvedValue(order),
      findOneAndUpdate: jest.fn().mockResolvedValue(claimedOrder),
    };
    const UserModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ stripeAccountId: 'acct_1' }),
        }),
      }),
    };

    await expect(reconcileCapturableEscrowFromWebhook(
      { id: 'pi-main', metadata: { orderId: 'order-1' } },
      {
        stripeClient: { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } },
        PaymentModel,
        OrderModel,
        UserModel,
      }
    )).resolves.toEqual(expect.objectContaining({ applied: true }));
    expect(PaymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'payment-main',
        status: { $in: ['requires_payment_method', 'processing'] },
      }),
      { $set: { status: 'processing' } },
      { new: true }
    );
    expect(OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'order-1',
        paymentId: 'payment-main',
        'payment.intentId': 'pi-main',
      }),
      expect.any(Object),
      { new: true }
    );
  });

  test('stale capturable event cannot revive a currently canceled PI', async () => {
    const PaymentModel = { findOne: jest.fn(), findOneAndUpdate: jest.fn() };
    const result = await reconcileCapturableEscrowFromWebhook(
      { id: 'pi-main', metadata: { orderId: 'order-1' } },
      {
        stripeClient: {
          paymentIntents: {
            retrieve: jest.fn().mockResolvedValue({ id: 'pi-main', status: 'canceled' }),
          },
        },
        PaymentModel,
        OrderModel: {},
        UserModel: {},
      }
    );
    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'intent_not_capturable',
    }));
    expect(PaymentModel.findOne).not.toHaveBeenCalled();
  });

  test('refund validation is integer-only, bounded and explicit for full refunds', () => {
    expect(resolveRefundRequest(undefined, 1200)).toEqual({
      ok: true,
      amount: 1200,
      fullRefund: true,
    });
    expect(resolveRefundRequest(500, 1200)).toEqual({
      ok: true,
      amount: 500,
      fullRefund: false,
    });
    expect(resolveRefundRequest(0, 1200)).toEqual({ ok: false, code: 'INVALID_REFUND_AMOUNT' });
    expect(resolveRefundRequest(1201, 1200)).toEqual({ ok: false, code: 'REFUND_EXCEEDS_AVAILABLE' });
    expect(resolveRefundRequest(undefined, 0)).toEqual({ ok: false, code: 'NOTHING_TO_REFUND' });
  });
});

describe('PaymentIntent creation retry safety', () => {
  test('atomically upserts Payment by PI without downgrading an existing refund', async () => {
    const refunded = { _id: 'payment-1', status: 'refunded', amount: 2400 };
    const PaymentModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(refunded),
      findOne: jest.fn(),
    };

    await expect(upsertPaymentForIntent(
      'pi_1',
      { amount: 2400, status: 'processing' },
      PaymentModel
    )).resolves.toBe(refunded);

    expect(PaymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      { stripePaymentIntentId: 'pi_1' },
      {
        $setOnInsert: {
          amount: 2400,
          status: 'processing',
          stripePaymentIntentId: 'pi_1',
        },
      },
      { upsert: true, new: true }
    );
  });

  test('re-reads the winning Payment after a unique-index race', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    const winner = { _id: 'payment-winner', status: 'succeeded', amount: 2400 };
    const PaymentModel = {
      findOneAndUpdate: jest.fn().mockRejectedValue(duplicate),
      findOne: jest.fn().mockResolvedValue(winner),
    };

    await expect(upsertPaymentForIntent(
      'pi_race',
      { amount: 2400, status: 'processing' },
      PaymentModel
    )).resolves.toBe(winner);
    expect(PaymentModel.findOne).toHaveBeenCalledWith({ stripePaymentIntentId: 'pi_race' });
  });

  test('fails closed when an existing PI is bound to another order or amount', async () => {
    const PaymentModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({
        _id: 'payment-foreign',
        order: 'order-foreign',
        client: 'client-1',
        amount: 2400,
        currency: 'pln',
        metadata: { type: 'contact_unlock' },
      }),
      findOne: jest.fn(),
    };

    await expect(upsertPaymentForIntent(
      'pi_bound_elsewhere',
      {
        order: 'order-expected',
        client: 'client-1',
        amount: 2400,
        currency: 'pln',
        metadata: { type: 'contact_unlock' },
      },
      PaymentModel
    )).rejects.toMatchObject({ code: 'PAYMENT_INTENT_BINDING_CONFLICT' });
  });

  test('uses stable, variant-specific idempotency keys for configuration fallback', async () => {
    const invalidConfig = Object.assign(new Error('unsupported methods'), {
      type: 'StripeInvalidRequestError',
    });
    const stripeClient = {
      paymentIntents: {
        create: jest.fn()
          .mockRejectedValueOnce(invalidConfig)
          .mockResolvedValueOnce({ id: 'pi_1' }),
      },
    };

    await expect(createPaymentIntentPreferLocalWallets(
      stripeClient,
      { amount: 2400, currency: 'pln' },
      { idempotencyKeyPrefix: 'commission:order-1:2400:initial' }
    )).resolves.toEqual({ id: 'pi_1' });

    expect(stripeClient.paymentIntents.create).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      { idempotencyKey: 'commission:order-1:2400:initial:wallets-v1:0' }
    );
    expect(stripeClient.paymentIntents.create).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      { idempotencyKey: 'commission:order-1:2400:initial:wallets-v1:1' }
    );
  });

  test('does not create another intent after a network failure', async () => {
    const stripeClient = {
      paymentIntents: {
        create: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
      },
    };

    await expect(createPaymentIntentPreferLocalWallets(
      stripeClient,
      { amount: 2400, currency: 'pln' },
      { idempotencyKeyPrefix: 'contact:order-1:2400:initial' }
    )).rejects.toThrow('ECONNRESET');
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledTimes(1);
  });
});

describe('one-time Checkout refund ordering', () => {
  const session = {
    id: 'cs_one_time',
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: 'pi_one_time',
    amount_total: 4900,
    currency: 'pln',
  };
  const binding = {
    type: 'checkout_provider_promo',
    userId: 'provider-1',
    metadata: { productKey: 'top_7d' },
  };

  function boundPayment(status = 'processing') {
    return {
      _id: 'payment-checkout',
      purpose: 'promotion',
      provider: 'provider-1',
      amount: 4900,
      currency: 'pln',
      status,
      stripeCheckoutSessionId: 'cs_one_time',
      stripePaymentIntentId: 'pi_one_time',
      stripeBusinessKey: 'checkout_session:cs_one_time',
      metadata: {
        type: 'checkout_provider_promo',
        userId: 'provider-1',
      },
    };
  }

  function settledIntent(chargeOverrides = {}) {
    return {
      id: 'pi_one_time',
      status: 'succeeded',
      amount: 4900,
      currency: 'pln',
      latest_charge: {
        id: 'ch_one_time',
        payment_intent: 'pi_one_time',
        paid: true,
        amount: 4900,
        amount_refunded: 0,
        currency: 'pln',
        refunded: false,
        ...chargeOverrides,
      },
    };
  }

  test('a fresh Charge refund makes a delayed paid Checkout ineligible', () => {
    expect(classifyOneTimeCheckoutSettlement(
      session,
      settledIntent({ amount_refunded: 1000 })
    )).toEqual(expect.objectContaining({
      eligible: false,
      reason: 'refunded',
      refundStatus: 'partial_refund',
    }));
  });

  test('records a prior refund and never claims fulfillment', async () => {
    const PaymentModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(boundPayment()),
      findOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const stripeClient = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue(
          settledIntent({ amount_refunded: 4900, refunded: true })
        ),
      },
    };

    await expect(authorizeOneTimeCheckoutFulfillment(
      session,
      binding,
      { stripeClient, PaymentModel }
    )).resolves.toEqual(expect.objectContaining({
      allowed: false,
      reason: 'refunded',
    }));

    expect(PaymentModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(PaymentModel.updateOne).toHaveBeenCalledWith(
      { _id: 'payment-checkout' },
      { $set: { status: 'refunded', stripeChargeId: 'ch_one_time' } }
    );
  });

  test('refund status winning the atomic race blocks activation', async () => {
    const PaymentModel = {
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce(boundPayment())
        .mockResolvedValueOnce(null),
      findOne: jest.fn(),
      updateOne: jest.fn(),
    };
    const stripeClient = {
      paymentIntents: { retrieve: jest.fn().mockResolvedValue(settledIntent()) },
    };

    await expect(authorizeOneTimeCheckoutFulfillment(
      session,
      binding,
      { stripeClient, PaymentModel }
    )).resolves.toEqual(expect.objectContaining({
      allowed: false,
      reason: 'payment_state_changed',
    }));

    const claimFilter = PaymentModel.findOneAndUpdate.mock.calls[1][0];
    expect(claimFilter.status.$in).not.toContain('refunded');
    expect(claimFilter.status.$in).not.toContain('partial_refund');
  });

  test('a zero-value Checkout is still guarded by its unique session key', async () => {
    const freeSession = {
      ...session,
      id: 'cs_free',
      amount_total: 0,
      payment_intent: null,
    };
    const freePayment = {
      ...boundPayment(),
      amount: 0,
      stripeCheckoutSessionId: 'cs_free',
      stripePaymentIntentId: null,
      stripeBusinessKey: 'checkout_session:cs_free',
    };
    const authorized = { ...freePayment, status: 'succeeded' };
    const PaymentModel = {
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce(freePayment)
        .mockResolvedValueOnce(authorized),
      findOne: jest.fn(),
      updateOne: jest.fn(),
    };
    const stripeClient = { paymentIntents: { retrieve: jest.fn() } };

    await expect(authorizeOneTimeCheckoutFulfillment(
      freeSession,
      binding,
      { stripeClient, PaymentModel }
    )).resolves.toEqual(expect.objectContaining({ allowed: true }));
    expect(stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('legacy order Checkout resolves a string PI and blocks its fresh refund', async () => {
    const orderPayment = {
      _id: 'payment-order',
      amount: 4900,
      currency: 'pln',
      status: 'processing',
      stripePaymentIntentId: 'pi_one_time',
    };
    const stripeClient = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue(
          settledIntent({ amount_refunded: 4900, refunded: true })
        ),
      },
    };

    await expect(verifyLegacyOrderCheckoutSettlement(
      session,
      orderPayment,
      stripeClient
    )).resolves.toEqual(expect.objectContaining({
      allowed: false,
      reason: 'refunded',
      refundStatus: 'refunded',
    }));
    expect(stripeClient.paymentIntents.retrieve).toHaveBeenCalledWith(
      'pi_one_time',
      { expand: ['latest_charge'] }
    );
  });
});

describe('Stripe Refund webhook normalization', () => {
  test.each([
    'charge.refund.updated',
    'refund.updated',
    'refund.created',
    'refund.failed',
  ])(
    '%s retrieves the Charge instead of treating Refund as Charge',
    async (eventType) => {
      const refund = {
        id: 're_1',
        object: 'refund',
        charge: 'ch_1',
        status: 'succeeded',
        metadata: { auditKey: 'refund-audit-1' },
      };
      const charge = {
        id: 'ch_1',
        object: 'charge',
        payment_intent: 'pi_1',
        amount: 1200,
        amount_refunded: 1200,
      };
      const stripeClient = {
        charges: { retrieve: jest.fn().mockResolvedValue(charge) },
      };

      await expect(normalizeStripeRefundEvent(
        { type: eventType, data: { object: refund } },
        stripeClient
      )).resolves.toEqual({
        charge,
        refund,
        chargeId: 'ch_1',
        paymentIntentId: 'pi_1',
      });
      expect(stripeClient.charges.retrieve).toHaveBeenCalledWith(
        'ch_1',
        { expand: ['payment_intent'] }
      );
    }
  );

  test('refund audit is reconciled only through its bound audit key and Charge', async () => {
    const PaymentRefundAuditModel = {
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    };
    const refund = {
      id: 're_1',
      status: 'failed',
      failure_reason: 'lost_or_stolen_card',
      metadata: { auditKey: 'refund-audit-1' },
    };

    await expect(reconcilePaymentRefundAudit(
      refund,
      { chargeId: 'ch_1', paymentIntentId: 'pi_1' },
      PaymentRefundAuditModel
    )).resolves.toEqual({ reconciled: true, status: 'failed' });
    expect(PaymentRefundAuditModel.updateOne).toHaveBeenCalledWith(
      {
        idempotencyKey: 'refund-audit-1',
        stripeChargeId: 'ch_1',
        stripePaymentIntentId: 'pi_1',
        status: { $in: ['pending', 'failed'] },
        $or: [{ stripeRefundId: null }, { stripeRefundId: 're_1' }],
      },
      {
        $set: {
          stripeRefundId: 're_1',
          status: 'failed',
          error: 'lost_or_stolen_card',
        },
      }
    );
    expect(refundAuditStatus({ status: 'pending' })).toBe('pending');
  });

  test.each([
    ['succeeded', 200, true, false, false],
    ['pending', 202, false, true, false],
    ['requires_action', 202, false, true, false],
    ['failed', 422, false, false, true],
    ['canceled', 422, false, false, true],
  ])(
    'refund status %s maps to safe HTTP/materialization state',
    (status, httpStatus, materializePayment, pending, failed) => {
      expect(classifyStripeRefundResult({ status })).toEqual(expect.objectContaining({
        httpStatus,
        materializePayment,
        pending,
        failed,
      }));
    }
  );

  test('refund idempotency key is bound to the original amount and Charge', () => {
    const expected = {
      payment: 'payment-1',
      requestedBy: 'admin-1',
      stripePaymentIntentId: 'pi-1',
      stripeChargeId: 'ch-1',
      amount: 500,
      fullRefund: false,
    };
    expect(refundAuditMatchesRequest({ ...expected }, expected)).toBe(true);
    expect(refundAuditMatchesRequest(
      { ...expected, amount: 600 },
      expected
    )).toBe(false);
    expect(refundAuditMatchesRequest(
      { ...expected, stripeChargeId: 'ch-other' },
      expected
    )).toBe(false);
  });

  test('an ambiguous retry error cannot downgrade a succeeded refund audit', async () => {
    const PaymentRefundAuditModel = {
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 0 }),
    };

    await recordAmbiguousRefundError(
      PaymentRefundAuditModel,
      'refund-audit-1',
      new Error('ECONNRESET')
    );
    expect(PaymentRefundAuditModel.updateOne).toHaveBeenCalledWith(
      {
        idempotencyKey: 'refund-audit-1',
        status: 'pending',
      },
      { $set: { error: 'ECONNRESET' } }
    );
    expect(PaymentRefundAuditModel.updateOne.mock.calls[0][1].$set)
      .not.toHaveProperty('status');
  });
});

describe('benefit refund safety', () => {
  test('admin refund is fail-closed for entitlement payments', () => {
    expect(requiresManualBenefitRefund({ purpose: 'promotion', metadata: {} })).toBe(true);
    expect(requiresManualBenefitRefund({
      purpose: 'order',
      metadata: { type: 'boost_purchase' },
    })).toBe(true);
    expect(requiresManualBenefitRefund({
      purpose: 'order',
      metadata: { type: 'order_escrow' },
    })).toBe(false);
    expect(requiresManualBenefitRefund({
      purpose: 'order',
      metadata: { type: 'additional_payment' },
    })).toBe(false);
  });

  test('promotion reversal is a per-PI tombstone and never subtracts below zero', () => {
    const endsAt = new Date('2026-11-01T12:00:00.000Z');
    const refundedAt = new Date('2026-10-20T12:00:00.000Z');
    const pipeline = buildPromotionRefundUserPipeline(
      { endsAt },
      {
        rankingPointsAdd: 25,
        effects: { highlight: true, topBadge: false, aiBadge: true },
      },
      'pi_promo_1',
      refundedAt
    );
    const set = pipeline[0].$set;
    const { activationKey, reversalKey } = promotionPurchaseEffectKeys('pi_promo_1');

    expect(set.stripeAppliedEffects).toEqual({
      $setUnion: [{ $ifNull: ['$stripeAppliedEffects', []] }, [reversalKey]],
    });
    expect(set.rankingPoints.$cond[0]).toEqual({
      $in: [activationKey, { $ifNull: ['$stripeAppliedEffects', []] }],
    });
    expect(set.rankingPoints.$cond[1].$max[0]).toBe(0);
    expect(set['promo.highlightUntil'].$cond[0].$and).toEqual([
      { $in: [activationKey, { $ifNull: ['$stripeAppliedEffects', []] }] },
      { $eq: ['$promo.highlightUntil', endsAt] },
    ]);
    expect(set['promo.highlightUntil'].$cond[1]).toEqual(refundedAt);
    expect(Object.prototype.hasOwnProperty.call(set, 'promo.topBadgeUntil')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(set, 'promo.aiTopTagUntil')).toBe(true);
  });

  test('promotion reversal atomically marks User first and Purchase once', async () => {
    const UserModel = {
      exists: jest.fn().mockResolvedValue({ _id: 'provider-1' }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const PromotionPurchaseModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const purchase = {
      _id: 'purchase-1',
      provider: 'provider-1',
      plan: 'plan-1',
      stripePaymentIntentId: 'pi_promo_1',
      endsAt: new Date('2026-11-01T12:00:00.000Z'),
    };
    const refundedAt = new Date('2026-10-20T12:00:00.000Z');

    await expect(reversePromotionPurchaseBenefit(
      purchase,
      { rankingPointsAdd: 25, effects: { highlight: true } },
      { paymentIntentId: 'pi_promo_1', refundedAt },
      { UserModel, PromotionPurchaseModel }
    )).resolves.toEqual({
      reversalKey: 'promotion_purchase_refund:pi_promo_1',
      userReversed: true,
      purchaseReversed: true,
      fullyCompensated: false,
      manualReason: 'promotion_expiry_manual_reconciliation',
    });

    expect(UserModel.updateOne).toHaveBeenCalledWith(
      {
        _id: 'provider-1',
        stripeAppliedEffects: { $ne: 'promotion_purchase_refund:pi_promo_1' },
      },
      expect.any(Array)
    );
    expect(PromotionPurchaseModel.updateOne).toHaveBeenCalledWith(
      {
        _id: 'purchase-1',
        stripeAppliedEffects: { $ne: 'promotion_purchase_refund:pi_promo_1' },
      },
      {
        $set: { status: 'refunded' },
        $addToSet: { stripeAppliedEffects: 'promotion_purchase_refund:pi_promo_1' },
      },
      undefined
    );
  });

  test('overlapping or legacy promotion is tombstoned but requires manual expiry review', async () => {
    const UserModel = {
      exists: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const PromotionPurchaseModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const purchase = {
      _id: 'purchase-legacy',
      provider: 'provider-1',
      plan: 'plan-1',
      stripePaymentIntentId: 'pi_legacy',
      endsAt: new Date('2026-11-01T12:00:00.000Z'),
    };

    const result = await reversePromotionPurchaseBenefit(
      purchase,
      { rankingPointsAdd: 25, effects: { highlight: true } },
      {
        paymentIntentId: 'pi_legacy',
        refundedAt: new Date('2026-10-20T12:00:00.000Z'),
      },
      { UserModel, PromotionPurchaseModel }
    );

    expect(result).toEqual(expect.objectContaining({
      fullyCompensated: false,
      manualReason: 'legacy_activation_marker_missing',
    }));
    const userPipeline = UserModel.updateOne.mock.calls[0][1];
    expect(Object.keys(userPipeline[0].$set)).not.toContain('promo.highlightUntil');
  });
});
