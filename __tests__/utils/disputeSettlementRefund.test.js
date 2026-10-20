const {
  applyDisputeSettlementRefund,
  buildDisputeSettlementExecutionScope,
  __testables: { validatePaymentIntentBinding },
} = require('../../utils/disputeSettlementRefund');

function createExecutionModel() {
  const rows = new Map();

  return class FakeExecution {
    constructor(data) {
      Object.assign(this, data);
      this.summary = data.summary || null;
      this.lastError = data.lastError || '';
      this.save = jest.fn(async () => {
        rows.set(this.executionKey, this);
        return this;
      });
    }

    static async findOne(filter) {
      return rows.get(filter.executionKey) || null;
    }

    static get rows() {
      return rows;
    }
  };
}

const ORDER_ID = 'order-1';
const CLIENT_ID = 'client-1';
const PROVIDER_ID = 'provider-1';
const OFFER_ID = 'offer-1';
const DESTINATION_ID = 'acct_provider_1';

function bindingMetadata(role, amount) {
  const type = role === 'additional' ? 'additional_payment' : 'order_escrow';
  return {
    type,
    orderId: ORDER_ID,
    clientId: CLIENT_ID,
    providerId: PROVIDER_ID,
    acceptedOfferId: OFFER_ID,
    destinationAccountId: DESTINATION_ID,
    ...(role === 'additional'
      ? { subtype: type, additionalAmount: String(amount) }
      : { stripeAmount: amount }),
  };
}

