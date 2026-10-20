const crypto = require('crypto');
const Stripe = require('stripe');
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const DisputeRefundExecution = require('../models/DisputeRefundExecution');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const { isExternalOrderPayment } = require('./orderPaymentFlow');

const MAX_REFUND_LIST_PAGES = 25;

class RefundExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefundExecutionError';
    this.code = code;
  }
}

function asId(value) {
  return String(value?._id || value || '');
}

function asDateToken(value) {
  if (!value) return 'none';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : String(date.getTime());
}

function amountToGrosze(amountPln) {
  return Math.round(Number(amountPln) * 100);
}

/**
 * Builds a stable identity for one concrete settlement. A retry of that same
 * settlement uses the same value, while another settlement/dispute receives a
 * different date/party component.
 */
function buildDisputeSettlementExecutionScope(order, kind = 'party', amountPln) {
  const settlement = order?.disputeSettlement || {};
  const amountGrosze = amountToGrosze(
    amountPln === undefined ? settlement.amountPln : amountPln
  );
  const settlementAnchor = settlement.createdAt || order?.createdAt;
  const disputeAnchor = order?.disputeReportedAt || order?.createdAt;
  // If a concrete settlement exists, both party acceptance and an admin action
  // refer to the same financial execution. This makes callers converge instead
  // of creating independent journals for one settlement.
  const hasConcreteSettlement = Boolean(settlement.createdAt || settlement.offeredBy);
  const scopeKind = hasConcreteSettlement ? 'settlement' : kind;
  const actor = hasConcreteSettlement
    ? asId(settlement.offeredBy) || 'unknown-offerer'
    : kind === 'admin'
      ? 'admin'
      : 'unknown-offerer';
  return [
    scopeKind,
    asId(order),
    asDateToken(disputeAnchor),
    asDateToken(settlementAnchor),
    actor,
    amountGrosze,
  ].join(':');
}

function buildExecutionKey(orderId, scope, amountGrosze) {
  const digest = crypto
    .createHash('sha256')
    .update(`v2|${String(orderId)}|${String(scope)}|${amountGrosze}`)
    .digest('hex');
  return `dsr_${digest}`;
}

function buildPartIdempotencyKey(executionKey, part) {
  const digest = crypto
    .createHash('sha256')
    .update(
      [
        executionKey,
        part.partKey,
        part.stripePaymentIntentId,
        part.operation,
        part.amountGrosze,
        part.captureAmountGrosze || 0,
        part.captureApplicationFeeGrosze ?? 'none',
      ].join('|')
    )
    .digest('hex');
  return `dsr_part_${digest}`;
}

function isExternalPayment(order) {
  return isExternalOrderPayment(order);
}

function getDependencies(options) {
  const dependencies = options.dependencies || {};
  return {
    PaymentModel: dependencies.PaymentModel || Payment,
    OrderModel: dependencies.OrderModel || Order,
    ExecutionModel: dependencies.ExecutionModel || DisputeRefundExecution,
    stripeClient:
      Object.prototype.hasOwnProperty.call(dependencies, 'stripeClient')
        ? dependencies.stripeClient
        : stripe,
  };
}

function assertPositiveInteger(value, code, message) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RefundExecutionError(code, message);
  }
  return value;
}

async function retrieveIntent(stripeClient, paymentIntentId) {
  return stripeClient.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge'],
  });
}

