const VALID_PAYMENT_FLOWS = new Set(['system', 'external']);
const DEFAULT_OFFER_ACCEPTANCE_LEASE_MS = 5 * 60 * 1000;

class AcceptanceValidationError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'AcceptanceValidationError';
    this.code = code;
    this.status = status;
  }
}

function isPaymentFlow(value) {
  return VALID_PAYMENT_FLOWS.has(value);
}

function resolveAcceptancePaymentFlow({
  orderPreference,
  requestedPaymentMethod,
  isOffersOnlyOrder = false,
}) {
  if (isOffersOnlyOrder) return 'external';

  if (orderPreference === 'both') {
    if (!isPaymentFlow(requestedPaymentMethod)) {
      throw new AcceptanceValidationError(
        'Wybierz płatność przez Helpfli albo płatność poza serwisem.',
        'PAYMENT_METHOD_REQUIRED'
      );
    }
    return requestedPaymentMethod;
  }

  // Akceptacja jest ostatnim, jawnym wyborem właściciela zlecenia. Pozwala to
  // bezpiecznie przejść na external, gdy wybrany wykonawca nie ma aktywnych wypłat.
  if (isPaymentFlow(requestedPaymentMethod)) return requestedPaymentMethod;
  if (isPaymentFlow(orderPreference)) return orderPreference;

  throw new AcceptanceValidationError(
    'Nie udało się ustalić sposobu płatności.',
    'INVALID_PAYMENT_METHOD'
  );
}

function buildAcceptancePricing({
  baseAmount,
  platformFee,
  platformFeeBeforeDiscount,
  platformFeePercent,
  foundingDiscountApplied,
  feeExplanation,
  paymentFlow,
  includeGuarantee,
}) {
  const base = Number(baseAmount);
  const fee = Number(platformFee);
  const nominalFee = Number(platformFeeBeforeDiscount ?? fee);

  if (!Number.isFinite(base) || base < 0 || !Number.isFinite(fee) || fee < 0) {
    throw new AcceptanceValidationError(
      'Oferta zawiera nieprawidłową kwotę.',
      'INVALID_OFFER_AMOUNT'
    );
  }

  const guaranteeEnabled = paymentFlow === 'system' && includeGuarantee === true;
  const guaranteeFee = guaranteeEnabled ? Math.round(base * 0.07) : 0;
  const total = base + fee + guaranteeFee;

  return {
    baseAmount: base,
    guaranteeFee,
    platformFee: fee,
    platformFeeBeforeDiscount: Number.isFinite(nominalFee) ? nominalFee : fee,
    platformFeePercent: Number(platformFeePercent) || 0,
    foundingDiscountApplied: foundingDiscountApplied === true,
    feeExplanation: feeExplanation || null,
    total,
    currency: 'PLN',
    includeGuarantee: guaranteeEnabled,
  };
}

function buildAcceptanceLockFilter({
  orderId,
  clientId,
  preserveSettledContactUnlock = false,
}) {
  const filter = {
    _id: orderId,
    client: clientId,
    status: { $in: ['draft', 'open', 'collecting_offers', 'quote', 'matched'] },
    $or: [
      { acceptedOfferId: null },
      { acceptedOfferId: { $exists: false } },
    ],
  };
  if (preserveSettledContactUnlock) {
    filter.contactUnlockStatus = { $nin: ['succeeded', 'waived'] };
  }
  return filter;
}

function buildOfferReservationFilter({ offerId, orderId, now = new Date() }) {
  return {
    _id: offerId,
    orderId,
    status: 'sent',
    $or: [
      { expiresAt: { $gt: now } },
      { expiresAt: null },
      { expiresAt: { $exists: false } },
    ],
  };
}

function buildOfferReservationUpdate({ token, clientId, now = new Date() }) {
  return {
    $set: {
      status: 'accepting',
      acceptanceToken: token,
      acceptanceReservedBy: clientId,
      acceptanceReservedAt: now,
    },
    $unset: {
      acceptedAt: 1,
      rejectedAt: 1,
    },
  };
}

function buildOfferReservationRelease({
  offerId,
  token,
  status = 'sent',
  now = new Date(),
  expectedReservedAt,
}) {
  const set = { status };
  if (status === 'rejected') set.rejectedAt = now;

  const filter = {
    _id: offerId,
    status: 'accepting',
    acceptanceToken: token,
  };
  if (expectedReservedAt !== undefined) {
    filter.acceptanceReservedAt = expectedReservedAt;
  }

  return {
    filter,
    update: {
      $set: set,
      $unset: {
        acceptanceToken: 1,
        acceptanceReservedBy: 1,
        acceptanceReservedAt: 1,
      },
    },
  };
}

function buildOfferReservationRefresh({ offerId, token, now = new Date() }) {
  return {
    filter: {
      _id: offerId,
      status: 'accepting',
      acceptanceToken: token,
    },
    update: {
      $set: { acceptanceReservedAt: now },
    },
  };
}

function offerAcceptanceReservationIsStale(
  offer,
  now = new Date(),
  leaseMs = DEFAULT_OFFER_ACCEPTANCE_LEASE_MS
) {
  if (offer?.status !== 'accepting') return false;
  const reservedAt = offer.acceptanceReservedAt
    ? new Date(offer.acceptanceReservedAt).getTime()
    : 0;
  return !reservedAt || reservedAt <= now.getTime() - leaseMs;
}

function contactUnlockIsSettled(order) {
  return ['succeeded', 'waived'].includes(order?.contactUnlockStatus);
}

function acceptedOfferProviderMatches(order, offer) {
  if (!order?.provider || !offer?.providerId) return false;
  return String(order.provider) === String(offer.providerId);
}

module.exports = {
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
  isPaymentFlow,
  offerAcceptanceReservationIsStale,
  resolveAcceptancePaymentFlow,
};
