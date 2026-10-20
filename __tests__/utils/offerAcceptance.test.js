const {
  AcceptanceValidationError,
  DEFAULT_OFFER_ACCEPTANCE_LEASE_MS,
  acceptedOfferProviderMatches,
  buildAcceptanceLockFilter,
  buildAcceptancePricing,
  buildOfferReservationFilter,
  buildOfferReservationRefresh,
  buildOfferReservationRelease,
  buildOfferReservationUpdate,
  contactUnlockIsSettled,
  offerAcceptanceReservationIsStale,
  resolveAcceptancePaymentFlow,
} = require('../../utils/offerAcceptance');

describe('offer acceptance invariants', () => {
  test('requires an explicit client choice when an order allows both flows', () => {
    expect(() => resolveAcceptancePaymentFlow({
      orderPreference: 'both',
      requestedPaymentMethod: 'both',
    })).toThrow(AcceptanceValidationError);
  });

  test('uses the explicit final client choice at acceptance time', () => {
    expect(resolveAcceptancePaymentFlow({
      orderPreference: 'external',
      requestedPaymentMethod: 'system',
    })).toBe('system');
  });

  test('offers-only orders always settle externally', () => {
    expect(resolveAcceptancePaymentFlow({
      orderPreference: 'system',
      requestedPaymentMethod: 'system',
      isOffersOnlyOrder: true,
    })).toBe('external');
  });

  test('calculates the authoritative total and guarantee on the server', () => {
    expect(buildAcceptancePricing({
      baseAmount: 100,
      platformFee: 5,
      platformFeeBeforeDiscount: 5,
      platformFeePercent: 5,
      paymentFlow: 'system',
      includeGuarantee: true,
    })).toMatchObject({
      baseAmount: 100,
      platformFee: 5,
      guaranteeFee: 7,
      total: 112,
      includeGuarantee: true,
    });
  });

  test('external settlement can never enable the guarantee', () => {
    expect(buildAcceptancePricing({
      baseAmount: 100,
      platformFee: 5,
      paymentFlow: 'external',
      includeGuarantee: true,
    })).toMatchObject({ guaranteeFee: 0, total: 105, includeGuarantee: false });
  });

  test('the order lock only matches pre-acceptance states without an accepted offer', () => {
    const filter = buildAcceptanceLockFilter({ orderId: 'order', clientId: 'client' });
    expect(filter).toEqual(expect.objectContaining({
      _id: 'order',
      client: 'client',
      status: { $in: ['draft', 'open', 'collecting_offers', 'quote', 'matched'] },
    }));
    expect(filter.$or).toEqual([
      { acceptedOfferId: null },
      { acceptedOfferId: { $exists: false } },
    ]);
  });

  test('the order lock can fail closed when contact unlock settled after the snapshot', () => {
    const filter = buildAcceptanceLockFilter({
      orderId: 'order',
      clientId: 'client',
      preserveSettledContactUnlock: true,
    });
    expect(filter.contactUnlockStatus).toEqual({ $nin: ['succeeded', 'waived'] });
  });

  test('preserves only completed contact-unlock states at offer acceptance', () => {
    expect(contactUnlockIsSettled({ contactUnlockStatus: 'succeeded' })).toBe(true);
    expect(contactUnlockIsSettled({ contactUnlockStatus: 'waived' })).toBe(true);
    expect(contactUnlockIsSettled({ contactUnlockStatus: 'unpaid' })).toBe(false);
    expect(contactUnlockIsSettled({ contactUnlockStatus: 'processing' })).toBe(false);
  });

  test('requires the accepted order provider to match the offer provider', () => {
    expect(acceptedOfferProviderMatches(
      { provider: 'provider-1' },
      { providerId: 'provider-1' }
    )).toBe(true);
    expect(acceptedOfferProviderMatches(
      { provider: 'provider-2' },
      { providerId: 'provider-1' }
    )).toBe(false);
    expect(acceptedOfferProviderMatches(
      { provider: null },
      { providerId: 'provider-1' }
    )).toBe(false);
  });
});

