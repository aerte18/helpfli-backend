const {
  releaseOrderEscrowToProvider,
  settleMainOrderPaymentForRelease,
  validateMainStripeIntent,
} = require('../../utils/releaseOrderEscrow');

function stripeIntent(status = 'succeeded', overrides = {}) {
  const metadata = {
    orderId: 'order-1',
    type: 'order_escrow',
    providerId: 'provider-1',
    acceptedOfferId: 'offer-1',
    destinationAccountId: 'acct_provider_1',
    ...(overrides.metadata || {}),
  };
  return {
    id: 'pi_main',
    status,
    amount: 10_000,
    currency: 'pln',
    metadata,
    transfer_data: { destination: 'acct_provider_1' },
    ...overrides,
    metadata,
  };
}

function systemOrder(overrides = {}) {
  return {
    _id: 'order-1',
    status: 'completed',
    paymentPreference: 'system',
    paymentId: 'main-payment',
    provider: 'provider-1',
    acceptedOfferId: 'offer-1',
    amountTotal: 10_000,
    currency: 'pln',
    paymentStatus: 'processing',
    paidInSystem: false,
    protectionEligible: false,
    protectionStatus: 'inactive',
    payment: {
      status: 'requires_payment',
      intentId: 'pi_main',
      additionalPaymentId: 'additional-payment',
    },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mainPayment(overrides = {}) {
  return {
    _id: 'main-payment',
    order: 'order-1',
    stripePaymentIntentId: 'pi_main',
    purpose: 'order',
    provider: 'provider-1',
    metadata: {
      type: 'order_escrow',
      orderId: 'order-1',
      providerId: 'provider-1',
      acceptedOfferId: 'offer-1',
      destinationAccountId: 'acct_provider_1',
    },
    status: 'processing',
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function dependencies({ payment, retrieve, capture } = {}) {
  const resolvedPayment = payment || mainPayment();
  return {
    PaymentModel: {
      findById: jest.fn().mockResolvedValue(resolvedPayment),
    },
    UserModel: {
      findById: jest.fn().mockImplementation((providerId) => ({
        select: jest.fn().mockResolvedValue({
          _id: providerId,
          stripeAccountId: 'acct_provider_1',
        }),
      })),
    },
    stripeClient: {
      paymentIntents: {
        retrieve: retrieve || jest.fn().mockResolvedValue(stripeIntent()),
        capture: capture || jest.fn().mockResolvedValue(stripeIntent()),
      },
    },
    processOrderGrowthRewards: jest.fn().mockResolvedValue({ grants: [] }),
  };
}

describe('settleMainOrderPaymentForRelease', () => {
  test('loads the canonical main Payment only by order.paymentId', async () => {
    const order = systemOrder();
    const deps = dependencies();

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result.ok).toBe(true);
    expect(deps.PaymentModel.findById).toHaveBeenCalledTimes(1);
    expect(deps.PaymentModel.findById).toHaveBeenCalledWith('main-payment');
    expect(result.payment._id).toBe('main-payment');
    expect(order.paymentStatus).toBe('succeeded');
    expect(order.paidInSystem).toBe(true);
  });

  test('captures requires_capture and updates state only after Stripe confirms succeeded', async () => {
    const order = systemOrder();
    const payment = mainPayment();
    const retrieve = jest.fn().mockResolvedValue(stripeIntent('requires_capture'));
    const capture = jest.fn().mockResolvedValue(stripeIntent());
    const deps = dependencies({ payment, retrieve, capture });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result.ok).toBe(true);
    expect(capture).toHaveBeenCalledWith('pi_main');
    expect(payment.status).toBe('succeeded');
    expect(payment.save).toHaveBeenCalledTimes(1);
    expect(order.payment.status).toBe('paid');
  });

  test('captures a destination charge only when its current provider binding is complete', async () => {
    const order = systemOrder();
    const payment = mainPayment();
    const retrieve = jest.fn().mockResolvedValue(stripeIntent('requires_capture'));
    const capture = jest.fn().mockResolvedValue(stripeIntent());
    const deps = dependencies({ payment, retrieve, capture });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result.ok).toBe(true);
    expect(deps.UserModel.findById).toHaveBeenCalledWith('provider-1');
    expect(capture).toHaveBeenCalledWith('pi_main');
    expect(payment.save).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      'provider',
      stripeIntent('requires_capture', {
        metadata: { providerId: 'provider-2' },
      }),
    ],
    [
      'accepted offer',
      stripeIntent('requires_capture', {
        metadata: { acceptedOfferId: 'offer-2' },
      }),
    ],
    [
      'destination account',
      stripeIntent('requires_capture', {
        transfer_data: { destination: 'acct_attacker' },
      }),
    ],
  ])('does not capture when the Stripe %s binding is wrong', async (_label, intent) => {
    const payment = mainPayment();
    const retrieve = jest.fn().mockResolvedValue(intent);
    const capture = jest.fn();
    const deps = dependencies({ payment, retrieve, capture });

    const result = await settleMainOrderPaymentForRelease(systemOrder(), deps);

    expect(result).toMatchObject({ ok: false, reason: 'destination_charge_mismatch' });
    expect(capture).not.toHaveBeenCalled();
    expect(payment.save).not.toHaveBeenCalled();
  });

  test.each([
    ['provider', { providerId: 'provider-2' }],
    ['accepted offer', { acceptedOfferId: 'offer-2' }],
    ['destination account', { destinationAccountId: undefined }],
  ])('does not capture when the local Payment %s binding is wrong or missing', async (
    _label,
    metadataOverride
  ) => {
    const canonicalMetadata = mainPayment().metadata;
    const payment = mainPayment({
      metadata: {
        ...canonicalMetadata,
        ...metadataOverride,
      },
    });
    const capture = jest.fn();
    const deps = dependencies({
      payment,
      retrieve: jest.fn().mockResolvedValue(stripeIntent('requires_capture')),
      capture,
    });

    const result = await settleMainOrderPaymentForRelease(systemOrder(), deps);

    expect(result).toMatchObject({ ok: false, reason: 'destination_charge_mismatch' });
    expect(capture).not.toHaveBeenCalled();
    expect(payment.save).not.toHaveBeenCalled();
  });

  test('does not finalize when capture returns a changed destination', async () => {
    const order = systemOrder();
    const payment = mainPayment();
    const retrieve = jest.fn().mockResolvedValue(stripeIntent('requires_capture'));
    const capture = jest.fn().mockResolvedValue(stripeIntent('succeeded', {
      transfer_data: { destination: 'acct_attacker' },
    }));
    const deps = dependencies({ payment, retrieve, capture });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'destination_charge_mismatch' });
    expect(capture).toHaveBeenCalledWith('pi_main');
    expect(payment.save).not.toHaveBeenCalled();
    expect(order.paymentStatus).toBe('processing');
    expect(order.paidInSystem).toBe(false);
  });

  test('does not finalize when post-capture retrieve shows a changed destination', async () => {
    const order = systemOrder();
    const payment = mainPayment();
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce(stripeIntent('requires_capture'))
      .mockResolvedValueOnce(stripeIntent('succeeded', {
        transfer_data: { destination: 'acct_attacker' },
      }));
    const capture = jest.fn().mockRejectedValue(new Error('network failure'));
    const deps = dependencies({ payment, retrieve, capture });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'destination_charge_mismatch' });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(payment.save).not.toHaveBeenCalled();
    expect(order.paymentStatus).toBe('processing');
  });

  test('capture does not activate paid protection when it was not selected', async () => {
    const order = systemOrder({
      protectionEligible: false,
      protectionStatus: 'inactive',
      pricing: { includeGuarantee: false, guaranteeFee: 0 },
    });
    const deps = dependencies();

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result.ok).toBe(true);
    expect(order.protectionEligible).toBe(false);
    expect(order.protectionStatus).toBe('inactive');
    expect(order.protectionExpiresAt).toBeNull();
  });

  test('capture preserves purchased protection', async () => {
    const order = systemOrder({
      protectionEligible: true,
      protectionStatus: 'active',
      pricing: { includeGuarantee: true, guaranteeFee: 7 },
    });
    const deps = dependencies();

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result.ok).toBe(true);
    expect(order.protectionEligible).toBe(true);
    expect(order.protectionStatus).toBe('active');
    expect(order.protectionExpiresAt).toBeInstanceOf(Date);
  });

  test('preserves partial-refund accounting after a dispute capture', async () => {
    const order = systemOrder({
      paymentStatus: 'partial_refund',
      protectionEligible: false,
      protectionStatus: 'void',
      payment: {
        status: 'partial_refund',
        additionalPaymentId: 'additional-payment',
      },
    });
    const payment = mainPayment({ status: 'partial_refund' });
    const deps = dependencies({ payment });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result.ok).toBe(true);
    expect(payment.status).toBe('partial_refund');
    expect(order.paymentStatus).toBe('partial_refund');
    expect(order.payment.status).toBe('partial_refund');
    expect(order.protectionStatus).toBe('void');
    expect(order.protectionEligible).toBe(false);
  });

  test('fails closed when the main payment was fully refunded', async () => {
    const order = systemOrder({
      paymentStatus: 'refunded',
      payment: { status: 'refunded', additionalPaymentId: 'additional-payment' },
    });
    const payment = mainPayment({ status: 'refunded' });
    const deps = dependencies({ payment });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'payment_refunded' });
    expect(deps.stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(payment.save).not.toHaveBeenCalled();
    expect(order.paymentStatus).toBe('refunded');
  });

  test('rejects a stale or underfunded Stripe intent before capture', async () => {
    const order = systemOrder();
    const payment = mainPayment();

    expect(validateMainStripeIntent(order, payment, stripeIntent('requires_capture', {
      id: 'pi_stale',
    }))).toMatchObject({ ok: false, reason: 'payment_intent_mismatch' });
    expect(validateMainStripeIntent(order, payment, stripeIntent('requires_capture', {
      amount: 9_999,
    }))).toMatchObject({ ok: false, reason: 'payment_amount_mismatch' });
    expect(validateMainStripeIntent(order, payment, stripeIntent('requires_capture', {
      currency: 'eur',
    }))).toMatchObject({ ok: false, reason: 'payment_currency_mismatch' });
    expect(validateMainStripeIntent(order, payment, stripeIntent('requires_capture', {
      metadata: { orderId: '' },
    }))).toMatchObject({ ok: false, reason: 'payment_intent_mismatch' });
  });

  test('fails closed when capture errors and a second retrieve does not confirm success', async () => {
    const order = systemOrder();
    const payment = mainPayment();
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce(stripeIntent('requires_capture'))
      .mockResolvedValueOnce(stripeIntent('requires_capture'));
    const capture = jest.fn().mockRejectedValue(new Error('network failure'));
    const deps = dependencies({ payment, retrieve, capture });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'stripe_capture_failed' });
    expect(payment.save).not.toHaveBeenCalled();
    expect(order.paymentStatus).toBe('processing');
    expect(order.paidInSystem).toBe(false);
  });

  test('fails closed when Stripe is unavailable', async () => {
    const order = systemOrder();
    const deps = dependencies();
    deps.stripeClient = null;

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'stripe_unavailable' });
    expect(deps.PaymentModel.findById).not.toHaveBeenCalled();
    expect(order.paymentStatus).toBe('processing');
  });

  test('rejects an ambiguous main/additional Payment reference', async () => {
    const order = systemOrder({
      payment: { status: 'requires_payment', additionalPaymentId: 'main-payment' },
    });
    const deps = dependencies();

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'ambiguous_payment_reference' });
    expect(deps.PaymentModel.findById).not.toHaveBeenCalled();
  });

  test('rejects an order.paymentId that points at a special payment', async () => {
    const order = systemOrder();
    const payment = mainPayment({ metadata: { type: 'additional_payment' } });
    const deps = dependencies({ payment });

    const result = await settleMainOrderPaymentForRelease(order, deps);

    expect(result).toMatchObject({ ok: false, reason: 'main_payment_not_escrow' });
    expect(deps.stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe('releaseOrderEscrowToProvider', () => {
  test('does not release the order when Stripe cannot confirm payment', async () => {
    const order = systemOrder();
    const payment = mainPayment();
    const retrieve = jest.fn().mockResolvedValue(stripeIntent('processing'));
    const deps = dependencies({ payment, retrieve });

    const result = await releaseOrderEscrowToProvider(order, deps);

    expect(result).toMatchObject({ released: false, reason: 'stripe_payment_not_succeeded' });
    expect(order.status).toBe('completed');
    expect(order.save).not.toHaveBeenCalled();
    expect(deps.processOrderGrowthRewards).not.toHaveBeenCalled();
  });

  test('releases the system order after confirmed Stripe success', async () => {
    const order = systemOrder();
    const deps = dependencies();

    const result = await releaseOrderEscrowToProvider(order, deps);

    expect(result).toEqual({ released: true });
    expect(order.status).toBe('released');
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(deps.processOrderGrowthRewards).toHaveBeenCalledWith(order);
  });

  test('only the atomic release winner grants growth rewards', async () => {
    const order = systemOrder();
    const deps = dependencies();
    deps.OrderModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    };

    const result = await releaseOrderEscrowToProvider(order, deps);

    expect(result).toEqual({ released: false, reason: 'already_released' });
    expect(deps.OrderModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'order-1', status: 'completed' },
      {
        $set: expect.objectContaining({
          status: 'releasing',
          releasePreviousStatus: 'completed',
          releaseStartedAt: expect.any(Date),
        }),
      },
      { new: true, runValidators: true }
    );
    expect(deps.processOrderGrowthRewards).not.toHaveBeenCalled();
  });

  test('claims before Stripe settlement and finalizes the claimed order once', async () => {
    const order = systemOrder();
    const deps = dependencies();
    deps.OrderModel = {
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce({ _id: 'order-1', status: 'releasing' })
        .mockResolvedValueOnce({ _id: 'order-1', status: 'released' }),
      updateOne: jest.fn(),
    };

    const result = await releaseOrderEscrowToProvider(order, deps);

    expect(result).toEqual({ released: true });
    expect(deps.OrderModel.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: 'order-1', status: 'completed' },
      {
        $set: expect.objectContaining({
          status: 'releasing',
          releasePreviousStatus: 'completed',
          releaseStartedAt: expect.any(Date),
        }),
      },
      { new: true, runValidators: true }
    );
    expect(deps.OrderModel.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: 'order-1', status: 'releasing' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'released' }) }),
      { new: true, runValidators: true }
    );
    expect(deps.processOrderGrowthRewards).toHaveBeenCalledTimes(1);
  });

  test('external client-confirmed flow can close without inventing an in-system payment', async () => {
    const order = systemOrder({
      paymentPreference: 'external',
      paymentId: null,
      paymentStatus: 'unpaid',
    });
    const deps = dependencies();
    deps.stripeClient = null;

    const result = await releaseOrderEscrowToProvider(order, deps);

    expect(result).toEqual({ released: true });
    expect(order.status).toBe('released');
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.paidInSystem).toBe(false);
    expect(order.protectionEligible).toBe(false);
    expect(deps.PaymentModel.findById).not.toHaveBeenCalled();
  });
});