async function resolveCharge(stripeClient, pi) {
  if (pi.latest_charge && typeof pi.latest_charge === 'object') {
    return pi.latest_charge;
  }
  if (typeof pi.latest_charge === 'string' && pi.latest_charge) {
    return stripeClient.charges.retrieve(pi.latest_charge);
  }
  return null;
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function stripeObjectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function canonicalPaymentAmount(order, role) {
  if (role === 'additional') {
    const additionalPln = Number(order?.additionalAmount || 0);
    return Number.isFinite(additionalPln) && additionalPln > 0
      ? Math.round(additionalPln * 100)
      : 0;
  }
  const amountTotal = Number(order?.amountTotal || 0);
  if (Number.isFinite(amountTotal) && amountTotal > 0) {
    return Math.round(amountTotal);
  }
  const totalPln = Number(order?.pricing?.total || 0);
  return Number.isFinite(totalPln) && totalPln > 0
    ? Math.round(totalPln * 100)
    : 0;
}

function throwPaymentBindingConflict(message) {
  throw new RefundExecutionError('PAYMENT_BINDING_CONFLICT', message);
}

function hasMetadataValue(metadata, key) {
  return metadata?.[key] !== undefined && metadata?.[key] !== null && metadata?.[key] !== '';
}

function hasV2PaymentBindingSignal(payment, pi, role) {
  const commonV2Keys = ['acceptedOfferId', 'destinationAccountId'];
  if (
    commonV2Keys.some(
      (key) => hasMetadataValue(payment?.metadata, key) || hasMetadataValue(pi?.metadata, key)
    )
  ) {
    return true;
  }
  return role === 'main' && (
    hasMetadataValue(payment?.metadata, 'type') ||
    hasMetadataValue(payment?.metadata, 'subtype') ||
    hasMetadataValue(pi?.metadata, 'type')
  );
}

function validateLegacyV1PaymentIntentBinding(order, payment, pi, role) {
  const expectedPaymentId =
    role === 'additional' ? order?.payment?.additionalPaymentId : order?.paymentId;
  const expectedIntentId =
    role === 'additional' ? order?.payment?.additionalIntentId : order?.payment?.intentId;
  const orderId = order?._id;
  const providerId = order?.provider?._id || order?.provider;
  const clientId = order?.client?._id || order?.client;
  const paymentOrderId = payment?.order?._id || payment?.order;
  const paymentProviderId = payment?.provider?._id || payment?.provider;
  const paymentClientId = payment?.client?._id || payment?.client;

  if (
    !orderId ||
    !providerId ||
    !clientId ||
    !payment?._id ||
    !pi?.id ||
    !sameId(payment._id, expectedPaymentId) ||
    !sameId(payment.stripePaymentIntentId, expectedIntentId) ||
    !sameId(pi.id, expectedIntentId) ||
    !sameId(paymentOrderId, orderId) ||
    !sameId(paymentProviderId, providerId) ||
    !sameId(paymentClientId, clientId) ||
    payment.purpose !== 'order' ||
    !sameId(payment.metadata?.orderId, orderId) ||
    !sameId(pi.metadata?.orderId, orderId) ||
    !sameId(payment.metadata?.providerId, providerId) ||
    !sameId(pi.metadata?.providerId, providerId) ||
    !sameId(payment.metadata?.clientId, clientId) ||
    !sameId(pi.metadata?.clientId, clientId)
  ) {
    throwPaymentBindingConflict(
      `Starsza płatność ${role === 'additional' ? 'dopłaty' : 'główna'} nie odpowiada dokładnie temu zleceniu.`
    );
  }

  const expectedAmount = canonicalPaymentAmount(order, role);
  const paymentCurrency = String(payment.currency || '').toLowerCase();
  const intentCurrency = String(pi.currency || '').toLowerCase();
  const orderCurrency = String(order.currency || 'pln').toLowerCase();
  if (
    !Number.isSafeInteger(expectedAmount) ||
    expectedAmount < 1 ||
    Number(payment.amount) !== expectedAmount ||
    Number(pi.amount) !== expectedAmount ||
    paymentCurrency !== 'pln' ||
    intentCurrency !== 'pln' ||
    orderCurrency !== 'pln'
  ) {
    throwPaymentBindingConflict('Kwota lub waluta starszej płatności nie odpowiada zleceniu.');
  }

  if (role === 'main') {
    const pointSnapshots = [
      payment.pointsDiscount,
      payment.metadata?.pointsDiscount,
      pi.metadata?.pointsDiscount,
    ].map(Number);
    if (pointSnapshots.some((value) => !Number.isFinite(value))) {
      throwPaymentBindingConflict('Starsza płatność nie ma kompletnego snapshotu rabatu punktowego.');
    }
    if (pointSnapshots.some((value) => value !== 0)) {
      throw new RefundExecutionError(
        'MANUAL_RECONCILIATION',
        'Ta starsza płatność używała rabatu punktowego i wymaga ręcznego uzgodnienia zwrotu.'
      );
    }
    if (
      pi.capture_method !== 'manual' ||
      Number(payment.metadata?.stripeAmount) !== expectedAmount ||
      Number(payment.metadata?.clientPaidAmount) !== expectedAmount ||
      Number(pi.metadata?.clientPaidAmount) !== expectedAmount
    ) {
      throwPaymentBindingConflict('Starsza płatność główna nie ma zgodnych snapshotów escrow.');
    }
    return;
  }

  const paymentTypes = [payment.metadata?.type, payment.metadata?.subtype].filter(Boolean);
  if (
    paymentTypes.length < 1 ||
    paymentTypes.some((type) => type !== 'additional_payment') ||
    pi.metadata?.type !== 'additional_payment' ||
    Number(payment.metadata?.additionalAmount) !== expectedAmount ||
    Number(pi.metadata?.additionalAmount) !== expectedAmount
  ) {
    throwPaymentBindingConflict('Starsza dopłata nie ma zgodnych oznaczeń i snapshotu kwoty.');
  }
}

/**
 * A refund is allowed only for the exact canonical Payment/PaymentIntent pair
 * currently referenced by the Order. This deliberately rejects unlabelled or
 * stale historical objects rather than risking a refund to another payment.
 */
function validateV2PaymentIntentBinding(order, payment, pi, role) {
  const expectedType = role === 'additional' ? 'additional_payment' : 'order_escrow';
  const expectedPaymentId =
    role === 'additional' ? order?.payment?.additionalPaymentId : order?.paymentId;
  const expectedIntentId =
    role === 'additional' ? order?.payment?.additionalIntentId : order?.payment?.intentId;
  const paymentOrderId = payment?.order?._id || payment?.order;
  const orderId = order?._id;
  const declaredPaymentTypes = [payment?.metadata?.type, payment?.metadata?.subtype]
    .filter(Boolean);

  if (
    !orderId ||
    !payment?._id ||
    !pi?.id ||
    !sameId(payment._id, expectedPaymentId) ||
    !sameId(payment.stripePaymentIntentId, expectedIntentId) ||
    !sameId(pi.id, expectedIntentId) ||
    !sameId(paymentOrderId, orderId) ||
    payment.purpose !== 'order' ||
    declaredPaymentTypes.length < 1 ||
    declaredPaymentTypes.some((type) => type !== expectedType) ||
    pi.metadata?.type !== expectedType ||
    !sameId(pi.metadata?.orderId, orderId)
  ) {
    throwPaymentBindingConflict(
      `Płatność ${role === 'additional' ? 'dopłaty' : 'główna'} nie jest kanoniczną płatnością tego zlecenia.`
    );
  }

  const expectedAmount = canonicalPaymentAmount(order, role);
  const paymentCurrency = String(payment.currency || '').toLowerCase();
  const intentCurrency = String(pi.currency || '').toLowerCase();
  const orderCurrency = String(order.currency || 'pln').toLowerCase();
  if (
    !Number.isSafeInteger(expectedAmount) ||
    expectedAmount < 1 ||
    Number(payment.amount) !== expectedAmount ||
    Number(pi.amount) !== expectedAmount ||
    paymentCurrency !== 'pln' ||
    intentCurrency !== 'pln' ||
    orderCurrency !== 'pln'
  ) {
    throwPaymentBindingConflict('Kwota lub waluta płatności nie odpowiada zapisowi zlecenia.');
  }

  if (role === 'main' && Number(payment.metadata?.stripeAmount) !== expectedAmount) {
    throwPaymentBindingConflict('Płatność główna nie ma poprawnego snapshotu kwoty Stripe.');
  }
  if (
    role === 'additional' &&
    (
      Number(payment.metadata?.additionalAmount) !== expectedAmount ||
      Number(pi.metadata?.additionalAmount) !== expectedAmount
    )
  ) {
    throwPaymentBindingConflict('Dopłata nie ma poprawnego snapshotu kwoty.');
  }

  const providerId = order.provider?._id || order.provider;
  const acceptedOfferId = order.acceptedOfferId?._id || order.acceptedOfferId;
  const clientId = order.client?._id || order.client;
  if (
    !providerId ||
    !acceptedOfferId ||
    !clientId ||
    !sameId(payment.provider?._id || payment.provider, providerId) ||
    !sameId(payment.client?._id || payment.client, clientId) ||
    !sameId(payment.metadata?.providerId, providerId) ||
    !sameId(pi.metadata?.providerId, providerId) ||
    !sameId(payment.metadata?.clientId, clientId) ||
    !sameId(pi.metadata?.clientId, clientId) ||
    !sameId(payment.metadata?.acceptedOfferId, acceptedOfferId) ||
    !sameId(pi.metadata?.acceptedOfferId, acceptedOfferId)
  ) {
    throwPaymentBindingConflict('Uczestnicy lub zaakceptowana oferta płatności nie odpowiadają zleceniu.');
  }

  const paymentDestination = payment.metadata?.destinationAccountId;
  const intentDestination = pi.metadata?.destinationAccountId;
  const transferDestination = stripeObjectId(pi.transfer_data?.destination);
  if (
    (paymentDestination || intentDestination || transferDestination) &&
    (
      !paymentDestination ||
      !intentDestination ||
      !transferDestination ||
      String(paymentDestination) !== String(intentDestination) ||
      String(paymentDestination) !== String(transferDestination)
    )
  ) {
    throwPaymentBindingConflict('Konto docelowe Stripe nie odpowiada zapisanej płatności.');
  }
}

function validatePaymentIntentBinding(order, payment, pi, role) {
  if (hasV2PaymentBindingSignal(payment, pi, role)) {
    return validateV2PaymentIntentBinding(order, payment, pi, role);
  }
  return validateLegacyV1PaymentIntentBinding(order, payment, pi, role);
}

async function describeRefundPart({
  order,
  payment,
  role,
  remainingGrosze,
  stripeClient,
  executionKey,
  partIndex,
}) {
  if (!payment?.stripePaymentIntentId || remainingGrosze < 1) return null;

  const pi = await retrieveIntent(stripeClient, payment.stripePaymentIntentId);
  validatePaymentIntentBinding(order, payment, pi, role);
  const paymentId = asId(payment);
  const partKey = `${role}_${partIndex}`;
  const base = {
    partKey,
    role,
    payment: payment._id,
    stripePaymentIntentId: payment.stripePaymentIntentId,
    stripeChargeId: null,
    amountGrosze: 0,
    captureAmountGrosze: null,
    captureApplicationFeeGrosze: null,
    chargeAmountGrosze: null,
    chargeRefundedBeforeGrosze: null,
    status: 'pending',
    stripeRef: null,
    paymentStatus: null,
    error: '',
    completedAt: null,
  };

  if (pi.status === 'requires_capture') {
    const authorized = assertPositiveInteger(
      Number(pi.amount_capturable ?? pi.amount),
      'INVALID_AUTHORIZATION',
      'Stripe zwrócił nieprawidłową kwotę autoryzacji.'
    );
    const use = Math.min(remainingGrosze, authorized);
    const operation = use === authorized ? 'cancel' : 'partial_capture';
    const captureAmountGrosze = operation === 'partial_capture' ? authorized - use : null;
    let captureApplicationFeeGrosze = null;
    if (operation === 'partial_capture' && pi.transfer_data?.destination) {
      const originalAmount = Number(pi.amount);
      const originalApplicationFee = Number(pi.application_fee_amount);
      if (
        pi.application_fee_amount != null &&
        (
          !Number.isSafeInteger(originalAmount) ||
          originalAmount < authorized ||
          !Number.isSafeInteger(originalApplicationFee) ||
          originalApplicationFee < 0 ||
          originalApplicationFee > originalAmount
        )
      ) {
        throw new RefundExecutionError(
          'INVALID_APPLICATION_FEE',
          'Stripe zwrócił niespójną prowizję dla częściowego pobrania.'
        );
      }
      if (pi.application_fee_amount != null) {
        captureApplicationFeeGrosze = Math.min(
          captureAmountGrosze,
          Math.round((originalApplicationFee * captureAmountGrosze) / originalAmount)
        );
      }
    }
    const part = {
      ...base,
      operation,
      amountGrosze: use,
      captureAmountGrosze,
      captureApplicationFeeGrosze,
    };
    part.idempotencyKey = buildPartIdempotencyKey(executionKey, part);
    return part;
  }

  if (pi.status === 'succeeded') {
    const charge = await resolveCharge(stripeClient, pi);
    if (!charge?.id) {
      throw new RefundExecutionError(
        'NO_CHARGE',
        `Brak obciążenia Stripe dla płatności ${paymentId}.`
      );
    }
    const chargeAmount = assertPositiveInteger(
      Number(charge.amount),
      'INVALID_CHARGE',
      'Stripe zwrócił nieprawidłową kwotę obciążenia.'
    );
    if (
      chargeAmount !== Number(pi.amount) ||
      (charge.currency && String(charge.currency).toLowerCase() !== 'pln') ||
      (charge.payment_intent && !sameId(charge.payment_intent, pi.id))
    ) {
      throwPaymentBindingConflict('Obciążenie Stripe nie odpowiada kanonicznemu PaymentIntent.');
    }
    const refundedBefore = Math.max(0, Number(charge.amount_refunded) || 0);
    const refundable = Math.max(0, chargeAmount - refundedBefore);
    if (refundable < 1) return null;

    const part = {
      ...base,
      operation: 'refund',
      stripeChargeId: charge.id,
      amountGrosze: Math.min(remainingGrosze, refundable),
      chargeAmountGrosze: chargeAmount,
      chargeRefundedBeforeGrosze: refundedBefore,
    };
    part.idempotencyKey = buildPartIdempotencyKey(executionKey, part);
    return part;
  }

  throw new RefundExecutionError(
    'UNEXPECTED_PI_STATUS',
    `Nieobsługiwany status płatności Stripe (${pi.status}).`
  );
}

async function buildExecutionPlan(order, refundGroszeRequested, executionKey, deps) {
  const mainPayment = await deps.PaymentModel.findById(order.paymentId);
  if (!mainPayment?.stripePaymentIntentId) {
    throw new RefundExecutionError(
      'NO_INTENT',
      'Brak powiązanej płatności Stripe dla tego zlecenia.'
    );
  }

  let remaining = refundGroszeRequested;
  const parts = [];
  const mainPart = await describeRefundPart({
    order,
    payment: mainPayment,
    role: 'main',
    remainingGrosze: remaining,
    stripeClient: deps.stripeClient,
    executionKey,
    partIndex: parts.length,
  });
  if (mainPart) {
    parts.push(mainPart);
    remaining -= mainPart.amountGrosze;
  }

  if (remaining >= 1) {
    const additionalId = order.payment?.additionalPaymentId;
    if (!additionalId || asId(additionalId) === asId(order.paymentId)) {
      throw new RefundExecutionError(
        'INSUFFICIENT_REFUNDABLE',
        'Kwota ugody przekracza środki możliwe do zwrotu z zarejestrowanych płatności. Zmniejsz kwotę lub skontaktuj się z pomocą Helpfli.'
      );
    }
    if (!['succeeded', 'partial_refund'].includes(order.additionalPaymentStatus)) {
      throw new RefundExecutionError(
        'ADDITIONAL_NOT_PAID',
        'Część kwoty nie mieści się w głównej płatności, a dopłata nie jest zaksięgowana jako opłacona — nie można wykonać zwrotu. Skontaktuj się z pomocą Helpfli.'
      );
    }
    const additionalPayment = await deps.PaymentModel.findById(additionalId);
    if (!additionalPayment?.stripePaymentIntentId) {
      throw new RefundExecutionError(
        'INSUFFICIENT_REFUNDABLE',
        'Kwota ugody przekracza środki możliwe do zwrotu z zarejestrowanych płatności. Zmniejsz kwotę lub skontaktuj się z pomocą Helpfli.'
      );
    }
    const additionalPart = await describeRefundPart({
      order,
      payment: additionalPayment,
      role: 'additional',
      remainingGrosze: remaining,
      stripeClient: deps.stripeClient,
      executionKey,
      partIndex: parts.length,
    });
    if (additionalPart) {
      parts.push(additionalPart);
      remaining -= additionalPart.amountGrosze;
    }
  }

  if (remaining >= 1) {
    throw new RefundExecutionError(
      'INSUFFICIENT_REFUNDABLE',
      'Kwota ugody przekracza łącznie możliwy zwrot z głównej płatności i dopłaty. Zmniejsz kwotę lub skontaktuj się z pomocą Helpfli.'
    );
  }

  return parts;
}

function validateExecutionJournal(
  execution,
  { executionKey, orderId, scope, amountGrosze }
) {
  const parts = Array.isArray(execution?.parts) ? execution.parts : [];
  const roles = new Set();
  const total = parts.reduce((sum, part) => {
    roles.add(part.role);
    return sum + Number(part.amountGrosze || 0);
  }, 0);
  const invalidPart = parts.find((part) => {
    const captureAmount = Number(part.captureAmountGrosze);
    const captureFee = part.captureApplicationFeeGrosze;
    const invalidCaptureFields =
      part.operation === 'partial_capture'
        ? !Number.isSafeInteger(captureAmount) ||
          captureAmount < 1 ||
          (captureFee != null &&
            (!Number.isSafeInteger(Number(captureFee)) ||
              Number(captureFee) < 0 ||
              Number(captureFee) > captureAmount))
        : part.captureAmountGrosze != null || part.captureApplicationFeeGrosze != null;
    return (
      !['main', 'additional'].includes(part.role) ||
      !['cancel', 'partial_capture', 'refund'].includes(part.operation) ||
      !Number.isSafeInteger(Number(part.amountGrosze)) ||
      Number(part.amountGrosze) < 1 ||
      invalidCaptureFields ||
      part.idempotencyKey !== buildPartIdempotencyKey(executionKey, part)
    );
  });
  const invalidCompletedExecution =
    execution?.status === 'succeeded' &&
    (
      execution?.summary?.ok !== true ||
      Number(execution?.summary?.amountGrosze) !== amountGrosze ||
      parts.some(
        (part) =>
          part.status !== 'succeeded' ||
          !['refunded', 'partial_refund'].includes(part.paymentStatus) ||
          !part.stripeRef
      )
    );

  if (
    execution?.executionKey !== executionKey ||
    asId(execution?.order) !== String(orderId) ||
    execution?.idempotencyScope !== scope ||
    Number(execution?.amountGrosze) !== amountGrosze ||
    parts.length < 1 ||
    parts.length > 2 ||
    roles.size !== parts.length ||
    total !== amountGrosze ||
    invalidPart ||
    invalidCompletedExecution
  ) {
    throw new RefundExecutionError(
      'EXECUTION_JOURNAL_CONFLICT',
      'Zapisany plan zwrotu jest niespójny z zaakceptowaną ugodą.'
    );
  }
  return execution;
}

async function claimRefundExecution(order, executionKey, deps) {
  const settlement = order.disputeSettlement || {};
  const filter = {
    _id: order._id,
    $or: [
      { 'disputeSettlement.refundExecutionKey': { $exists: false } },
      { 'disputeSettlement.refundExecutionKey': null },
      { 'disputeSettlement.refundExecutionKey': executionKey },
    ],
  };
  if (settlement.createdAt) {
    filter['disputeSettlement.createdAt'] = settlement.createdAt;
  }
  if (settlement.offeredBy) {
    filter['disputeSettlement.offeredBy'] = settlement.offeredBy;
  }
  if (settlement.status) {
    filter['disputeSettlement.status'] = settlement.status;
  }
  if (settlement.amountPln != null && Number.isFinite(Number(settlement.amountPln))) {
    filter['disputeSettlement.amountPln'] = Number(settlement.amountPln);
  }
  if (order.disputeReportedAt) {
    filter.disputeReportedAt = order.disputeReportedAt;
  }

  const startedAt = new Date();
  const claimed = await deps.OrderModel.findOneAndUpdate(
    filter,
    {
      $set: {
        'disputeSettlement.refundExecutionKey': executionKey,
        'disputeSettlement.refundExecutionStartedAt': startedAt,
      },
    },
    { new: true }
  );
  if (!claimed) {
    throw new RefundExecutionError(
      'REFUND_EXECUTION_CONFLICT',
      'Dla tej sprawy rozpoczęto już inne wykonanie zwrotu. Odśwież zlecenie przed kolejną operacją.'
    );
  }

  // Keep the caller's in-memory document in sync so its later save cannot
  // accidentally clear the independently acquired database claim.
  order.disputeSettlement = order.disputeSettlement || {};
  order.disputeSettlement.refundExecutionKey = executionKey;
  order.disputeSettlement.refundExecutionStartedAt =
    claimed.disputeSettlement?.refundExecutionStartedAt ||
    order.disputeSettlement.refundExecutionStartedAt ||
    startedAt;
}

async function getOrCreateExecution(
  order,
  refundGroszeRequested,
  scope,
  executionKey,
  deps
) {
  const existing = await deps.ExecutionModel.findOne({ executionKey });
  const expected = {
    executionKey,
    orderId: order._id,
    scope,
    amountGrosze: refundGroszeRequested,
  };
  if (existing) return validateExecutionJournal(existing, expected);

  // The complete allocation is established before the first Stripe mutation.
  // A unique execution key makes concurrent planners converge on one journal.
  const parts = await buildExecutionPlan(order, refundGroszeRequested, executionKey, deps);
  const execution = new deps.ExecutionModel({
    executionKey,
    idempotencyScope: scope,
    order: order._id,
    amountGrosze: refundGroszeRequested,
    status: 'planned',
    parts,
    initialOrderPaymentStatus: order.paymentStatus || 'succeeded',
    initialOrderPaymentSubStatus: order.payment?.status || null,
    initialAdditionalPaymentStatus: order.additionalPaymentStatus || null,
  });

  try {
    await execution.save();
    return validateExecutionJournal(execution, expected);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await deps.ExecutionModel.findOne({ executionKey });
    if (!winner) throw error;
    return validateExecutionJournal(winner, expected);
  }
}

async function findRefundForPart(stripeClient, part, executionKey) {
  let startingAfter;
  for (let pageNumber = 0; pageNumber < MAX_REFUND_LIST_PAGES; pageNumber += 1) {
    const page = await stripeClient.refunds.list({
      charge: part.stripeChargeId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const refunds = Array.isArray(page?.data) ? page.data : [];
    const matching = refunds.find(
      (refund) =>
        refund?.metadata?.disputeExecutionKey === executionKey &&
        refund?.metadata?.disputePartKey === part.partKey
    );
    if (matching) return matching;
    if (!page?.has_more) return null;
    const last = refunds[refunds.length - 1];
    if (!last?.id) {
      throw new RefundExecutionError(
        'REFUND_RECONCILIATION_FAILED',
        'Nie można bezpiecznie uzgodnić wcześniejszego zwrotu Stripe.'
      );
    }
    startingAfter = last.id;
  }
  throw new RefundExecutionError(
    'REFUND_RECONCILIATION_LIMIT',
    'Lista wcześniejszych zwrotów Stripe jest zbyt długa do bezpiecznego uzgodnienia automatycznego.'
  );
}

function validateMatchingRefundIdentity(refund, part) {
  const refundCharge =
    typeof refund?.charge === 'object'
      ? String(refund.charge?.id || '')
      : String(refund?.charge || '');
  if (
    !refund?.id ||
    Number(refund.amount) !== Number(part.amountGrosze) ||
    (refundCharge && refundCharge !== String(part.stripeChargeId))
  ) {
    throw new RefundExecutionError(
      'REFUND_RECONCILIATION_CONFLICT',
      'Znaleziony zwrot Stripe nie odpowiada zaplanowanej części ugody.'
    );
  }
}

function verifyMatchingRefund(refund, part) {
  validateMatchingRefundIdentity(refund, part);
  if (['failed', 'canceled'].includes(refund.status)) {
    throw new RefundExecutionError(
      'REFUND_FAILED',
      'Stripe odrzucił zaplanowany zwrot ugody.'
    );
  }
  if (refund.status !== 'succeeded') {
    throw new RefundExecutionError(
      'REFUND_PENDING',
      'Stripe przyjął zwrot, ale nie potwierdził jeszcze jego zakończenia.'
    );
  }
}

async function loadAndValidateBoundPayment(order, part, pi, deps) {
  const payment = await deps.PaymentModel.findById(part.payment);
  if (!payment || payment.stripePaymentIntentId !== part.stripePaymentIntentId) {
    throwPaymentBindingConflict('Lokalny zapis płatności nie odpowiada planowi zwrotu.');
  }
  validatePaymentIntentBinding(order, payment, pi, part.role);
  return payment;
}

async function preflightPlannedPart(order, part, execution, deps) {
  const pi = await retrieveIntent(deps.stripeClient, part.stripePaymentIntentId);
  await loadAndValidateBoundPayment(order, part, pi, deps);

  if (part.operation === 'refund') {
    const existingRefund = await findRefundForPart(
      deps.stripeClient,
      part,
      execution.executionKey
    );
    if (existingRefund) {
      validateMatchingRefundIdentity(existingRefund, part);
      if (['failed', 'canceled'].includes(existingRefund.status)) {
        throw new RefundExecutionError(
          'REFUND_FAILED',
          'Stripe odrzucił zaplanowany zwrot ugody.'
        );
      }
      return;
    }
    if (pi.status !== 'succeeded') {
      throw new RefundExecutionError(
        'REFUND_INTENT_STATE_CONFLICT',
        `Nie można utworzyć zwrotu przy statusie Stripe ${pi.status}.`
      );
    }
    const charge = await resolveCharge(deps.stripeClient, pi);
    const currentRefundable = Number(charge?.amount) - Number(charge?.amount_refunded || 0);
    if (
      !charge?.id ||
      charge.id !== part.stripeChargeId ||
      Number(charge.amount) !== Number(part.chargeAmountGrosze) ||
      currentRefundable < Number(part.amountGrosze)
    ) {
      throw new RefundExecutionError(
        'REFUND_CAPACITY_CHANGED',
        'Dostępna kwota zwrotu Stripe zmieniła się od utworzenia planu ugody.'
      );
    }
    return;
  }

  if (part.operation === 'partial_capture') {
    if (pi.status === 'succeeded') {
      const capturedAmount = await capturedAmountForIntent(deps.stripeClient, pi);
      if (capturedAmount !== Number(part.captureAmountGrosze)) {
        throw new RefundExecutionError(
          'CAPTURE_RECONCILIATION_CONFLICT',
          'Płatność została pobrana w innej kwocie niż zaplanowana w ugodzie.'
        );
      }
      if (
        part.captureApplicationFeeGrosze != null &&
        pi.application_fee_amount != null &&
        Number(pi.application_fee_amount) !== Number(part.captureApplicationFeeGrosze)
      ) {
        throw new RefundExecutionError(
          'CAPTURE_RECONCILIATION_CONFLICT',
          'Płatność została pobrana z inną prowizją niż zaplanowana w ugodzie.'
        );
      }
      return;
    }
    const expectedAuthorization =
      Number(part.amountGrosze) + Number(part.captureAmountGrosze);
    if (
      pi.status !== 'requires_capture' ||
      Number(pi.amount_capturable) !== expectedAuthorization
    ) {
      throw new RefundExecutionError(
        'CAPTURE_RECONCILIATION_CONFLICT',
        'Autoryzacja Stripe nie odpowiada zaplanowanemu częściowemu pobraniu.'
      );
    }
    return;
  }

  if (part.operation === 'cancel') {
    if (pi.status === 'canceled') return;
    if (
      pi.status !== 'requires_capture' ||
      Number(pi.amount_capturable) !== Number(part.amountGrosze)
    ) {
      throw new RefundExecutionError(
        'CANCEL_RECONCILIATION_CONFLICT',
        'Autoryzacja Stripe nie odpowiada zaplanowanemu anulowaniu.'
      );
    }
    return;
  }

  throw new RefundExecutionError(
    'UNKNOWN_REFUND_OPERATION',
    `Nieznana operacja zwrotu (${part.operation}).`
  );
}

async function preflightExecutionForClaim(order, execution, deps) {
  for (const part of execution.parts || []) {
    // Read-only verification immediately before the Order claim. Only the
    // claim winner is subsequently allowed to mutate Stripe.
    await preflightPlannedPart(order, part, execution, deps);
  }
}

async function executeRefundPart(stripeClient, part, execution, order, deps) {
  const pi = await retrieveIntent(stripeClient, part.stripePaymentIntentId);
  await loadAndValidateBoundPayment(order, part, pi, deps);
  let refund = await findRefundForPart(stripeClient, part, execution.executionKey);
  if (!refund) {
    if (pi.status !== 'succeeded') {
      throw new RefundExecutionError(
        'REFUND_INTENT_STATE_CONFLICT',
        `Nie można utworzyć zwrotu przy statusie Stripe ${pi.status}.`
      );
    }
    const charge = await resolveCharge(stripeClient, pi);
    if (!charge?.id || charge.id !== part.stripeChargeId) {
      throw new RefundExecutionError(
        'CHARGE_BINDING_CONFLICT',
        'Płatność Stripe nie wskazuje już obciążenia zapisanego w planie zwrotu.'
      );
    }
    const currentRefundable = Number(charge.amount) - Number(charge.amount_refunded || 0);
    if (
      Number(charge.amount) !== Number(part.chargeAmountGrosze) ||
      currentRefundable < Number(part.amountGrosze)
    ) {
      throw new RefundExecutionError(
        'REFUND_CAPACITY_CHANGED',
        'Dostępna kwota zwrotu Stripe zmieniła się od utworzenia planu ugody.'
      );
    }
    const isDestinationCharge = Boolean(
      charge.transfer || charge.destination || pi.transfer_data?.destination
    );
    const payload = {
      charge: part.stripeChargeId,
      amount: part.amountGrosze,
      metadata: {
        reason: 'dispute_settlement',
        orderId: asId(execution.order),
        disputeExecutionKey: execution.executionKey,
        disputePartKey: part.partKey,
      },
    };
    if (isDestinationCharge) {
      payload.reverse_transfer = true;
      payload.refund_application_fee = true;
    }
    refund = await stripeClient.refunds.create(payload, {
      idempotencyKey: part.idempotencyKey,
    });
  }

  verifyMatchingRefund(refund, part);
  const refundedAfter =
    Number(part.chargeRefundedBeforeGrosze || 0) + Number(part.amountGrosze);
  return {
    stripeRef: refund.id,
    paymentStatus:
      refundedAfter >= Number(part.chargeAmountGrosze) ? 'refunded' : 'partial_refund',
  };
}

async function capturedAmountForIntent(stripeClient, pi) {
  const amountReceived = Number(pi?.amount_received);
  if (Number.isSafeInteger(amountReceived) && amountReceived >= 0) return amountReceived;
  const charge = await resolveCharge(stripeClient, pi);
  const chargeCaptured = Number(charge?.amount_captured ?? charge?.amount);
  return Number.isSafeInteger(chargeCaptured) && chargeCaptured >= 0
    ? chargeCaptured
    : null;
}

async function executePartialCapturePart(stripeClient, part, order, deps) {
  let pi = await retrieveIntent(stripeClient, part.stripePaymentIntentId);
  await loadAndValidateBoundPayment(order, part, pi, deps);
  if (pi.status === 'succeeded') {
    const capturedAmount = await capturedAmountForIntent(stripeClient, pi);
    if (capturedAmount !== Number(part.captureAmountGrosze)) {
      throw new RefundExecutionError(
        'CAPTURE_RECONCILIATION_CONFLICT',
        'Płatność została pobrana w innej kwocie niż zaplanowana w ugodzie.'
      );
    }
    if (
      part.captureApplicationFeeGrosze != null &&
      pi.application_fee_amount != null &&
      Number(pi.application_fee_amount) !== Number(part.captureApplicationFeeGrosze)
    ) {
      throw new RefundExecutionError(
        'CAPTURE_RECONCILIATION_CONFLICT',
        'Płatność została pobrana z inną prowizją niż zaplanowana w ugodzie.'
      );
    }
    return { stripeRef: pi.id, paymentStatus: 'partial_refund' };
  }
  if (pi.status !== 'requires_capture') {
    throw new RefundExecutionError(
      'UNEXPECTED_PI_STATUS',
      `Nie można wykonać częściowego pobrania przy statusie Stripe ${pi.status}.`
    );
  }

  const captureParams = { amount_to_capture: part.captureAmountGrosze };
  if (part.captureApplicationFeeGrosze != null) {
    captureParams.application_fee_amount = part.captureApplicationFeeGrosze;
  }
  pi = await stripeClient.paymentIntents.capture(
    part.stripePaymentIntentId,
    captureParams,
    { idempotencyKey: part.idempotencyKey }
  );
  if (pi.status !== 'succeeded') {
    throw new RefundExecutionError(
      'CAPTURE_FAILED',
      'Nie udało się sfinalizować częściowej płatności po ugodzie.'
    );
  }
  const capturedAmount = await capturedAmountForIntent(stripeClient, pi);
  if (capturedAmount !== Number(part.captureAmountGrosze)) {
    throw new RefundExecutionError(
      'CAPTURE_RECONCILIATION_CONFLICT',
      'Stripe potwierdził pobranie w innej kwocie niż zaplanowana w ugodzie.'
    );
  }
  if (
    part.captureApplicationFeeGrosze != null &&
    pi.application_fee_amount != null &&
    Number(pi.application_fee_amount) !== Number(part.captureApplicationFeeGrosze)
  ) {
    throw new RefundExecutionError(
      'CAPTURE_RECONCILIATION_CONFLICT',
      'Stripe potwierdził inną prowizję niż zaplanowana w ugodzie.'
    );
  }
  return { stripeRef: pi.id, paymentStatus: 'partial_refund' };
}

async function executeCancelPart(stripeClient, part, order, deps) {
  let pi = await retrieveIntent(stripeClient, part.stripePaymentIntentId);
  await loadAndValidateBoundPayment(order, part, pi, deps);
  if (pi.status !== 'canceled') {
    if (pi.status !== 'requires_capture') {
      throw new RefundExecutionError(
        'CANCEL_RECONCILIATION_CONFLICT',
        `Nie można anulować autoryzacji przy statusie Stripe ${pi.status}.`
      );
    }
    // Stripe request options (including idempotencyKey) are the third
    // argument. Putting the key in params does not make the request idempotent.
    pi = await stripeClient.paymentIntents.cancel(
      part.stripePaymentIntentId,
      {},
      { idempotencyKey: part.idempotencyKey }
    );
  }
  if (pi.status !== 'canceled') {
    throw new RefundExecutionError(
      'CANCEL_FAILED',
      'Stripe nie potwierdził anulowania autoryzacji.'
    );
  }
  return { stripeRef: pi.id, paymentStatus: 'refunded' };
}

async function executePlannedPart(stripeClient, part, execution, order, deps) {
  if (part.operation === 'refund') {
    return executeRefundPart(stripeClient, part, execution, order, deps);
  }
  if (part.operation === 'partial_capture') {
    return executePartialCapturePart(stripeClient, part, order, deps);
  }
  if (part.operation === 'cancel') {
    return executeCancelPart(stripeClient, part, order, deps);
  }
  throw new RefundExecutionError(
    'UNKNOWN_REFUND_OPERATION',
    `Nieznana operacja zwrotu (${part.operation}).`
  );
}

async function syncPaymentRecord(part, deps) {
  const payment = await deps.PaymentModel.findById(part.payment);
  if (!payment || payment.stripePaymentIntentId !== part.stripePaymentIntentId) {
    throw new RefundExecutionError(
      'PAYMENT_BINDING_CONFLICT',
      'Lokalny zapis płatności nie odpowiada planowi zwrotu.'
    );
  }
  const desired = part.paymentStatus;
  const effective = payment.status === 'refunded' ? 'refunded' : desired;
  if (payment.status !== effective) {
    payment.status = effective;
    await payment.save();
  }
  return effective;
}

function buildSummary(execution) {
  const parts = execution.parts || [];
  const mainPart = parts.find((part) => part.role === 'main');
  const additionalPart = parts.find((part) => part.role === 'additional');
  const totalApplied = parts.reduce(
    (sum, part) => sum + Number(part.amountGrosze || 0),
    0
  );
  const method =
    parts.length > 1 ? 'split_refund' : parts.length === 1 ? parts[0].operation : 'skipped_no_payment';
  const stripeRef = parts
    .map((part) => part.stripeRef)
    .filter(Boolean)
    .join(';') || null;
  const mainStatus = mainPart?.paymentStatus || execution.initialOrderPaymentStatus || 'succeeded';

  return {
    ok: true,
    amountGrosze: totalApplied,
    method,
    stripeRef,
    orderPaymentStatus: mainStatus,
    orderPaymentSubStatus: mainPart
      ? mainStatus === 'refunded'
        ? 'refunded'
        : 'partial_refund'
      : execution.initialOrderPaymentSubStatus || null,
    additionalPaymentStatus:
      additionalPart?.paymentStatus || execution.initialAdditionalPaymentStatus || null,
  };
}

function refundFailure(error) {
  const message = error?.raw?.message || error?.message || 'Błąd Stripe';
  return {
    ok: false,
    code: error?.code || 'STRIPE_ERROR',
    message: `Nie udało się wykonać zwrotu: ${message}`,
  };
}

/**
 * Returns client funds for an accepted settlement (PLN -> grosze).
 *
 * Before mutating Stripe, the function persists an immutable allocation across
 * main/additional Payment records. Every retry reuses it and reconciles Stripe
 * by operation-specific state/metadata, so a crash cannot reallocate or apply
 * the requested amount for a second time.
 */
async function applyDisputeSettlementRefund(order, amountPln, options = {}) {
  const refundGroszeRequested = amountToGrosze(amountPln);
  if (!Number.isFinite(refundGroszeRequested) || refundGroszeRequested < 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Nieprawidłowa kwota zwrotu.' };
  }

  const deps = getDependencies(options);
  const scope =
    options.idempotencyScope ||
    buildDisputeSettlementExecutionScope(order, 'party', amountPln);
  const executionKey = buildExecutionKey(order._id, scope, refundGroszeRequested);

  const isDecisionWithoutStripeMutation =
    refundGroszeRequested === 0 || isExternalPayment(order) || !order.paymentId;
  if (isDecisionWithoutStripeMutation) {
    try {
      // A zero/external/no-payment result still commits the dispute decision.
      // Claiming here prevents a simultaneous caller from accepting another
      // outcome for the same dispute even though Stripe is not involved.
      await claimRefundExecution(order, executionKey, deps);
    } catch (error) {
      return refundFailure(error);
    }
  }

  if (refundGroszeRequested === 0) {
    return {
      ok: true,
      amountGrosze: 0,
      method: 'zero_settlement',
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || 'succeeded',
      orderPaymentSubStatus: order.payment?.status || null,
      additionalPaymentStatus: order.additionalPaymentStatus || null,
    };
  }

  if (isExternalPayment(order)) {
    return {
      ok: true,
      amountGrosze: 0,
      method: 'skipped_external',
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || 'succeeded',
      orderPaymentSubStatus: null,
      additionalPaymentStatus: null,
    };
  }

  if (!order.paymentId) {
    return {
      ok: true,
      amountGrosze: 0,
      method: 'skipped_no_payment',
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || 'unpaid',
      orderPaymentSubStatus: null,
      additionalPaymentStatus: null,
    };
  }

  if (!deps.stripeClient) {
    return {
      ok: false,
      code: 'NO_STRIPE',
      message:
        'Stripe nie jest skonfigurowany — automatycznego zwrotu nie można wykonać. Skontaktuj się z pomocą Helpfli.',
    };
  }

  let execution = null;
  try {
    execution = await getOrCreateExecution(
      order,
      refundGroszeRequested,
      scope,
      executionKey,
      deps
    );

    // Planning and every external read happen before the persistent Order
    // claim. Thus binding/capacity/configuration failures cannot strand a
    // dispute without any Stripe mutation. Concurrent callers may each create
    // a journal, but only the atomic claim winner can reach a mutation below.
    await preflightExecutionForClaim(order, execution, deps);
    await claimRefundExecution(order, executionKey, deps);

    if (execution.status === 'succeeded' && execution.summary?.ok) {
      return execution.summary;
    }

    execution.status = 'processing';
    execution.lastError = '';
    await execution.save();

    for (const part of execution.parts) {
      if (part.status !== 'succeeded') {
        part.status = 'processing';
        part.error = '';
        await execution.save();

        const outcome = await executePlannedPart(
          deps.stripeClient,
          part,
          execution,
          order,
          deps
        );
        part.stripeRef = outcome.stripeRef;
        part.paymentStatus = outcome.paymentStatus;
        part.status = 'succeeded';
        part.completedAt = new Date();
        await execution.save();
      }

      // This may be retried independently if the process/database failed after
      // Stripe succeeded. It cannot trigger another Stripe mutation.
      part.paymentStatus = await syncPaymentRecord(part, deps);
      await execution.save();
    }

    const summary = buildSummary(execution);
    if (summary.amountGrosze !== refundGroszeRequested) {
      throw new RefundExecutionError(
        'EXECUTION_AMOUNT_MISMATCH',
        'Zapis wykonania zwrotu nie odpowiada kwocie zaakceptowanej ugody.'
      );
    }
    execution.summary = summary;
    execution.status = 'succeeded';
    execution.completedAt = new Date();
    execution.lastError = '';
    await execution.save();
    return summary;
  } catch (error) {
    if (execution) {
      const retryableStripeState = error?.code === 'REFUND_PENDING';
      execution.status = retryableStripeState ? 'processing' : 'failed';
      execution.lastError = String(error?.message || 'Błąd Stripe').slice(0, 2000);
      const activePart = execution.parts?.find((part) => part.status === 'processing');
      if (activePart) {
        activePart.status = retryableStripeState ? 'processing' : 'failed';
        activePart.error = execution.lastError;
      }
      try {
        await execution.save();
      } catch (journalError) {
        console.error('DISPUTE_REFUND_JOURNAL_SAVE', journalError);
      }
    }
    return refundFailure(error);
  }
}

module.exports = {
  applyDisputeSettlementRefund,
  buildDisputeSettlementExecutionScope,
  isExternalPayment,
  __testables: {
    validatePaymentIntentBinding,
  },
};