describe('atomic offer acceptance reservation', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');

  test('only reserves the selected sent offer for the selected order while it is valid', () => {
    expect(buildOfferReservationFilter({
      offerId: 'offer',
      orderId: 'order',
      now,
    })).toEqual({
      _id: 'offer',
      orderId: 'order',
      status: 'sent',
      $or: [
        { expiresAt: { $gt: now } },
        { expiresAt: null },
        { expiresAt: { $exists: false } },
      ],
    });
  });

  test('moves a reserved offer to accepting with an owner and unique token', () => {
    expect(buildOfferReservationUpdate({
      token: 'acceptance-token',
      clientId: 'client',
      now,
    })).toEqual({
      $set: {
        status: 'accepting',
        acceptanceToken: 'acceptance-token',
        acceptanceReservedBy: 'client',
        acceptanceReservedAt: now,
      },
      $unset: {
        acceptedAt: 1,
        rejectedAt: 1,
      },
    });
  });

  test('releases only the matching active reservation back to sent', () => {
    expect(buildOfferReservationRelease({
      offerId: 'offer',
      token: 'acceptance-token',
      now,
    })).toEqual({
      filter: {
        _id: 'offer',
        status: 'accepting',
        acceptanceToken: 'acceptance-token',
      },
      update: {
        $set: { status: 'sent' },
        $unset: {
          acceptanceToken: 1,
          acceptanceReservedBy: 1,
          acceptanceReservedAt: 1,
        },
      },
    });
  });

  test('rejects a losing reservation and records the rejection time', () => {
    expect(buildOfferReservationRelease({
      offerId: 'offer',
      token: 'losing-token',
      status: 'rejected',
      now,
    })).toEqual(expect.objectContaining({
      filter: {
        _id: 'offer',
        status: 'accepting',
        acceptanceToken: 'losing-token',
      },
      update: expect.objectContaining({
        $set: {
          status: 'rejected',
          rejectedAt: now,
        },
      }),
    }));
  });

  test('stale release is fenced by the exact reservation timestamp', () => {
    expect(buildOfferReservationRelease({
      offerId: 'offer',
      token: 'stale-token',
      expectedReservedAt: now,
    }).filter).toEqual({
      _id: 'offer',
      status: 'accepting',
      acceptanceToken: 'stale-token',
      acceptanceReservedAt: now,
    });
  });

  test('refreshes only the currently owned reservation before claiming the order', () => {
    expect(buildOfferReservationRefresh({
      offerId: 'offer',
      token: 'acceptance-token',
      now,
    })).toEqual({
      filter: {
        _id: 'offer',
        status: 'accepting',
        acceptanceToken: 'acceptance-token',
      },
      update: {
        $set: { acceptanceReservedAt: now },
      },
    });
  });

  test('treats a reservation as stale at the lease boundary', () => {
    const acceptanceReservedAt = new Date(
      now.getTime() - DEFAULT_OFFER_ACCEPTANCE_LEASE_MS
    );

    expect(offerAcceptanceReservationIsStale({
      status: 'accepting',
      acceptanceReservedAt,
    }, now)).toBe(true);
  });

  test('keeps a current reservation active and ignores non-accepting offers', () => {
    expect(offerAcceptanceReservationIsStale({
      status: 'accepting',
      acceptanceReservedAt: new Date(now.getTime() - 1_000),
    }, now)).toBe(false);
    expect(offerAcceptanceReservationIsStale({
      status: 'sent',
      acceptanceReservedAt: new Date(0),
    }, now)).toBe(false);
  });

  test('treats an accepting offer without a reservation timestamp as stale', () => {
    expect(offerAcceptanceReservationIsStale({
      status: 'accepting',
      acceptanceReservedAt: null,
    }, now)).toBe(true);
  });
});