function payment(id, intentId, amount, role = 'main') {
  return {
    _id: id,
    order: ORDER_ID,
    purpose: 'order',
    client: CLIENT_ID,
    provider: PROVIDER_ID,
    stripePaymentIntentId: intentId,
    amount,
    currency: 'pln',
    status: 'succeeded',
    metadata: bindingMetadata(role, amount),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function legacyPayment(id, intentId, amount, role = 'main') {
  const commonMetadata = {
    orderId: ORDER_ID,
    clientId: CLIENT_ID,
    providerId: PROVIDER_ID,
  };
  return {
    _id: id,
    order: ORDER_ID,
    purpose: 'order',
    client: CLIENT_ID,
    provider: PROVIDER_ID,
    stripePaymentIntentId: intentId,
    amount,
    currency: 'pln',
    pointsDiscount: 0,
    metadata: role === 'additional'
      ? {
          ...commonMetadata,
          type: 'additional_payment',
          subtype: 'additional_payment',
          additionalAmount: String(amount),
        }
      : {
          ...commonMetadata,
          stripeAmount: amount,
          clientPaidAmount: amount,
          pointsDiscount: '0',
        },
  };
}

function legacyIntent(intentId, amount, role = 'main', destination = null) {
  const commonMetadata = {
    orderId: ORDER_ID,
    clientId: CLIENT_ID,
    providerId: PROVIDER_ID,
  };
  return {
    id: intentId,
    amount,
    currency: 'pln',
    capture_method: role === 'main' ? 'manual' : 'automatic',
    metadata: role === 'additional'
      ? {
          ...commonMetadata,
          type: 'additional_payment',
          additionalAmount: String(amount),
        }
      : {
          ...commonMetadata,
          clientPaidAmount: String(amount),
          pointsDiscount: '0',
        },
    ...(destination ? { transfer_data: { destination } } : {}),
  };
}

function order(overrides = {}) {
  return {
    _id: ORDER_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    disputeReportedAt: new Date('2026-01-02T00:00:00.000Z'),
    paymentPreference: 'system',
    client: CLIENT_ID,
    provider: PROVIDER_ID,
    acceptedOfferId: OFFER_ID,
    amountTotal: 10_000,
    additionalAmount: 100,
    currency: 'pln',
    paymentId: 'payment-main',
    paymentStatus: 'succeeded',
    additionalPaymentStatus: 'succeeded',
    payment: {
      status: 'paid',
      intentId: 'pi_main',
      additionalIntentId: 'pi_additional',
      additionalPaymentId: 'payment-additional',
    },
    disputeSettlement: {
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      offeredBy: 'client-1',
      amountPln: 150,
    },
    ...overrides,
  };
}

function createSucceededStripe(
  chargeSpecs,
  {
    crashAfterFirstRefund = false,
    crashAfterRefundCalls = [],
    refundStatus = 'succeeded',
  } = {}
) {
  const charges = new Map(
    Object.entries(chargeSpecs).map(([intentId, spec]) => [intentId, {
      id: spec.id,
      amount: spec.amount,
      amount_refunded: 0,
      transfer: spec.transfer || null,
    }])
  );
  const refunds = [];
  const crashCalls = new Set([
    ...(crashAfterFirstRefund ? [1] : []),
    ...crashAfterRefundCalls,
  ]);
  let refundCreateCall = 0;

  const client = {
    paymentIntents: {
      retrieve: jest.fn(async (intentId) => {
        const role = intentId === 'pi_additional' ? 'additional' : 'main';
        const amount = charges.get(intentId).amount;
        return {
          id: intentId,
          status: 'succeeded',
          amount,
          currency: 'pln',
          amount_received: amount,
          metadata: bindingMetadata(role, amount),
          transfer_data: { destination: DESTINATION_ID },
          latest_charge: charges.get(intentId),
        };
      }),
      capture: jest.fn(),
      cancel: jest.fn(),
    },
    charges: {
      retrieve: jest.fn(async (chargeId) =>
        [...charges.values()].find((charge) => charge.id === chargeId)
      ),
    },
    refunds: {
      list: jest.fn(async ({ charge }) => ({
        data: refunds.filter((refund) => refund.charge === charge),
        has_more: false,
      })),
      create: jest.fn(async (payload) => {
        refundCreateCall += 1;
        const charge = [...charges.values()].find((row) => row.id === payload.charge);
        const refund = {
          id: `re_${refunds.length + 1}`,
          charge: payload.charge,
          amount: payload.amount,
          status: refundStatus,
          metadata: payload.metadata,
        };
        refunds.push(refund);
        charge.amount_refunded += payload.amount;
        if (crashCalls.has(refundCreateCall)) {
          throw new Error('connection lost after Stripe accepted the refund');
        }
        return refund;
      }),
    },
  };

  return { client, refunds, charges };
}

function createOrderModel() {
  let claimedExecutionKey = null;
  let startedAt = null;
  return {
    findOneAndUpdate: jest.fn(async (_filter, update) => {
      const requestedKey = update.$set['disputeSettlement.refundExecutionKey'];
      if (claimedExecutionKey && claimedExecutionKey !== requestedKey) return null;
      claimedExecutionKey = requestedKey;
      startedAt = update.$set['disputeSettlement.refundExecutionStartedAt'];
      return {
        _id: ORDER_ID,
        disputeSettlement: {
          refundExecutionKey: claimedExecutionKey,
          refundExecutionStartedAt: startedAt,
        },
      };
    }),
    get claimedExecutionKey() {
      return claimedExecutionKey;
    },
  };
}

function dependencies({
  mainPayment,
  additionalPayment,
  stripeClient,
  ExecutionModel,
  OrderModel = createOrderModel(),
}) {
  const payments = new Map([
    [String(mainPayment._id), mainPayment],
    ...(additionalPayment
      ? [[String(additionalPayment._id), additionalPayment]]
      : []),
  ]);
  return {
    PaymentModel: {
      findById: jest.fn(async (id) => payments.get(String(id)) || null),
    },
    OrderModel,
    ExecutionModel,
    stripeClient,
  };
}

describe('applyDisputeSettlementRefund durable journal', () => {
  test('keeps the fixed main/additional allocation after a refund succeeded but the process lost the response', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const additionalPayment = payment(
      'payment-additional',
      'pi_additional',
      10_000,
      'additional'
    );
    const ExecutionModel = createExecutionModel();
    const stripe = createSucceededStripe(
      {
        pi_main: { id: 'ch_main', amount: 10_000 },
        pi_additional: { id: 'ch_additional', amount: 10_000 },
      },
      { crashAfterRefundCalls: [1, 2] }
    );
    const deps = dependencies({
      mainPayment,
      additionalPayment,
      stripeClient: stripe.client,
      ExecutionModel,
    });
    const testOrder = order();
    const options = {
      idempotencyScope: 'settlement-order-1-2026-01-03-15000',
      dependencies: deps,
    };

    const interrupted = await applyDisputeSettlementRefund(testOrder, 150, options);

    expect(interrupted).toMatchObject({ ok: false, code: 'STRIPE_ERROR' });
    const [journal] = [...ExecutionModel.rows.values()];
    expect(journal.parts.map((part) => part.amountGrosze)).toEqual([10_000, 5_000]);
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0]).toMatchObject({ charge: 'ch_main', amount: 10_000 });

    const interruptedAfterAdditional = await applyDisputeSettlementRefund(
      testOrder,
      150,
      options
    );

    expect(interruptedAfterAdditional).toMatchObject({
      ok: false,
      code: 'STRIPE_ERROR',
    });
    expect(stripe.refunds).toHaveLength(2);
    expect(stripe.refunds[1]).toMatchObject({
      charge: 'ch_additional',
      amount: 5_000,
    });
    expect(journal.parts.map((part) => part.amountGrosze)).toEqual([10_000, 5_000]);

    const retried = await applyDisputeSettlementRefund(testOrder, 150, options);

    expect(retried).toMatchObject({
      ok: true,
      amountGrosze: 15_000,
      method: 'split_refund',
      orderPaymentStatus: 'refunded',
      additionalPaymentStatus: 'partial_refund',
    });
    expect(stripe.client.refunds.create.mock.calls.map(([payload]) => payload.amount)).toEqual([
      10_000,
      5_000,
    ]);
    expect(stripe.refunds.reduce((sum, refund) => sum + refund.amount, 0)).toBe(15_000);
    expect(mainPayment.status).toBe('refunded');
    expect(additionalPayment.status).toBe('partial_refund');

    const callsAfterSuccess = stripe.client.refunds.create.mock.calls.length;
    const replayedAfterOrderSaveCrash = await applyDisputeSettlementRefund(
      testOrder,
      150,
      options
    );
    expect(replayedAfterOrderSaveCrash).toEqual(retried);
    expect(stripe.client.refunds.create).toHaveBeenCalledTimes(callsAfterSuccess);
  });

  test('reconciles an exact partial capture after a crash instead of refunding or capturing again', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    const state = {
      id: 'pi_main',
      status: 'requires_capture',
      amount: 10_000,
      amount_capturable: 10_000,
      amount_received: 0,
      currency: 'pln',
      application_fee_amount: 2_000,
      metadata: bindingMetadata('main', 10_000),
      transfer_data: { destination: DESTINATION_ID },
      latest_charge: null,
    };
    let crashPending = true;
    const stripeClient = {
      paymentIntents: {
        retrieve: jest.fn(async () => ({ ...state })),
        capture: jest.fn(async (_id, payload) => {
          state.status = 'succeeded';
          state.amount_capturable = 0;
          state.amount_received = payload.amount_to_capture;
          state.application_fee_amount = payload.application_fee_amount;
          state.latest_charge = {
            id: 'ch_partial',
            amount: payload.amount_to_capture,
            amount_captured: payload.amount_to_capture,
          };
          if (crashPending) {
            crashPending = false;
            throw new Error('connection lost after Stripe captured');
          }
          return { ...state };
        }),
        cancel: jest.fn(),
      },
      charges: { retrieve: jest.fn() },
      refunds: { list: jest.fn(), create: jest.fn() },
    };
    const deps = dependencies({
      mainPayment,
      stripeClient,
      ExecutionModel,
    });
    const testOrder = order({
      payment: {
        status: 'paid',
        intentId: 'pi_main',
        additionalIntentId: null,
        additionalPaymentId: null,
      },
      additionalPaymentStatus: null,
    });
    const options = {
      idempotencyScope: 'settlement-partial-capture',
      dependencies: deps,
    };

    const interrupted = await applyDisputeSettlementRefund(testOrder, 30, options);
    expect(interrupted).toMatchObject({ ok: false, code: 'STRIPE_ERROR' });
    expect(state.amount_received).toBe(7_000);

    const retried = await applyDisputeSettlementRefund(testOrder, 30, options);

    expect(retried).toMatchObject({
      ok: true,
      amountGrosze: 3_000,
      method: 'partial_capture',
      orderPaymentStatus: 'partial_refund',
    });
    expect(stripeClient.paymentIntents.capture).toHaveBeenCalledTimes(1);
    expect(stripeClient.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_main',
      { amount_to_capture: 7_000, application_fee_amount: 1_400 },
      { idempotencyKey: expect.stringMatching(/^dsr_part_/) }
    );
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    expect(mainPayment.status).toBe('partial_refund');
  });

  test('passes cancel idempotency in Stripe request options', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 5_000);
    const ExecutionModel = createExecutionModel();
    let status = 'requires_capture';
    const stripeClient = {
      paymentIntents: {
        retrieve: jest.fn(async () => ({
          id: 'pi_main',
          status,
          amount: 5_000,
          amount_capturable: 5_000,
          currency: 'pln',
          metadata: bindingMetadata('main', 5_000),
          transfer_data: { destination: DESTINATION_ID },
        })),
        capture: jest.fn(),
        cancel: jest.fn(async () => {
          status = 'canceled';
          return { id: 'pi_main', status };
        }),
      },
      charges: { retrieve: jest.fn() },
      refunds: { list: jest.fn(), create: jest.fn() },
    };
    const deps = dependencies({
      mainPayment,
      stripeClient,
      ExecutionModel,
    });
    const testOrder = order({
      amountTotal: 5_000,
      payment: {
        status: 'paid',
        intentId: 'pi_main',
        additionalIntentId: null,
        additionalPaymentId: null,
      },
      additionalPaymentStatus: null,
    });

    const result = await applyDisputeSettlementRefund(testOrder, 50, {
      idempotencyScope: 'settlement-full-cancel',
      dependencies: deps,
    });

    expect(result).toMatchObject({ ok: true, method: 'cancel', amountGrosze: 5_000 });
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_main',
      {},
      { idempotencyKey: expect.stringMatching(/^dsr_part_/) }
    );
  });

  test('scales an application fee below a small partial-capture amount', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    let state = {
      id: 'pi_main',
      status: 'requires_capture',
      amount: 10_000,
      amount_capturable: 10_000,
      amount_received: 0,
      currency: 'pln',
      application_fee_amount: 5_000,
      metadata: bindingMetadata('main', 10_000),
      transfer_data: { destination: DESTINATION_ID },
      latest_charge: null,
    };
    const stripeClient = {
      paymentIntents: {
        retrieve: jest.fn(async () => ({ ...state })),
        capture: jest.fn(async (_id, payload) => {
          state = {
            ...state,
            status: 'succeeded',
            amount_capturable: 0,
            amount_received: payload.amount_to_capture,
            application_fee_amount: payload.application_fee_amount,
            latest_charge: {
              id: 'ch_small_capture',
              amount: payload.amount_to_capture,
              amount_captured: payload.amount_to_capture,
            },
          };
          return { ...state };
        }),
        cancel: jest.fn(),
      },
      charges: { retrieve: jest.fn() },
      refunds: { list: jest.fn(), create: jest.fn() },
    };
    const deps = dependencies({
      mainPayment,
      stripeClient,
      ExecutionModel,
    });
    const testOrder = order({
      payment: {
        status: 'paid',
        intentId: 'pi_main',
        additionalIntentId: null,
        additionalPaymentId: null,
      },
      additionalPaymentStatus: null,
    });

    const result = await applyDisputeSettlementRefund(testOrder, 90, {
      idempotencyScope: 'settlement-small-partial-capture',
      dependencies: deps,
    });

    expect(result).toMatchObject({ ok: true, method: 'partial_capture' });
    expect(stripeClient.paymentIntents.capture).toHaveBeenCalledWith(
      'pi_main',
      { amount_to_capture: 1_000, application_fee_amount: 500 },
      { idempotencyKey: expect.stringMatching(/^dsr_part_/) }
    );
  });

  test('plans the complete split before Stripe and applies nothing when total funds are insufficient', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    const stripe = createSucceededStripe({
      pi_main: { id: 'ch_main', amount: 10_000 },
    });
    const deps = dependencies({
      mainPayment,
      stripeClient: stripe.client,
      ExecutionModel,
    });
    const testOrder = order({
      payment: {
        status: 'paid',
        intentId: 'pi_main',
        additionalIntentId: null,
        additionalPaymentId: null,
      },
      additionalPaymentStatus: null,
    });

    const result = await applyDisputeSettlementRefund(testOrder, 150, {
      idempotencyScope: 'settlement-insufficient',
      dependencies: deps,
    });

    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_REFUNDABLE' });
    expect(stripe.client.refunds.create).not.toHaveBeenCalled();
    expect(ExecutionModel.rows.size).toBe(0);
    expect(deps.OrderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not materialize a pending refund and completes only after Stripe changes it to succeeded', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    const stripe = createSucceededStripe(
      { pi_main: { id: 'ch_main', amount: 10_000 } },
      { refundStatus: 'pending' }
    );
    const deps = dependencies({
      mainPayment,
      stripeClient: stripe.client,
      ExecutionModel,
    });
    const testOrder = order();
    const options = {
      idempotencyScope: 'settlement-pending-to-succeeded',
      dependencies: deps,
    };

    const pending = await applyDisputeSettlementRefund(testOrder, 100, options);

    expect(pending).toMatchObject({ ok: false, code: 'REFUND_PENDING' });
    expect(mainPayment.status).toBe('succeeded');
    const [journal] = [...ExecutionModel.rows.values()];
    expect(journal.status).toBe('processing');
    expect(journal.parts[0].status).toBe('processing');

    stripe.refunds[0].status = 'succeeded';
    const completed = await applyDisputeSettlementRefund(testOrder, 100, options);

    expect(completed).toMatchObject({ ok: true, amountGrosze: 10_000 });
    expect(mainPayment.status).toBe('refunded');
    expect(stripe.client.refunds.create).toHaveBeenCalledTimes(1);
  });

  test('keeps local payment unchanged when a pending Stripe refund later fails', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    const stripe = createSucceededStripe(
      { pi_main: { id: 'ch_main', amount: 10_000 } },
      { refundStatus: 'pending' }
    );
    const deps = dependencies({
      mainPayment,
      stripeClient: stripe.client,
      ExecutionModel,
    });
    const testOrder = order();
    const options = {
      idempotencyScope: 'settlement-pending-to-failed',
      dependencies: deps,
    };

    expect(await applyDisputeSettlementRefund(testOrder, 100, options)).toMatchObject({
      ok: false,
      code: 'REFUND_PENDING',
    });
    stripe.refunds[0].status = 'failed';

    const failed = await applyDisputeSettlementRefund(testOrder, 100, options);

    expect(failed).toMatchObject({ ok: false, code: 'REFUND_FAILED' });
    expect(mainPayment.status).toBe('succeeded');
    expect(stripe.client.refunds.create).toHaveBeenCalledTimes(1);
  });

  test('rejects a contaminated Payment binding before any Stripe mutation', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    mainPayment.metadata.acceptedOfferId = 'another-offer';
    const ExecutionModel = createExecutionModel();
    const stripe = createSucceededStripe({
      pi_main: { id: 'ch_main', amount: 10_000 },
    });
    const deps = dependencies({
      mainPayment,
      stripeClient: stripe.client,
      ExecutionModel,
    });

    const result = await applyDisputeSettlementRefund(order(), 100, {
      idempotencyScope: 'settlement-invalid-binding',
      dependencies: deps,
    });

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_BINDING_CONFLICT' });
    expect(stripe.client.refunds.create).not.toHaveBeenCalled();
    expect(stripe.client.paymentIntents.capture).not.toHaveBeenCalled();
    expect(stripe.client.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(ExecutionModel.rows.size).toBe(0);
    expect(deps.OrderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('does not claim the dispute when Stripe is not configured', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    const deps = dependencies({
      mainPayment,
      stripeClient: null,
      ExecutionModel,
    });

    const result = await applyDisputeSettlementRefund(order(), 100, {
      idempotencyScope: 'settlement-no-stripe',
      dependencies: deps,
    });

    expect(result).toMatchObject({ ok: false, code: 'NO_STRIPE' });
    expect(deps.OrderModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ExecutionModel.rows.size).toBe(0);
  });

  test('an atomic Order claim allows only one of concurrent party/admin execution keys', async () => {
    const mainPayment = payment('payment-main', 'pi_main', 10_000);
    const ExecutionModel = createExecutionModel();
    const OrderModel = createOrderModel();
    const stripe = createSucceededStripe({
      pi_main: { id: 'ch_main', amount: 10_000 },
    });
    const deps = dependencies({
      mainPayment,
      stripeClient: stripe.client,
      ExecutionModel,
      OrderModel,
    });
    const testOrder = order();

    const results = await Promise.all([
      applyDisputeSettlementRefund(testOrder, 100, {
        idempotencyScope: 'party-execution-key',
        dependencies: deps,
      }),
      applyDisputeSettlementRefund(testOrder, 100, {
        idempotencyScope: 'admin-execution-key',
        dependencies: deps,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === 'REFUND_EXECUTION_CONFLICT')).toHaveLength(1);
    expect(stripe.client.refunds.create).toHaveBeenCalledTimes(1);
    // Both callers may persist a read-only immutable plan, but only the Order
    // claim winner can cross the Stripe mutation boundary.
    expect(ExecutionModel.rows.size).toBe(2);
  });

  test('scope changes for another settlement date or amount', () => {
    const first = order();
    const second = order({
      disputeSettlement: {
        ...first.disputeSettlement,
        createdAt: new Date('2026-01-04T00:00:00.000Z'),
      },
    });

    expect(buildDisputeSettlementExecutionScope(first, 'party', 150)).not.toBe(
      buildDisputeSettlementExecutionScope(second, 'party', 150)
    );
    expect(buildDisputeSettlementExecutionScope(first, 'party', 150)).not.toBe(
      buildDisputeSettlementExecutionScope(first, 'party', 149)
    );
    expect(buildDisputeSettlementExecutionScope(first, 'admin', 150)).not.toBe(
      buildDisputeSettlementExecutionScope(second, 'admin', 150)
    );
    expect(buildDisputeSettlementExecutionScope(first, 'party', 150)).toBe(
      buildDisputeSettlementExecutionScope(first, 'admin', 150)
    );
  });

  test.each([null, DESTINATION_ID])(
    'accepts an exact legacy main escrow binding for refund-only compatibility (destination %s)',
    (destination) => {
      const testOrder = order();
      expect(() => validatePaymentIntentBinding(
        testOrder,
        legacyPayment('payment-main', 'pi_main', 10_000),
        legacyIntent('pi_main', 10_000, 'main', destination),
        'main'
      )).not.toThrow();
    }
  );

  test.each([null, DESTINATION_ID])(
    'accepts an exact legacy additional-payment binding for refund-only compatibility (destination %s)',
    (destination) => {
      const testOrder = order({ additionalAmount: 100 });
      expect(() => validatePaymentIntentBinding(
        testOrder,
        legacyPayment('payment-additional', 'pi_additional', 10_000, 'additional'),
        legacyIntent('pi_additional', 10_000, 'additional', destination),
        'additional'
      )).not.toThrow();
    }
  );

  test.each([
    ['order', (paymentRecord) => { paymentRecord.order = 'another-order'; }],
    ['client', (paymentRecord) => { paymentRecord.client = 'another-client'; }],
    ['provider', (paymentRecord) => { paymentRecord.provider = 'another-provider'; }],
    ['intent', (paymentRecord) => { paymentRecord.stripePaymentIntentId = 'pi_other'; }],
    ['amount', (_paymentRecord, intent) => { intent.amount = 9_999; }],
    ['currency', (_paymentRecord, intent) => { intent.currency = 'eur'; }],
  ])('rejects a legacy main binding with mismatched %s', (_label, contaminate) => {
    const paymentRecord = legacyPayment('payment-main', 'pi_main', 10_000);
    const intent = legacyIntent('pi_main', 10_000);
    contaminate(paymentRecord, intent);

    expect(() => validatePaymentIntentBinding(order(), paymentRecord, intent, 'main')).toThrow(
      expect.objectContaining({ code: 'PAYMENT_BINDING_CONFLICT' })
    );
  });

  test('never falls back to legacy validation when a conflicting v2 marker is present', () => {
    const paymentRecord = legacyPayment('payment-main', 'pi_main', 10_000);
    paymentRecord.metadata.acceptedOfferId = 'another-offer';

    expect(() => validatePaymentIntentBinding(
      order(),
      paymentRecord,
      legacyIntent('pi_main', 10_000),
      'main'
    )).toThrow(expect.objectContaining({ code: 'PAYMENT_BINDING_CONFLICT' }));
  });

  test('routes a legacy points-discount payment to manual reconciliation', () => {
    const paymentRecord = legacyPayment('payment-main', 'pi_main', 10_000);
    const intent = legacyIntent('pi_main', 10_000);
    paymentRecord.pointsDiscount = 500;
    paymentRecord.metadata.pointsDiscount = '500';
    intent.metadata.pointsDiscount = '500';

    expect(() => validatePaymentIntentBinding(order(), paymentRecord, intent, 'main')).toThrow(
      expect.objectContaining({ code: 'MANUAL_RECONCILIATION' })
    );
  });

  test('rejects a contaminated legacy additional payment amount and type', () => {
    const testOrder = order({ additionalAmount: 100 });
    const wrongAmount = legacyPayment(
      'payment-additional',
      'pi_additional',
      10_000,
      'additional'
    );
    wrongAmount.metadata.additionalAmount = '9999';
    expect(() => validatePaymentIntentBinding(
      testOrder,
      wrongAmount,
      legacyIntent('pi_additional', 10_000, 'additional'),
      'additional'
    )).toThrow(expect.objectContaining({ code: 'PAYMENT_BINDING_CONFLICT' }));

    const wrongTypeIntent = legacyIntent('pi_additional', 10_000, 'additional');
    wrongTypeIntent.metadata.type = 'order_escrow';
    expect(() => validatePaymentIntentBinding(
      testOrder,
      legacyPayment('payment-additional', 'pi_additional', 10_000, 'additional'),
      wrongTypeIntent,
      'additional'
    )).toThrow(expect.objectContaining({ code: 'PAYMENT_BINDING_CONFLICT' }));
  });
});
