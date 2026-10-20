const ordersRouter = require('../../routes/orders');
const {
  AcceptanceValidationError,
  buildAcceptancePricing,
  resolveAcceptancePaymentFlow,
} = require('../../utils/offerAcceptance');
const {
  allowsPlatformDispute,
  isExternalOrderPayment,
} = require('../../utils/orderPaymentFlow');

const {
  applyProviderCompletionState,
  canConfirmReceipt,
  getStartWorkBlock,
  resolveServerInitialOrderStatus,
  validateOrderCompletionInput,
} = ordersRouter.__testables;

describe('complete client-provider lifecycle matrix', () => {
  test.each([
    ['open marketplace', 'open', 'collecting_offers'],
    ['manual provider selection', 'manual_pick', 'open'],
    ['AI provider suggestion', 'ai_suggested', 'open'],
  ])('%s publishes into a valid offer state', (_name, matchMode, expected) => {
    expect(resolveServerInitialOrderStatus(matchMode)).toBe(expected);
  });

  test.each([
    ['system', 'system', false, 'system'],
    ['external', 'external', false, 'external'],
    ['offers-only forces external', 'system', true, 'external'],
    ['both: system selected', 'both', false, 'system', 'system'],
    ['both: external selected', 'both', false, 'external', 'external'],
  ])('%s resolves the authoritative acceptance flow', (
    _name,
    orderPreference,
    isOffersOnlyOrder,
    expected,
    requestedPaymentMethod = orderPreference
  ) => {
    expect(resolveAcceptancePaymentFlow({
      orderPreference,
      requestedPaymentMethod,
      isOffersOnlyOrder,
    })).toBe(expected);
  });

  test('both requires an explicit final choice', () => {
    expect(() => resolveAcceptancePaymentFlow({
      orderPreference: 'both',
      requestedPaymentMethod: 'both',
    })).toThrow(AcceptanceValidationError);
  });

  test('system flow: accept -> fund -> start -> complete -> client confirmation', () => {
    const accepted = {
      provider: 'provider-1',
      status: 'accepted',
      paymentPreference: 'system',
      paymentStatus: 'unpaid',
    };
    expect(getStartWorkBlock(accepted, 'provider-1')).toEqual(expect.objectContaining({ status: 409 }));

    const funded = { ...accepted, status: 'funded', paymentStatus: 'processing' };
    expect(getStartWorkBlock(funded, 'provider-1')).toBeNull();

    const inProgress = { ...funded, status: 'in_progress' };
    applyProviderCompletionState(inProgress, new Date('2026-10-20T12:00:00.000Z'));
    expect(inProgress).toEqual(expect.objectContaining({
      status: 'completed',
      clientCompletionStatus: 'pending',
      clientCompletionAcceptedAt: null,
    }));
    expect(canConfirmReceipt(inProgress)).toBe(true);
    expect(allowsPlatformDispute(inProgress)).toBe(true);
  });

  test('external flow: commission gate -> start -> complete without platform-payment claim', () => {
    const accepted = {
      provider: 'provider-1',
      status: 'accepted',
      paymentPreference: 'external',
      pricing: { platformFee: 5 },
      externalCommissionStatus: 'unpaid',
    };
    expect(isExternalOrderPayment(accepted)).toBe(true);
    expect(getStartWorkBlock(accepted, 'provider-1')).toEqual(expect.objectContaining({ status: 409 }));
    expect(allowsPlatformDispute(accepted)).toBe(false);

    const ready = { ...accepted, externalCommissionStatus: 'succeeded' };
    expect(getStartWorkBlock(ready, 'provider-1')).toBeNull();

    const pricing = buildAcceptancePricing({
      baseAmount: 100,
      platformFee: 5,
      paymentFlow: 'external',
      includeGuarantee: true,
    });
    expect(pricing).toMatchObject({ guaranteeFee: 0, includeGuarantee: false });

    const inProgress = { ...ready, status: 'in_progress' };
    applyProviderCompletionState(inProgress);
    expect(inProgress.status).toBe('completed');
    expect(inProgress.clientCompletionStatus).toBe('pending');
    expect(canConfirmReceipt(inProgress)).toBe(true);
  });

  test.each(['succeeded', 'waived'])(
    'offers-only: accepted contact with %s unlock can start outside the platform',
    (contactUnlockStatus) => {
      const order = {
        provider: 'provider-1',
        status: 'accepted',
        orderMode: 'offers_only',
        paymentPreference: 'external',
        contactUnlockStatus,
        pricing: { platformFee: 0 },
      };
      expect(getStartWorkBlock(order, 'provider-1')).toBeNull();
      expect(allowsPlatformDispute(order)).toBe(false);
    }
  );

  test.each(['unpaid', 'processing'])(
    'offers-only: %s contact unlock blocks provider start',
    (contactUnlockStatus) => {
      expect(getStartWorkBlock({
        provider: 'provider-1',
        status: 'accepted',
        orderMode: 'offers_only',
        paymentPreference: 'external',
        contactUnlockStatus,
        pricing: { platformFee: 0 },
      }, 'provider-1')).toEqual(expect.objectContaining({ status: 409 }));
    }
  );

  test('another provider can never start or complete the selected provider flow', () => {
    expect(getStartWorkBlock({
      provider: 'provider-1',
      status: 'funded',
      paymentPreference: 'system',
    }, 'provider-2')).toEqual(expect.objectContaining({ status: 403 }));
  });

  test.each([
    ['simple', { completionType: 'simple' }],
    ['with notes', { completionType: 'with_notes', completionNotes: 'Usługa zakończona zgodnie z ustaleniami' }],
    ['with additional payment', { completionType: 'with_payment', additionalAmount: '75.50', paymentReason: 'Dodatkowa część' }],
  ])('accepts valid completion variant: %s', (_name, payload) => {
    expect(validateOrderCompletionInput(payload)).toBeNull();
  });

  test.each([
    ['unknown type', { completionType: 'invalid' }, /typ zakończenia/i],
    ['empty notes', { completionType: 'with_notes', completionNotes: '   ' }, /uwagi/i],
    ['non-string notes', { completionType: 'with_notes', completionNotes: 123 }, /uwagi/i],
    ['zero additional payment', { completionType: 'with_payment', additionalAmount: 0, paymentReason: 'część' }, /kwota/i],
    ['invalid additional payment', { completionType: 'with_payment', additionalAmount: 'abc', paymentReason: 'część' }, /kwota/i],
    ['missing payment reason', { completionType: 'with_payment', additionalAmount: 50, paymentReason: ' ' }, /uzasadnienie/i],
  ])('rejects invalid completion variant: %s', (_name, payload, expected) => {
    expect(validateOrderCompletionInput(payload)).toMatch(expected);
  });

  test.each([
    ['open', false],
    ['accepted', false],
    ['funded', false],
    ['in_progress', false],
    ['completed', true],
    ['released', false],
    ['disputed', false],
    ['cancelled', false],
  ])('client receipt confirmation is %s for status %s', (status, expected) => {
    expect(canConfirmReceipt({ status })).toBe(expected);
  });
});
