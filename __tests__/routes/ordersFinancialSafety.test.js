const ordersRouter = require('../../routes/orders');

const {
  resolveServerInitialOrderStatus,
  isOrderOwnerOrAdmin,
  getPaymentPreferenceChangeBlockReason,
  applyProviderCompletionState,
  canConfirmReceipt,
  releaseFailureHttpStatus,
  getStartWorkBlock,
  verifyMainEscrowAuthorization,
  buildSettlementOfferClaimFilter,
  buildSettlementDeclineClaimFilter,
} = ordersRouter.__testables;

describe('orders financial lifecycle safety helpers', () => {
  test('server derives the only allowed initial published-order statuses', () => {
    expect(resolveServerInitialOrderStatus('open')).toBe('collecting_offers');
    expect(resolveServerInitialOrderStatus('manual_pick')).toBe('open');
    expect(resolveServerInitialOrderStatus('ai_suggested')).toBe('open');
    expect(resolveServerInitialOrderStatus('released')).toBe('open');
  });

  test('payment preference may be changed only by the owner or an administrator', () => {
    const order = { client: 'client-1' };

    expect(isOrderOwnerOrAdmin(order, { _id: 'client-1', role: 'client' })).toBe(true);
    expect(isOrderOwnerOrAdmin(order, { _id: 'client-2', role: 'client' })).toBe(false);
    expect(isOrderOwnerOrAdmin(order, { _id: 'admin-1', role: 'admin' })).toBe(true);
    expect(isOrderOwnerOrAdmin(order, { _id: 'root-1', role: 'superadmin' })).toBe(true);
  });

  test('payment preference is blocked after offer acceptance or payment start', () => {
    expect(getPaymentPreferenceChangeBlockReason({
      status: 'collecting_offers',
      paymentStatus: 'unpaid',
    })).toBeNull();

    expect(getPaymentPreferenceChangeBlockReason({
      status: 'accepted',
      paymentStatus: 'unpaid',
    })).toMatch(/przed zaakceptowaniem/i);

    expect(getPaymentPreferenceChangeBlockReason({
      status: 'collecting_offers',
      acceptedOfferId: 'offer-1',
      paymentStatus: 'unpaid',
    })).toMatch(/zaakceptowaniu oferty/i);

    expect(getPaymentPreferenceChangeBlockReason({
      status: 'collecting_offers',
      paymentId: 'payment-1',
      paymentStatus: 'processing',
    })).toMatch(/rozpoczęciu płatności/i);
  });

  test('provider completion always waits for client confirmation, including external payment', () => {
    const order = {
      paymentPreference: 'external',
      status: 'in_progress',
      clientCompletionStatus: null,
    };
    const completedAt = new Date('2026-10-19T12:00:00.000Z');

    applyProviderCompletionState(order, completedAt);

    expect(order.status).toBe('completed');
    expect(order.clientCompletionStatus).toBe('pending');
    expect(order.clientCompletionAcceptedAt).toBeNull();
    expect(order.completedAt).toBe(completedAt);
  });

  test('receipt cannot be confirmed while funds are merely authorized', () => {
    expect(canConfirmReceipt({ status: 'funded' })).toBe(false);
    expect(canConfirmReceipt({ status: 'in_progress' })).toBe(false);
    expect(canConfirmReceipt({ status: 'completed' })).toBe(true);
  });

  test('release failures map to retry-safe HTTP responses', () => {
    expect(releaseFailureHttpStatus('stripe_unavailable')).toBe(503);
    expect(releaseFailureHttpStatus('missing_main_payment')).toBe(400);
    expect(releaseFailureHttpStatus('stripe_payment_not_succeeded')).toBe(409);
    expect(releaseFailureHttpStatus('stripe_capture_failed')).toBe(502);
  });

  test('provider cannot start from a merely created/processing escrow intent', () => {
    expect(getStartWorkBlock({
      provider: 'provider-1',
      paymentPreference: 'system',
      status: 'accepted',
      paymentStatus: 'processing',
    }, 'provider-1')).toEqual(expect.objectContaining({ status: 409 }));

    expect(getStartWorkBlock({
      provider: 'provider-1',
      paymentPreference: 'system',
      status: 'funded',
      paymentStatus: 'processing',
    }, 'provider-1')).toBeNull();
  });

  test('start fails closed without an assigned provider', () => {
    expect(getStartWorkBlock({
      provider: null,
      paymentPreference: 'external',
      status: 'accepted',
    }, 'attacker')).toEqual(expect.objectContaining({ status: 409 }));
  });

  test('external work can start only after any required commission succeeds', () => {
    expect(getStartWorkBlock({
      provider: 'provider-1',
      paymentPreference: 'external',
      status: 'accepted',
      pricing: { platformFee: 5 },
      externalCommissionStatus: 'processing',
    }, 'provider-1')).toEqual(expect.objectContaining({ status: 409 }));

    expect(getStartWorkBlock({
      provider: 'provider-1',
      paymentPreference: 'external',
      status: 'accepted',
      pricing: { platformFee: 5 },
      externalCommissionStatus: 'succeeded',
    }, 'provider-1')).toBeNull();
  });

  test('offers-only work cannot start before the accepted contact is unlocked', () => {
    expect(getStartWorkBlock({
      provider: 'provider-1',
      paymentPreference: 'external',
      orderMode: 'offers_only',
      status: 'accepted',
      contactUnlockStatus: 'unpaid',
      pricing: { platformFee: 0 },
    }, 'provider-1')).toEqual(expect.objectContaining({ status: 409 }));

    expect(getStartWorkBlock({
      provider: 'provider-1',
      paymentPreference: 'external',
      orderMode: 'offers_only',
      status: 'accepted',
      contactUnlockStatus: 'succeeded',
      pricing: { platformFee: 0 },
    }, 'provider-1')).toBeNull();
  });

  test('funding rejects processing and special-payment intents', async () => {
    const baseOrder = {
      _id: 'order-1',
      paymentPreference: 'system',
      paymentId: 'payment-1',
      payment: {},
    };
    const payment = {
      _id: 'payment-1',
      order: 'order-1',
      stripePaymentIntentId: 'pi-1',
      purpose: 'order',
      metadata: { type: 'order_escrow' },
    };
    const PaymentModel = { findById: jest.fn().mockResolvedValue(payment) };
    const processingStripe = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi-1',
          status: 'processing',
          metadata: { type: 'order_escrow', orderId: 'order-1' },
        }),
      },
    };

    await expect(verifyMainEscrowAuthorization(baseOrder, {
      PaymentModel,
      stripeClient: processingStripe,
    })).resolves.toEqual(expect.objectContaining({ ok: false, reason: 'payment_not_authorized' }));

    await expect(verifyMainEscrowAuthorization(baseOrder, {
      PaymentModel: {
        findById: jest.fn().mockResolvedValue({
          ...payment,
          metadata: { type: 'additional_payment' },
        }),
      },
      stripeClient: processingStripe,
    })).resolves.toEqual(expect.objectContaining({ ok: false, reason: 'main_payment_not_escrow' }));
  });

  test('funding accepts only canonical escrow confirmed by Stripe', async () => {
    const payment = {
      _id: 'payment-1',
      order: 'order-1',
      stripePaymentIntentId: 'pi-1',
      purpose: 'order',
      metadata: { type: 'order_escrow' },
    };
    const intent = {
      id: 'pi-1',
      status: 'requires_capture',
      metadata: { type: 'order_escrow', orderId: 'order-1' },
    };

    await expect(verifyMainEscrowAuthorization({
      _id: 'order-1',
      paymentPreference: 'system',
      paymentId: 'payment-1',
      payment: {},
    }, {
      PaymentModel: { findById: jest.fn().mockResolvedValue(payment) },
      stripeClient: { paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) } },
    })).resolves.toEqual({ ok: true, payment, intent });

    await expect(verifyMainEscrowAuthorization({
      _id: 'order-1',
      paymentPreference: 'system',
      paymentId: 'payment-1',
      payment: {},
    }, {
      PaymentModel: { findById: jest.fn().mockResolvedValue(payment) },
      stripeClient: {
        paymentIntents: {
          retrieve: jest.fn().mockResolvedValue({ ...intent, metadata: {} }),
        },
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'payment_intent_mismatch',
    }));
  });

  test('a new settlement offer can be claimed only on an open dispute without a refund claim', () => {
    const disputeReportedAt = new Date('2026-10-20T10:00:00.000Z');
    const filter = buildSettlementOfferClaimFilter({ _id: 'order-1', disputeReportedAt });

    expect(filter).toEqual(expect.objectContaining({
      _id: 'order-1',
      disputeEscalatedAt: null,
      disputeStatus: { $nin: ['resolved', 'closed'] },
      disputeReportedAt,
    }));
    expect(filter.$and).toEqual(expect.arrayContaining([
      {
        $or: [
          { 'disputeSettlement.refundExecutionKey': { $exists: false } },
          { 'disputeSettlement.refundExecutionKey': null },
        ],
      },
    ]));
  });

  test('declining a settlement requires the exact pending offer and no refund claim', () => {
    const createdAt = new Date('2026-10-20T10:05:00.000Z');
    expect(buildSettlementDeclineClaimFilter(
      { _id: 'order-1' },
      { offeredBy: 'client-1', createdAt }
    )).toEqual({
      _id: 'order-1',
      'disputeSettlement.status': 'pending',
      'disputeSettlement.offeredBy': 'client-1',
      'disputeSettlement.createdAt': createdAt,
      $or: [
        { 'disputeSettlement.refundExecutionKey': { $exists: false } },
        { 'disputeSettlement.refundExecutionKey': null },
      ],
    });
  });
});
