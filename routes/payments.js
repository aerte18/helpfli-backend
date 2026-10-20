const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const User = require('../models/User');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const UserSubscription = require('../models/UserSubscription');
const Coupon = require('../models/Coupon');
const PaymentErrorLog = require('../models/PaymentErrorLog');
const Invoice = require('../models/Invoice');
const Revenue = require('../models/Revenue');
const Notification = require('../models/Notification');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const NotificationService = require('../services/NotificationService');
const { validateNIP } = require('../utils/companyValidation');
const { paymentIntentStatusForPaymentModel } = require('../utils/paymentIntentStatusForPaymentModel');
const { getFrontendUrl } = require('../utils/publicUrl');
const {
  stripeSourceDate,
  stripeEffectKey,
  applyStripeEffectOnce,
} = require('../utils/stripeWebhookIdempotency');

// Helper do logowania błędów płatności
async function logPaymentError({
  errorType,
  errorMessage,
  errorStack,
  errorCode,
  paymentId = null,
  orderId = null,
  userId = null,
  subscriptionId = null,
  stripePaymentIntentId = null,
  stripeEventId = null,
  stripeChargeId = null,
  eventType = null,
  eventPayload = {},
  retryable = true,
  metadata = {}
}) {
  try {
    await PaymentErrorLog.create({
      errorType,
      errorMessage: errorMessage || 'Unknown error',
      errorStack,
      errorCode,
      paymentId,
      orderId,
      userId,
      subscriptionId,
      stripePaymentIntentId,
      stripeEventId,
      stripeChargeId,
      eventType,
      eventPayload: sanitizePayload(eventPayload), // Usuń wrażliwe dane
      retryable,
      metadata,
      status: 'new'
    });
  } catch (logError) {
    console.error('Failed to log payment error:', logError);
  }
}

// Helper do sanitizacji payloadu (usuń wrażliwe dane)
function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const sanitized = { ...payload };
  // Usuń wrażliwe pola
  delete sanitized.card;
  delete sanitized.payment_method;
  delete sanitized.customer;
  delete sanitized.source;
  // Zachowaj tylko metadata i podstawowe pola
  return {
    id: sanitized.id,
    type: sanitized.type,
    metadata: sanitized.metadata,
    amount: sanitized.amount,
    currency: sanitized.currency,
    status: sanitized.status
  };
}

const CURRENCY = process.env.CURRENCY || 'pln';
const GUARANTEE_DAYS = parseInt(process.env.PAYMENT_GUARANTEE_DAYS || '30', 10);
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || '0.07');

const FRONTEND_URL = getFrontendUrl();

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

function resolveFrontendUrl(req) {
  const envUrl = normalizeUrl(process.env.FRONTEND_URL || process.env.APP_URL || '');
  if (envUrl) return envUrl;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return getFrontendUrl();
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}`;
}

/** Order.payment.status ma enum: requires_payment | paid | refunded | failed — Stripe zwraca m.in. requires_payment_method. */
function orderPaymentSubStatusFromStripePi(stripeStatus) {
  if (!stripeStatus || typeof stripeStatus !== 'string') return 'requires_payment';
  if (stripeStatus === 'succeeded') return 'paid';
  if (stripeStatus === 'failed' || stripeStatus === 'canceled') return 'failed';
  if (stripeStatus === 'refunded' || stripeStatus === 'partial_refund') return 'refunded';
  return 'requires_payment';
}

// Feature flag – umożliwia stopniowe włączanie Stripe Connect
const ENABLE_STRIPE_CONNECT = process.env.ENABLE_STRIPE_CONNECT === 'true';
const STRIPE_WEBHOOK_LOCK_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.STRIPE_WEBHOOK_LOCK_TIMEOUT_MS || '300000', 10) || 300_000
);

function getPlatformOwnedFeeAmount(order, platformFeeAmount) {
  const platformFee = Number.isFinite(Number(platformFeeAmount))
    ? Math.max(0, Math.round(Number(platformFeeAmount)))
    : 0;
  const guaranteeFeePln = Number(order?.pricing?.guaranteeFee || 0);
  const guaranteeFee = Number.isFinite(guaranteeFeePln)
    ? Math.max(0, Math.round(guaranteeFeePln * 100))
    : 0;
  return platformFee + guaranteeFee;
}

function normalizeFeeRate(value, fallback = PLATFORM_FEE_PERCENT) {
  let rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) rate = Number(fallback);
  if (!Number.isFinite(rate) || rate < 0) rate = 0;

  // Historycznie część snapshotów zamówień przechowywała procent jako 5,
  // a nowsze jako ułamek 0.05. Stripe oczekuje kwoty, więc ujednolicamy oba
  // formaty zanim przemnożymy ją przez amount.
  if (rate > 1) rate /= 100;
  return Math.min(rate, 1);
}

function resolveMainPaymentAmounts(order) {
  let amount = Number(order?.amountTotal || 0);
  if (!amount || amount <= 0) {
    const totalPln = Number(order?.pricing?.total || 0);
    if (totalPln > 0) amount = Math.round(totalPln * 100);
  }

  let platformFeeAmount = Number(order?.platformFeeAmount || 0);
  if (!platformFeeAmount || platformFeeAmount <= 0) {
    const rawPlatformFeePln = order?.pricing?.platformFee;
    const platformFeePln = Number(rawPlatformFeePln);
    if (
      rawPlatformFeePln != null &&
      Number.isFinite(platformFeePln) &&
      platformFeePln >= 0
    ) {
      platformFeeAmount = Math.round(platformFeePln * 100);
    } else {
      const basePln = Number(order?.pricing?.baseAmount || 0);
      const percent = normalizeFeeRate(order?.platformFeePercent);
      platformFeeAmount = basePln > 0 && Number.isFinite(percent)
        ? Math.round(basePln * 100 * percent)
        : 0;
    }
  }

  // pricing.discountPoints jest zapisywane w PLN przez priceCalculator, podczas
  // gdy PaymentIntent.amount i Payment.pointsDiscount są w groszach.
  const rawPointsDiscountPln = Number(order?.pricing?.discountPoints || 0);
  const pointsDiscount = Number.isFinite(rawPointsDiscountPln) && rawPointsDiscountPln > 0
    ? Math.round(rawPointsDiscountPln * 100)
    : 0;
  // Stripe zawsze obciąża klienta dokładnie kwotą widoczną w podsumowaniu.
  // Rabatu punktowego nie wolno dodawać z powrotem do charge — ewentualne
  // dofinansowanie wykonawcy jest osobnym kosztem platformy.
  const stripeAmount = amount;
  return { amount, platformFeeAmount, pointsDiscount, stripeAmount };
}

function getSystemPaymentReadiness({ enabled, paysThroughHelpfli, provider }) {
  if (!paysThroughHelpfli) {
    return {
      ok: false,
      status: 400,
      code: 'SYSTEM_PAYMENT_REQUIRED',
      message: 'To zlecenie nie jest rozliczane przez płatność systemową Helpfli.',
    };
  }
  if (!enabled) {
    return {
      ok: false,
      status: 503,
      code: 'STRIPE_CONNECT_DISABLED',
      message: 'Płatność systemowa jest chwilowo niedostępna. Wypłaty Stripe Connect nie są aktywne.',
    };
  }
  if (
    !provider?.stripeAccountId ||
    !provider?.stripeConnectStatus?.chargesEnabled ||
    !provider?.stripeConnectStatus?.payoutsEnabled
  ) {
    return {
      ok: false,
      status: 409,
      code: 'PROVIDER_PAYOUTS_NOT_READY',
      message: 'Wykonawca nie ma jeszcze aktywowanych wypłat Stripe. Wybierz płatność poza systemem albo poproś wykonawcę o dokończenie konfiguracji wypłat.',
    };
  }
  return { ok: true };
}

async function acquireStripeEventLock(ProcessedStripeEvent, event, options = {}) {
  const now = options.now || new Date();
  const staleBefore = new Date(
    now.getTime() - (options.lockTimeoutMs || STRIPE_WEBHOOK_LOCK_TIMEOUT_MS)
  );
  const lockToken = options.lockToken || randomUUID();

  try {
    await ProcessedStripeEvent.create({
      eventId: event.id,
      type: event.type,
      status: 'processing',
      lockToken,
      lockedAt: now,
      processedAt: null,
      failedAt: null,
      attempts: 1,
      lastError: '',
      updatedAt: now,
    });
    return { acquired: true, lockToken, recovered: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const existingQuery = ProcessedStripeEvent.findOne({ eventId: event.id });
  const existing = typeof existingQuery?.lean === 'function'
    ? await existingQuery.lean()
    : await existingQuery;

  // Rekordy zapisane przez poprzednią wersję nie mają statusu i oznaczają
  // zdarzenie już obsłużone.
  if (!existing || !existing.status || existing.status === 'processed') {
    return { acquired: false, duplicate: true };
  }

  const isStaleProcessing =
    existing.status === 'processing' &&
    (!existing.lockedAt || new Date(existing.lockedAt) <= staleBefore);
  if (existing.status !== 'failed' && !isStaleProcessing) {
    return { acquired: false, inProgress: true };
  }

  const retryFilter = {
    _id: existing._id,
    eventId: event.id,
    status: existing.status,
  };
  if (existing.status === 'processing') {
    retryFilter.$or = [
      { lockedAt: { $lte: staleBefore } },
      { lockedAt: null },
      { lockedAt: { $exists: false } },
    ];
  }

  const reacquired = await ProcessedStripeEvent.findOneAndUpdate(
    retryFilter,
    {
      $set: {
        type: event.type,
        status: 'processing',
        lockToken,
        lockedAt: now,
        processedAt: null,
        failedAt: null,
        lastError: '',
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  if (!reacquired) return { acquired: false, inProgress: true };
  return { acquired: true, lockToken, recovered: true };
}

async function markStripeEventProcessed(ProcessedStripeEvent, eventId, lockToken) {
  const now = new Date();
  const result = await ProcessedStripeEvent.updateOne(
    { eventId, status: 'processing', lockToken },
    {
      $set: {
        status: 'processed',
        processedAt: now,
        updatedAt: now,
        lastError: '',
      },
      $unset: { lockToken: 1, lockedAt: 1, failedAt: 1 },
    }
  );
  const matchedCount = result?.matchedCount ?? result?.n ?? 0;
  if (matchedCount !== 1) {
    throw new Error(`Stripe webhook lock lost before completion (${eventId})`);
  }
}

async function markStripeEventFailed(ProcessedStripeEvent, eventId, lockToken, error) {
  const now = new Date();
  const message = String(error?.message || error || 'Unknown webhook error').slice(0, 2000);
  return ProcessedStripeEvent.updateOne(
    { eventId, status: 'processing', lockToken },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        updatedAt: now,
        lastError: message,
      },
      $unset: { lockToken: 1, lockedAt: 1 },
    }
  );
}

async function handleAdditionalPaymentFailure(intent, models = { Order, Payment }) {
  const orderId = intent.metadata?.orderId;
  if (orderId) {
    await models.Order.updateOne(
      {
        _id: orderId,
        additionalPaymentStatus: { $ne: 'succeeded' },
        $or: [
          { 'payment.additionalIntentId': intent.id },
          { 'payment.additionalIntentId': null },
          { 'payment.additionalIntentId': { $exists: false } },
        ],
      },
      { $set: { additionalPaymentStatus: 'failed' } }
    );
  }
  await models.Payment.updateOne(
    {
      stripePaymentIntentId: intent.id,
      status: { $nin: ['succeeded', 'refunded', 'partial_refund'] },
    },
    { $set: { status: 'failed' } }
  );
}

function applyExternalCommissionOrderState(order, status) {
  if (!order) return order;
  if (order.externalCommissionStatus === 'succeeded' && status !== 'succeeded') {
    return order;
  }
  order.externalCommissionStatus = status;
  order.paidInSystem = false;
  return order;
}

function getExternalCommissionReadiness(order, { hasMainEscrow = false } = {}) {
  const providerId = order?.provider?._id || order?.provider;
  const acceptedOfferId = order?.acceptedOfferId?._id || order?.acceptedOfferId;
  if (order?.paymentPreference !== 'external') {
    return { ok: false, code: 'EXTERNAL_PAYMENT_REQUIRED' };
  }
  if (order?.status !== 'accepted' || !providerId || !acceptedOfferId) {
    return { ok: false, code: 'ORDER_NOT_READY_FOR_COMMISSION' };
  }
  if (hasMainEscrow || order?.paymentId || order?.payment?.intentId) {
    return { ok: false, code: 'MAIN_ESCROW_ALREADY_EXISTS' };
  }
  return {
    ok: true,
    providerId,
    acceptedOfferId,
  };
}

function isStripeConnectProvider(user) {
  if (!user) return false;
  if (user.role === 'provider') return true;
  return user.roleInCompany === 'provider';
}

// --- STRIPE CONNECT: tworzenie konta i linków onboardingowych ---

// POST /api/payments/connect/create-account
// Tworzy konto Stripe Connect (Express) dla zalogowanego wykonawcy
router.post('/connect/create-account', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('email role roleInCompany kyc stripeAccountId stripeConnectStatus');
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    if (!isStripeConnectProvider(user)) {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą aktywować wypłaty Stripe' });
    }
    if (!stripe) {
      return res.status(500).json({ message: 'Stripe nie jest skonfigurowany' });
    }

    // Jeżeli konto już istnieje – zwróć istniejące ID
    if (user.stripeAccountId) {
      return res.json({
        stripeAccountId: user.stripeAccountId,
        status: user.stripeConnectStatus || {}
      });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      country: 'PL',
      email: user.email,
      business_type: user.kyc?.type === 'company' ? 'company' : 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        userId: String(user._id),
        role: user.role,
      },
    });

    user.stripeAccountId = account.id;
    user.stripeConnectStatus = {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirementsDue: Array.isArray(account.requirements?.currently_due) && account.requirements.currently_due.length > 0,
      lastCheckedAt: new Date(),
    };
    await user.save();

    res.json({
      stripeAccountId: account.id,
      status: user.stripeConnectStatus,
    });
  } catch (e) {
    console.error('Stripe Connect create-account error:', e);
    const stripeMessage = e?.raw?.message || e?.message || '';
    const stripeCode = e?.code || e?.raw?.code || '';
    const details = [stripeCode, stripeMessage].filter(Boolean).join(': ');
    res.status(500).json({
      message: details
        ? `Nie udało się utworzyć konta Stripe Connect (${details})`
        : 'Nie udało się utworzyć konta Stripe Connect'
    });
  }
});

// POST /api/payments/connect/account-link
// Generuje link onboardingowy / refresh do panelu Stripe dla providera
router.post('/connect/account-link', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('role roleInCompany stripeAccountId');
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    if (!isStripeConnectProvider(user)) {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą aktywować wypłaty Stripe' });
    }
    if (!stripe) {
      return res.status(500).json({ message: 'Stripe nie jest skonfigurowany' });
    }

    // Upewnij się, że mamy konto
    if (!user.stripeAccountId) {
      return res.status(400).json({ message: 'Brak konta Stripe. Najpierw wywołaj /connect/create-account.' });
    }

    const frontendUrl = resolveFrontendUrl(req);
    const refreshUrl = `${frontendUrl}/account?tab=wallet`;
    const returnUrl = `${frontendUrl}/account?tab=wallet&stripe_connected=1`;

    const accountLink = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (e) {
    console.error('Stripe Connect account-link error:', e);
    const stripeMessage = e?.raw?.message || e?.message || '';
    const stripeCode = e?.code || e?.raw?.code || '';
    const details = [stripeCode, stripeMessage].filter(Boolean).join(': ');
    res.status(500).json({
      message: details
        ? `Nie udało się wygenerować linku onboardingowego Stripe (${details})`
        : 'Nie udało się wygenerować linku onboardingowego Stripe'
    });
  }
});

// GET /api/payments/connect/status
// Zwraca aktualny status konta Stripe Connect dla zalogowanego użytkownika
router.get('/connect/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('role roleInCompany stripeAccountId stripeConnectStatus');
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    if (!isStripeConnectProvider(user)) {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą mieć wypłaty Stripe' });
    }
    if (!stripe || !user.stripeAccountId) {
      return res.json({
        stripeAccountId: user.stripeAccountId || '',
        status: user.stripeConnectStatus || {
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          requirementsDue: false,
          lastCheckedAt: user.stripeConnectStatus?.lastCheckedAt || null,
        },
      });
    }

    // Odśwież status z Stripe
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    user.stripeConnectStatus = {
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirementsDue: Array.isArray(account.requirements?.currently_due) && account.requirements.currently_due.length > 0,
      lastCheckedAt: new Date(),
    };
    await user.save();

    res.json({
      stripeAccountId: user.stripeAccountId,
      status: user.stripeConnectStatus,
    });
  } catch (e) {
    console.error('Stripe Connect status error:', e);
    res.status(500).json({ message: 'Nie udało się pobrać statusu konta Stripe' });
  }
});

// GET /api/payments/config – do frontu
router.get('/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

const DEFAULT_PAYMENT_METHOD_TYPES = ['card', 'blik', 'p24'];

/**
 * PaymentIntent z BLIK / Przelewy24 — wymaga włączenia metod w Stripe Dashboard (PL + pln).
 * Kolejność: automatic_payment_methods → jawne typy → tylko karta.
 * Nie wymuszamy pmc_* na starcie, bo może ograniczać metody do samej karty/Link.
 */
function isStripePaymentMethodConfigurationError(error) {
  return (
    error?.type === 'StripeInvalidRequestError' ||
    error?.rawType === 'invalid_request_error' ||
    error?.raw?.type === 'invalid_request_error'
  );
}

async function createPaymentIntentPreferLocalWallets(stripe, basePayload, options = {}) {
  const core = { ...basePayload };
  delete core.payment_method_types;
  delete core.automatic_payment_methods;
  delete core.payment_method_configuration;

  const attempts = [
    { ...core, automatic_payment_methods: { enabled: true, allow_redirects: 'always' } },
    { ...core, payment_method_types: [...DEFAULT_PAYMENT_METHOD_TYPES] },
    { ...core, payment_method_types: ['card'] }
  ];

  let lastErr;
  for (let index = 0; index < attempts.length; index += 1) {
    const body = attempts[index];
    try {
      // eslint-disable-next-line no-await-in-loop
      const requestOptions = options.idempotencyKeyPrefix
        ? {
            idempotencyKey: `${options.idempotencyKeyPrefix}:wallets-v1:${index}`.slice(0, 255),
          }
        : undefined;
      return requestOptions
        ? await stripe.paymentIntents.create(body, requestOptions)
        : await stripe.paymentIntents.create(body);
    } catch (err) {
      lastErr = err;
      // Fallback metod płatności ma sens tylko przy błędzie konfiguracji
      // requestu. Błędu sieciowego / 5xx nie wolno zamieniać w kolejną próbę
      // z innym kluczem, bo mogłoby to utworzyć drugi PaymentIntent.
      if (!isStripePaymentMethodConfigurationError(err)) throw err;
    }
  }
  throw lastErr;
}

const PI_REUSABLE = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);
const PI_REUSABLE_FOR_CHECKOUT = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

function paymentIntentMatchesExpected(
  intent,
  { amount, orderId, type, acceptedOfferId, providerId, destinationAccountId }
) {
  const actualType = intent?.metadata?.type ||
    (type === 'order_escrow' ? 'order_escrow' : '');
  const baseMatches = Boolean(intent) &&
    Number(intent.amount) === Number(amount) &&
    String(intent.currency || '').toLowerCase() === String(CURRENCY).toLowerCase() &&
    String(intent.metadata?.orderId || '') === String(orderId) &&
    actualType === type;
  if (!baseMatches) return false;
  if (
    acceptedOfferId != null &&
    String(intent.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)
  ) return false;
  if (
    providerId != null &&
    String(intent.metadata?.providerId || '') !== String(providerId)
  ) return false;
  if (destinationAccountId != null) {
    const destination = stripeObjectId(intent?.transfer_data?.destination);
    if (String(destination || '') !== String(destinationAccountId)) return false;
    if (
      String(intent.metadata?.destinationAccountId || '') !==
      String(destinationAccountId)
    ) return false;
  }
  return true;
}

function paymentOrIntentHasRefund(paymentDoc, intent) {
  if (paymentDoc && ['refunded', 'partial_refund'].includes(paymentDoc.status)) return true;
  const latestCharge = typeof intent?.latest_charge === 'object' ? intent.latest_charge : null;
  if (Number(latestCharge?.amount_refunded || 0) > 0 || latestCharge?.refunded === true) return true;
  const charges = Array.isArray(intent?.charges?.data) ? intent.charges.data : [];
  return charges.some(
    (charge) => Number(charge?.amount_refunded || 0) > 0 || charge?.refunded === true
  );
}

function stripeObjectId(value) {
  if (typeof value === 'string') return value;
  return value?.id || null;
}

function assertCheckoutPaymentBinding(payment, expected) {
  const paymentType = payment?.metadata?.type;
  const paymentUserId = payment?.provider?._id || payment?.provider || payment?.metadata?.userId;
  const mismatch =
    !payment ||
    String(payment.stripeBusinessKey || '') !== String(expected.stripeBusinessKey) ||
    String(payment.stripeCheckoutSessionId || '') !== String(expected.stripeCheckoutSessionId) ||
    String(payment.stripePaymentIntentId || '') !== String(expected.stripePaymentIntentId || '') ||
    Number(payment.amount) !== Number(expected.amount) ||
    String(payment.currency || '').toLowerCase() !== String(expected.currency).toLowerCase() ||
    paymentType !== expected.type ||
    String(paymentUserId || '') !== String(expected.userId);

  if (mismatch) {
    const error = new Error(
      `Checkout session is already bound to different payment data (${expected.stripeCheckoutSessionId})`
    );
    error.code = 'CHECKOUT_PAYMENT_BINDING_CONFLICT';
    throw error;
  }
  return payment;
}

async function upsertCheckoutPaymentBinding(
  session,
  { type, userId, metadata = {} },
  PaymentModel = Payment
) {
  const sessionId = session?.id;
  const paymentIntentId = stripeObjectId(session?.payment_intent);
  const amount = Number(session?.amount_total);
  const currency = String(session?.currency || '').toLowerCase();
  if (!sessionId || !type || !userId) {
    const error = new Error('Incomplete one-time Checkout binding');
    error.code = 'CHECKOUT_PAYMENT_BINDING_INCOMPLETE';
    throw error;
  }
  if (!Number.isSafeInteger(amount) || amount < 0 || !currency) {
    const error = new Error('Invalid Checkout amount or currency');
    error.code = 'CHECKOUT_PAYMENT_AMOUNT_INVALID';
    throw error;
  }
  if (amount > 0 && !paymentIntentId) {
    const error = new Error('Paid Checkout session has no PaymentIntent');
    error.code = 'CHECKOUT_PAYMENT_INTENT_MISSING';
    throw error;
  }

  const stripeBusinessKey = `checkout_session:${sessionId}`;
  const expected = {
    stripeBusinessKey,
    stripeCheckoutSessionId: sessionId,
    stripePaymentIntentId: paymentIntentId,
    amount,
    currency,
    type,
    userId,
  };
  const insert = {
    purpose: 'promotion',
    provider: userId,
    amount,
    currency,
    status: 'processing',
    stripeCheckoutSessionId: sessionId,
    stripeBusinessKey,
    ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    metadata: {
      ...metadata,
      type,
      userId: String(userId),
      checkoutSessionId: sessionId,
    },
  };

  let payment;
  try {
    payment = await PaymentModel.findOneAndUpdate(
      { stripeBusinessKey },
      { $setOnInsert: insert },
      { upsert: true, new: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    payment = await PaymentModel.findOne({
      $or: [
        { stripeBusinessKey },
        ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
        { stripeCheckoutSessionId: sessionId },
      ],
    });
    if (!payment) throw error;
  }

  return assertCheckoutPaymentBinding(payment, expected);
}

function classifyOneTimeCheckoutSettlement(session, intent) {
  const amount = Number(session?.amount_total);
  const currency = String(session?.currency || '').toLowerCase();
  const paymentIntentId = stripeObjectId(session?.payment_intent);

  // A legitimate 100% discount produces a paid Checkout Session without a PI.
  // There is no charge that could later be refunded, but the Session remains
  // protected by the unique business key in Payment.
  if (amount === 0 && !paymentIntentId) {
    return { eligible: true, paymentIntentId: null, chargeId: null };
  }

  if (!intent || intent.id !== paymentIntentId || intent.status !== 'succeeded') {
    return { eligible: false, reason: 'intent_not_succeeded' };
  }
  if (
    Number(intent.amount) !== amount ||
    String(intent.currency || '').toLowerCase() !== currency
  ) {
    return { eligible: false, reason: 'intent_amount_mismatch' };
  }

  const charge = typeof intent.latest_charge === 'object'
    ? intent.latest_charge
    : (Array.isArray(intent.charges?.data) ? intent.charges.data[0] : null);
  if (!charge) return { eligible: false, reason: 'charge_missing' };

  const chargeIntentId = stripeObjectId(charge.payment_intent);
  if (
    !chargeIntentId ||
    chargeIntentId !== paymentIntentId ||
    charge.paid !== true ||
    Number(charge.amount) !== amount ||
    String(charge.currency || '').toLowerCase() !== currency
  ) {
    return { eligible: false, reason: 'charge_binding_mismatch' };
  }

  const amountRefunded = Number(charge.amount_refunded || 0);
  if (charge.refunded === true || amountRefunded > 0) {
    return {
      eligible: false,
      reason: 'refunded',
      refundStatus: charge.refunded === true || amountRefunded >= Number(charge.amount)
        ? 'refunded'
        : 'partial_refund',
      paymentIntentId,
      chargeId: charge.id,
    };
  }

  return {
    eligible: true,
    paymentIntentId,
    chargeId: charge.id,
  };
}

async function authorizeOneTimeCheckoutFulfillment(
  session,
  binding,
  { stripeClient = stripe, PaymentModel = Payment } = {}
) {
  const payment = await upsertCheckoutPaymentBinding(session, binding, PaymentModel);
  if (['refunded', 'partial_refund'].includes(payment.status)) {
    return { allowed: false, reason: 'refunded', payment };
  }

  const paymentIntentId = stripeObjectId(session.payment_intent);
  let intent = null;
  if (paymentIntentId) {
    if (!stripeClient) {
      const error = new Error('Stripe is unavailable for Checkout verification');
      error.code = 'STRIPE_UNAVAILABLE';
      throw error;
    }
    // Checkout Session.payment_status remains `paid` after a refund. Always
    // retrieve the current PI/Charge instead of trusting the delayed event.
    intent = await stripeClient.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge'] }
    );
  }

  const settlement = classifyOneTimeCheckoutSettlement(session, intent);
  if (!settlement.eligible) {
    if (settlement.reason === 'refunded') {
      await PaymentModel.updateOne(
        { _id: payment._id },
        {
          $set: {
            status: settlement.refundStatus,
            ...(settlement.chargeId ? { stripeChargeId: settlement.chargeId } : {}),
          },
        }
      );
      return { allowed: false, reason: 'refunded', payment, intent };
    }
    const error = new Error(`Checkout settlement verification failed: ${settlement.reason}`);
    error.code = 'CHECKOUT_SETTLEMENT_INVALID';
    throw error;
  }

  // This update is the ordering guard. If charge.refunded won the race and
  // changed Payment to refunded/partial_refund, the stale Checkout completion
  // can no longer claim authorization for business fulfillment.
  const authorizedEffectKey = stripeEffectKey('checkout_authorized', session.id);
  const authorized = await PaymentModel.findOneAndUpdate(
    {
      _id: payment._id,
      stripeBusinessKey: `checkout_session:${session.id}`,
      stripeCheckoutSessionId: session.id,
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      status: {
        $in: ['requires_payment_method', 'processing', 'succeeded', 'failed', 'canceled'],
      },
    },
    {
      $set: {
        status: 'succeeded',
        ...(settlement.chargeId ? { stripeChargeId: settlement.chargeId } : {}),
      },
      $addToSet: { stripeAppliedEffects: authorizedEffectKey },
    },
    { new: true }
  );

  if (!authorized) {
    return { allowed: false, reason: 'payment_state_changed', payment, intent };
  }
  return { allowed: true, payment: authorized, intent };
}

async function verifyLegacyOrderCheckoutSettlement(
  session,
  payment,
  stripeClient = stripe
) {
  if (paymentOrIntentHasRefund(payment, null)) {
    return { allowed: false, reason: 'refunded', intent: null };
  }

  const amount = Number(session?.amount_total);
  const currency = String(session?.currency || '').toLowerCase();
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !currency ||
    Number(payment?.amount) !== amount ||
    String(payment?.currency || '').toLowerCase() !== currency
  ) {
    const error = new Error('Legacy order Checkout does not match its Payment');
    error.code = 'CHECKOUT_PAYMENT_BINDING_CONFLICT';
    throw error;
  }

  const paymentIntentId = stripeObjectId(session?.payment_intent);
  if (amount > 0 && !paymentIntentId) {
    const error = new Error('Paid legacy order Checkout has no PaymentIntent');
    error.code = 'CHECKOUT_PAYMENT_INTENT_MISSING';
    throw error;
  }
  if (!paymentIntentId) return { allowed: true, intent: null };
  if (
    payment.stripePaymentIntentId &&
    String(payment.stripePaymentIntentId) !== paymentIntentId
  ) {
    const error = new Error('Legacy order Checkout PaymentIntent binding mismatch');
    error.code = 'CHECKOUT_PAYMENT_BINDING_CONFLICT';
    throw error;
  }
  if (!stripeClient) {
    const error = new Error('Stripe is unavailable for Checkout verification');
    error.code = 'STRIPE_UNAVAILABLE';
    throw error;
  }

  const intent = await stripeClient.paymentIntents.retrieve(
    paymentIntentId,
    { expand: ['latest_charge'] }
  );
  const settlement = classifyOneTimeCheckoutSettlement(session, intent);
  if (settlement.reason === 'refunded') {
    return {
      allowed: false,
      reason: 'refunded',
      refundStatus: settlement.refundStatus,
      chargeId: settlement.chargeId,
      intent,
    };
  }
  if (!settlement.eligible) {
    const error = new Error(`Legacy order Checkout verification failed: ${settlement.reason}`);
    error.code = 'CHECKOUT_SETTLEMENT_INVALID';
    throw error;
  }
  return { allowed: true, intent };
}

async function normalizeStripeRefundEvent(event, stripeClient = stripe) {
  const object = event?.data?.object;
  if (!object) {
    const error = new Error('Stripe refund event has no object');
    error.code = 'STRIPE_REFUND_OBJECT_MISSING';
    throw error;
  }

  let charge;
  let refund = null;
  if (event.type === 'charge.refunded') {
    charge = object;
  } else if (
    event.type === 'charge.refund.updated' ||
    event.type === 'refund.updated' ||
    event.type === 'refund.created' ||
    event.type === 'refund.failed'
  ) {
    refund = object;
    const chargeId = stripeObjectId(refund.charge);
    if (!chargeId || !stripeClient) {
      const error = new Error('Cannot resolve Charge for Stripe Refund event');
      error.code = 'STRIPE_REFUND_CHARGE_MISSING';
      throw error;
    }
    // Refund events carry a Refund, not a Charge. Fetch the current Charge so
    // total amount_refunded and the PaymentIntent binding are authoritative.
    charge = await stripeClient.charges.retrieve(
      chargeId,
      { expand: ['payment_intent'] }
    );
    if (!charge || charge.id !== chargeId) {
      const error = new Error('Stripe Refund resolved to a different Charge');
      error.code = 'STRIPE_REFUND_CHARGE_MISMATCH';
      throw error;
    }
  } else {
    const error = new Error(`Unsupported Stripe refund event (${event.type})`);
    error.code = 'STRIPE_REFUND_EVENT_UNSUPPORTED';
    throw error;
  }

  const chargeId = charge?.id;
  const paymentIntentId = stripeObjectId(charge?.payment_intent);
  if (!chargeId) {
    const error = new Error('Stripe refund Charge has no id');
    error.code = 'STRIPE_REFUND_CHARGE_MISSING';
    throw error;
  }

  return { charge, refund, chargeId, paymentIntentId };
}

function refundAuditStatus(refund) {
  if (refund?.status === 'succeeded') return 'succeeded';
  if (refund?.status === 'failed' || refund?.status === 'canceled') return 'failed';
  return 'pending';
}

function classifyStripeRefundResult(refund) {
  const auditStatus = refundAuditStatus(refund);
  if (auditStatus === 'succeeded') {
    return {
      auditStatus,
      materializePayment: true,
      pending: false,
      failed: false,
      httpStatus: 200,
    };
  }
  if (auditStatus === 'failed') {
    return {
      auditStatus,
      materializePayment: false,
      pending: false,
      failed: true,
      httpStatus: 422,
    };
  }
  return {
    auditStatus: 'pending',
    materializePayment: false,
    pending: true,
    failed: false,
    httpStatus: 202,
  };
}

function refundAuditMatchesRequest(audit, expected) {
  if (!audit) return false;
  return (
    String(audit.payment || '') === String(expected.payment) &&
    String(audit.requestedBy || '') === String(expected.requestedBy) &&
    String(audit.stripePaymentIntentId || '') === String(expected.stripePaymentIntentId) &&
    String(audit.stripeChargeId || '') === String(expected.stripeChargeId) &&
    Number(audit.amount) === Number(expected.amount) &&
    Boolean(audit.fullRefund) === Boolean(expected.fullRefund)
  );
}

async function recordAmbiguousRefundError(PaymentRefundAuditModel, auditKey, error) {
  if (!PaymentRefundAuditModel || !auditKey) return;
  await PaymentRefundAuditModel.updateOne(
    {
      idempotencyKey: auditKey,
      status: 'pending',
    },
    {
      // A network/Stripe exception is ambiguous: the idempotent request may
      // have succeeded remotely. Keep the audit retryable and never downgrade
      // a previously confirmed success to `failed`.
      $set: { error: String(error?.message || error).slice(0, 1000) },
    }
  );
}

async function reconcilePaymentRefundAudit(
  refund,
  { chargeId, paymentIntentId },
  PaymentRefundAuditModel
) {
  const auditKey = String(refund?.metadata?.auditKey || '').trim();
  if (!auditKey || !PaymentRefundAuditModel) return { reconciled: false };

  const status = refundAuditStatus(refund);
  const error = status === 'failed'
    ? String(refund?.failure_reason || refund?.failure_balance_transaction || 'Stripe refund failed')
    : '';
  const result = await PaymentRefundAuditModel.updateOne(
    {
      idempotencyKey: auditKey,
      stripeChargeId: chargeId,
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      status: status === 'succeeded'
        ? { $in: ['pending', 'succeeded'] }
        : status === 'failed'
          ? { $in: ['pending', 'failed'] }
          : 'pending',
      $or: [
        { stripeRefundId: null },
        { stripeRefundId: refund.id },
      ],
    },
    {
      $set: {
        stripeRefundId: refund.id,
        status,
        error: error.slice(0, 1000),
      },
    }
  );
  return {
    reconciled: Boolean(result?.matchedCount || result?.modifiedCount),
    status,
  };
}

function resolveRefundRequest(requestedAmount, refundableAmount) {
  if (!Number.isSafeInteger(refundableAmount) || refundableAmount <= 0) {
    return { ok: false, code: 'NOTHING_TO_REFUND' };
  }
  const fullRefund = requestedAmount == null || requestedAmount === '';
  const amount = fullRefund ? refundableAmount : Number(requestedAmount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, code: 'INVALID_REFUND_AMOUNT' };
  }
  if (amount > refundableAmount) {
    return { ok: false, code: 'REFUND_EXCEEDS_AVAILABLE' };
  }
  return { ok: true, amount, fullRefund };
}

function classifyRetryableIntent(intent, expected, paymentDoc = null) {
  if (!intent) return { kind: 'missing' };
  if (paymentOrIntentHasRefund(paymentDoc, intent)) return { kind: 'refunded' };
  const matches = paymentIntentMatchesExpected(intent, expected);

  if (intent.status === 'succeeded' && matches) return { kind: 'succeeded' };
  if (intent.status === 'processing') return { kind: 'busy' };
  if (PI_REUSABLE_FOR_CHECKOUT.has(intent.status) && matches && intent.client_secret) {
    return { kind: 'reusable' };
  }
  return { kind: 'terminal' };
}

function resolvePaymentType(intent, paymentDoc) {
  return (
    intent?.metadata?.type ||
    paymentDoc?.metadata?.type ||
    paymentDoc?.metadata?.subtype ||
    'order_escrow'
  );
}

// These payments grant an entitlement outside the Payment/Order documents.
// A refund initiated here would move money before every downstream benefit
// can be deterministically compensated. Keep the admin endpoint fail-closed;
// Stripe Dashboard refunds are still observed by the webhook and surfaced for
// manual reconciliation.
const UNSUPPORTED_BENEFIT_REFUND_TYPES = new Set([
  'promotion',
  'checkout_promotion',
  'checkout_provider_promo',
  'checkout_sponsor',
  'subscription',
  'subscription_upgrade',
  'subscription_renewal',
  'video',
  'ai_concierge_pay_per_use',
  'provider_response_pay_per_use',
  'boost_purchase',
  'sponsor_ad_payment',
  'sponsor_ad_renewal',
  'contact_unlock',
  'listing_addons',
  'order_boost',
]);

function requiresManualBenefitRefund(payment) {
  if (!payment) return false;
  if (['promotion', 'subscription', 'video'].includes(payment.purpose)) return true;
  const paymentType = payment.metadata?.type || payment.metadata?.subtype;
  return UNSUPPORTED_BENEFIT_REFUND_TYPES.has(paymentType);
}

function promotionPurchaseEffectKeys(paymentIntentId) {
  if (!paymentIntentId) {
    const error = new Error('Promotion refund has no PaymentIntent binding');
    error.code = 'PROMOTION_REFUND_BINDING_MISSING';
    throw error;
  }
  return {
    activationKey: stripeEffectKey('promotion_purchase', paymentIntentId),
    reversalKey: stripeEffectKey('promotion_purchase_refund', paymentIntentId),
  };
}

function buildPromotionRefundUserPipeline(
  purchase,
  plan,
  paymentIntentId,
  refundedAt,
  { skipExpiryReversal = false } = {}
) {
  const { activationKey, reversalKey } = promotionPurchaseEffectKeys(paymentIntentId);
  const effects = { $ifNull: ['$stripeAppliedEffects', []] };
  const activationWasApplied = { $in: [activationKey, effects] };
  const points = Math.max(0, Number(plan?.rankingPointsAdd || 0));
  const purchaseEnd = purchase?.endsAt ? new Date(purchase.endsAt) : null;
  const reversalDate = new Date(refundedAt);
  if (Number.isNaN(reversalDate.getTime())) {
    const error = new Error('Promotion refund has an invalid effective date');
    error.code = 'PROMOTION_REFUND_DATE_INVALID';
    throw error;
  }

  const set = {
    stripeAppliedEffects: { $setUnion: [effects, [reversalKey]] },
  };
  if (points > 0) {
    set.rankingPoints = {
      $cond: [
        activationWasApplied,
        {
          $max: [
            0,
            { $subtract: [{ $ifNull: ['$rankingPoints', 0] }, points] },
          ],
        },
        { $ifNull: ['$rankingPoints', 0] },
      ],
    };
  }

  const addExpiryReversal = (field) => {
    if (!purchaseEnd || Number.isNaN(purchaseEnd.getTime())) return;
    set[field] = {
      $cond: [
        {
          $and: [
            activationWasApplied,
            { $eq: [`$${field}`, purchaseEnd] },
          ],
        },
        reversalDate,
        `$${field}`,
      ],
    };
  };
  if (!skipExpiryReversal && plan?.effects?.highlight) {
    addExpiryReversal('promo.highlightUntil');
  }
  if (!skipExpiryReversal && plan?.effects?.topBadge) {
    addExpiryReversal('promo.topBadgeUntil');
  }
  if (!skipExpiryReversal && plan?.effects?.aiBadge) {
    addExpiryReversal('promo.aiTopTagUntil');
  }

  return [{ $set: set }];
}

async function reversePromotionPurchaseBenefit(
  purchase,
  plan,
  { paymentIntentId, refundedAt },
  {
    UserModel = User,
    PromotionPurchaseModel = require('../models/promotionPurchase'),
  } = {}
) {
  if (!purchase?._id || !purchase.provider || !plan) {
    const error = new Error('Promotion refund target is incomplete');
    error.code = 'PROMOTION_REFUND_TARGET_MISSING';
    throw error;
  }
  if (purchase.stripePaymentIntentId &&
      String(purchase.stripePaymentIntentId) !== String(paymentIntentId)) {
    const error = new Error('Promotion refund PaymentIntent binding mismatch');
    error.code = 'PROMOTION_REFUND_BINDING_MISMATCH';
    throw error;
  }

  const { activationKey, reversalKey } = promotionPurchaseEffectKeys(paymentIntentId);
  const hasTemporalEffects = Boolean(
    plan?.effects?.highlight || plan?.effects?.topBadge || plan?.effects?.aiBadge
  );
  const activationRecorded = Boolean(await UserModel.exists({
    _id: purchase.provider,
    stripeAppliedEffects: activationKey,
  }));
  const userResult = await UserModel.updateOne(
    {
      _id: purchase.provider,
      stripeAppliedEffects: { $ne: reversalKey },
    },
    buildPromotionRefundUserPipeline(
      purchase,
      plan,
      paymentIntentId,
      refundedAt,
      // The effective expiry is a max across purchases stored in another
      // collection. Without a ledger/transaction, changing it here has a
      // TOCTOU race with a concurrent newer promotion. Keep dates intact and
      // emit a terminal manual-reconciliation alert below.
      { skipExpiryReversal: true }
    )
  );

  // User is tombstoned first. If a delayed payment_intent.succeeded races the
  // refund, its activation filter sees this marker and cannot restore points or
  // dates. A retry can safely finish marking the purchase afterwards.
  const purchaseReversed = await applyStripeEffectOnce(
    PromotionPurchaseModel,
    { _id: purchase._id },
    reversalKey,
    { $set: { status: 'refunded' } }
  );

  return {
    reversalKey,
    userReversed: Boolean(userResult?.modifiedCount ?? userResult?.nModified),
    purchaseReversed,
    fullyCompensated: activationRecorded && !hasTemporalEffects,
    manualReason: !activationRecorded
      ? 'legacy_activation_marker_missing'
      : hasTemporalEffects
        ? 'promotion_expiry_manual_reconciliation'
        : null,
  };
}

const ORDER_RELATED_PAYMENT_TYPES = new Set([
  'order_escrow',
  'additional_payment',
  'commission_external',
  'contact_unlock',
  'listing_addons',
  'order_boost',
]);

function isPaymentOwnedByUser(intent, paymentDoc, user) {
  const userId = user?._id || user?.id;
  if (!userId) return false;
  const candidateIds = [
    paymentDoc?.subscriptionUser?._id || paymentDoc?.subscriptionUser,
    paymentDoc?.client?._id || paymentDoc?.client,
    paymentDoc?.provider?._id || paymentDoc?.provider,
    intent?.metadata?.userId,
    intent?.metadata?.clientId,
    intent?.metadata?.providerId,
  ].filter(Boolean);
  if (candidateIds.some((candidate) => String(candidate) === String(userId))) return true;

  const ownerEmail = String(intent?.metadata?.advertiserEmail || '').trim().toLowerCase();
  const userEmail = String(user?.email || '').trim().toLowerCase();
  return Boolean(ownerEmail && userEmail && ownerEmail === userEmail);
}

function isCanonicalMainEscrowIntent(intent, paymentDoc, order) {
  if (!intent?.id || !order) return false;

  const orderId = order._id || order.id;
  const intentOrderId = intent.metadata?.orderId;
  const paymentOrderId = paymentDoc?.order?._id || paymentDoc?.order;
  if (intentOrderId && String(intentOrderId) !== String(orderId)) return false;
  if (paymentOrderId && String(paymentOrderId) !== String(orderId)) return false;

  const declaredTypes = [
    intent.metadata?.type,
    paymentDoc?.metadata?.type,
    paymentDoc?.metadata?.subtype,
  ].filter(Boolean);
  if (declaredTypes.some((type) => type !== 'order_escrow')) return false;

  const pointsAtIntent =
    Boolean(order.payment?.intentId) && String(order.payment.intentId) === String(intent.id);
  const pointsAtPayment =
    Boolean(order.paymentId && paymentDoc?._id) &&
    String(order.paymentId) === String(paymentDoc._id);
  const hasOrderBinding = Boolean(intentOrderId || paymentOrderId || pointsAtIntent || pointsAtPayment);

  // Gdy Order ma już kanoniczne wskaźniki, żaden starszy PI oznaczony tylko
  // metadata.order_escrow nie może ich zastąpić ani anulować nowszej płatności.
  if (order.payment?.intentId && !pointsAtIntent) return false;
  if (order.paymentId && !pointsAtPayment) return false;

  // Dla prawdziwego obiektu Stripe weryfikujemy również kwotę i walutę.
  // Syntetyczne obiekty używane przy refundach nie mają tych pól i opierają
  // się na ścisłych wskaźnikach powyżej.
  if (intent.amount != null) {
    const { stripeAmount } = resolveMainPaymentAmounts(order);
    if (!stripeAmount || Number(intent.amount) !== Number(stripeAmount)) return false;
  }
  if (intent.currency && String(intent.currency).toLowerCase() !== String(CURRENCY).toLowerCase()) {
    return false;
  }

  const destination = stripeObjectId(intent.transfer_data?.destination);
  const declaredDestination =
    intent.metadata?.destinationAccountId || paymentDoc?.metadata?.destinationAccountId;
  if (destination || declaredDestination) {
    const providerId = order.provider?._id || order.provider;
    const acceptedOfferId = order.acceptedOfferId?._id || order.acceptedOfferId;
    if (!providerId || !acceptedOfferId || !destination || !declaredDestination) return false;
    if (String(destination) !== String(declaredDestination)) return false;
    if (String(intent.metadata?.providerId || '') !== String(providerId)) return false;
    if (String(intent.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)) return false;
    if (String(paymentDoc?.provider?._id || paymentDoc?.provider || '') !== String(providerId)) {
      return false;
    }
    if (String(paymentDoc?.metadata?.providerId || '') !== String(providerId)) return false;
    if (
      String(paymentDoc?.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)
    ) return false;
    if (
      String(paymentDoc?.metadata?.destinationAccountId || '') !== String(destination)
    ) return false;
  }

  // Nowe płatności deklarują swój typ. Dla historycznych rekordów bez type
  // wymagamy dodatkowo kanonicznego wskaźnika na Order, aby poboczna płatność
  // z tym samym orderId nie mogła zostać uznana za escrow.
  if (declaredTypes.includes('order_escrow')) return hasOrderBinding;
  return hasOrderBinding && (pointsAtIntent || pointsAtPayment);
}

function orderHasPurchasedGuarantee(order) {
  const guaranteeFeePln = Number(order?.pricing?.guaranteeFee || 0);
  return order?.pricing?.includeGuarantee === true ||
    (Number.isFinite(guaranteeFeePln) && guaranteeFeePln > 0);
}

function isContactUnlockBindingValid(intent, paymentDoc, order) {
  if (!order || order.orderMode !== 'offers_only' || order.status !== 'accepted') return false;
  const providerId = order.provider?._id || order.provider;
  const acceptedOfferId = order.acceptedOfferId?._id || order.acceptedOfferId;
  if (!providerId || !acceptedOfferId) return false;
  if (String(intent?.metadata?.orderId || '') !== String(order._id)) return false;
  if (String(intent?.metadata?.providerId || '') !== String(providerId)) return false;
  if (String(intent?.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)) return false;
  if (!paymentDoc) return false;
  if (String(paymentDoc.order?._id || paymentDoc.order || '') !== String(order._id)) return false;
  if (String(paymentDoc.provider?._id || paymentDoc.provider || '') !== String(providerId)) return false;
  if (String(paymentDoc.metadata?.providerId || '') !== String(providerId)) return false;
  if (String(paymentDoc.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)) return false;
  return true;
}

function isDestinationChargeBindingValid(intent, paymentDoc, order, provider) {
  if (!intent || !paymentDoc || !order || !provider) return false;
  const providerId = order.provider?._id || order.provider;
  const acceptedOfferId = order.acceptedOfferId?._id || order.acceptedOfferId;
  const destinationAccountId = provider.stripeAccountId;
  if (!providerId || !acceptedOfferId || !destinationAccountId) return false;

  const destination = stripeObjectId(intent.transfer_data?.destination);
  if (String(destination || '') !== String(destinationAccountId)) return false;
  if (String(intent.metadata?.providerId || '') !== String(providerId)) return false;
  if (String(intent.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)) return false;
  if (
    String(intent.metadata?.destinationAccountId || '') !==
    String(destinationAccountId)
  ) return false;
  if (String(paymentDoc.order?._id || paymentDoc.order || '') !== String(order._id)) return false;
  if (String(paymentDoc.provider?._id || paymentDoc.provider || '') !== String(providerId)) return false;
  if (String(paymentDoc.metadata?.providerId || '') !== String(providerId)) return false;
  if (String(paymentDoc.metadata?.acceptedOfferId || '') !== String(acceptedOfferId)) return false;
  if (
    String(paymentDoc.metadata?.destinationAccountId || '') !==
    String(destinationAccountId)
  ) return false;
  return true;
}

function applyCanonicalMainCancellation(order, paymentDoc, intent) {
  // Refund states are terminal. A delayed `payment_intent.canceled` commonly
  // follows release/settlement paths and must never turn a refunded payment or
  // its Order back into failed/disputed.
  if (paymentOrIntentHasRefund(paymentDoc, intent)) return false;
  if (!isCanonicalMainEscrowIntent(intent, paymentDoc, order)) return false;
  const isCurrentIntent =
    (order.payment?.intentId && String(order.payment.intentId) === String(intent.id)) ||
    (order.paymentId && paymentDoc?._id && String(order.paymentId) === String(paymentDoc._id));
  if (!isCurrentIntent) return false;

  const statusAtCancellation = order.status;
  if (statusAtCancellation === 'funded') order.status = 'accepted';
  if (statusAtCancellation === 'in_progress' || statusAtCancellation === 'completed') {
    order.status = 'disputed';
    order.disputeStatus = 'reported';
    order.disputeReason = 'Escrow Stripe zostało anulowane po rozpoczęciu realizacji.';
    order.disputeReportedAt = stripeSourceDate({
      created: intent.canceled_at || intent.created,
    });
  }
  order.paymentStatus = 'failed';
  order.paidInSystem = false;
  order.protectionEligible = false;
  order.protectionStatus = 'inactive';
  order.protectionExpiresAt = null;
  order.payment = order.payment || {};
  order.payment.status = 'failed';
  order.payment.protected = false;
  return true;
}

function applyAdditionalPaymentSuccess(order, paymentDoc, intent, now = new Date()) {
  if (!order || !intent?.id) return order;
  order.additionalPaymentStatus = 'succeeded';
  order.additionalPaymentPaidAt = order.additionalPaymentPaidAt || now;
  order.clientCompletionStatus = 'accepted';
  order.clientCompletionAcceptedAt = order.clientCompletionAcceptedAt || now;
  order.payment = order.payment || {};
  order.payment.additionalIntentId = intent.id;
  if (paymentDoc?._id) order.payment.additionalPaymentId = paymentDoc._id;
  return order;
}

async function claimPaymentSucceededFromWebhook(
  paymentDoc,
  intent,
  { PaymentModel = Payment, includeAmount = false } = {}
) {
  if (!paymentDoc?._id || !intent?.id) return null;
  const set = {
    status: 'succeeded',
    method: intent.payment_method_types?.[0] || paymentDoc.method,
  };
  if (includeAmount) {
    set.amount = intent.amount;
    set.currency = intent.currency || paymentDoc.currency;
  }
  return PaymentModel.findOneAndUpdate(
    {
      _id: paymentDoc._id,
      stripePaymentIntentId: intent.id,
      status: { $nin: ['refunded', 'partial_refund'] },
    },
    { $set: set },
    { new: true }
  );
}

function classifyPaymentReturnStatus(status, isMainEscrow) {
  if (status === 'processing') {
    return { accepted: false, pending: true, httpStatus: 202 };
  }
  const accepted = isMainEscrow
    ? status === 'requires_capture' || status === 'succeeded'
    : status === 'succeeded';
  return { accepted, pending: false, httpStatus: 200 };
}

function isCanonicalMainEscrowRefund(paymentDoc, order, intentId) {
  if (!paymentDoc?._id || !order?._id || !intentId) return false;
  const paymentType = paymentDoc.metadata?.type || paymentDoc.metadata?.subtype || 'order_escrow';
  if (paymentType !== 'order_escrow') return false;
  if (String(paymentDoc.order || '') !== String(order._id)) return false;
  return (
    String(order.paymentId || '') === String(paymentDoc._id) &&
    String(order.payment?.intentId || '') === String(intentId) &&
    String(paymentDoc.stripePaymentIntentId || '') === String(intentId)
  );
}

function applyPaymentRefundToOrder(order, paymentDoc, intentId) {
  if (!order || !paymentDoc) return { paymentType: null, isMainEscrow: false };
  const intent = {
    id: intentId || paymentDoc.stripePaymentIntentId,
    metadata: {},
  };
  const paymentType = resolvePaymentType(intent, paymentDoc);
  // Refund reconciliation already resolved the authoritative Payment by PI or
  // Charge. Use the two persisted Order pointers instead of constructing a
  // partial Stripe intent that cannot satisfy destination-charge validation.
  const isMainEscrow = isCanonicalMainEscrowRefund(paymentDoc, order, intent.id);
  const refundStatus = paymentDoc.status;

  if (isMainEscrow) {
    order.paymentStatus = refundStatus;
    if (refundStatus === 'refunded') {
      order.paidInSystem = false;
      order.protectionStatus = 'void';
      order.protectionEligible = false;
      order.protectionExpiresAt = null;
      order.payment = order.payment || {};
      order.payment.status = 'refunded';
      order.payment.protected = false;
    }
    return { paymentType: 'order_escrow', isMainEscrow: true };
  }

  if (paymentType === 'additional_payment') {
    const referencedAdditionalPayment = order.payment?.additionalPaymentId;
    if (
      !referencedAdditionalPayment ||
      String(referencedAdditionalPayment) === String(paymentDoc._id)
    ) {
      order.additionalPaymentStatus = refundStatus;
    }
  } else if (paymentType === 'commission_external') {
    order.externalCommissionStatus = refundStatus;
  } else if (paymentType === 'contact_unlock' && refundStatus === 'refunded') {
    order.contactUnlockStatus = 'unpaid';
    order.contactUnlockedAt = null;
  } else if (paymentType === 'listing_addons' && refundStatus === 'refunded') {
    order.listingAddonsStatus = 'none';
    order.listingAddonsPaidAt = null;
  } else if (
    paymentType === 'order_boost' &&
    refundStatus === 'refunded' &&
    order.boostPaymentId &&
    String(order.boostPaymentId) === String(paymentDoc._id)
  ) {
    order.boostedAt = null;
    order.boostedUntil = null;
    order.boostFree = false;
  }

  return { paymentType, isMainEscrow: false };
}

function isStripeResourceMissing(error) {
  return (
    error?.code === 'resource_missing' ||
    error?.raw?.code === 'resource_missing' ||
    error?.statusCode === 404
  );
}

async function retrieveSpecialPaymentIntent(payment, expected) {
  if (!stripe || !payment?.stripePaymentIntentId) return { kind: 'missing', intent: null };
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(
      payment.stripePaymentIntentId,
      { expand: ['latest_charge'] }
    );
  } catch (error) {
    if (isStripeResourceMissing(error)) return { kind: 'missing', intent: null };
    throw error;
  }
  return { ...classifyRetryableIntent(intent, expected, payment), intent };
}

async function upsertPaymentForIntent(intentId, insertFields, PaymentModel = Payment) {
  if (!intentId) throw new Error('PaymentIntent id is required');
  const assertBinding = (payment) => {
    const expectedType = insertFields?.metadata?.type || insertFields?.metadata?.subtype;
    const actualType = payment?.metadata?.type || payment?.metadata?.subtype;
    const mismatch =
      (insertFields?.order != null && String(payment?.order || '') !== String(insertFields.order)) ||
      (insertFields?.client != null && String(payment?.client || '') !== String(insertFields.client)) ||
      (insertFields?.provider != null && String(payment?.provider || '') !== String(insertFields.provider)) ||
      (insertFields?.amount != null && Number(payment?.amount) !== Number(insertFields.amount)) ||
      (insertFields?.currency != null &&
        String(payment?.currency || '').toLowerCase() !== String(insertFields.currency).toLowerCase()) ||
      (expectedType && actualType !== expectedType);

    if (mismatch) {
      const error = new Error(`PaymentIntent is already bound to different payment data (${intentId})`);
      error.code = 'PAYMENT_INTENT_BINDING_CONFLICT';
      throw error;
    }
    return payment;
  };
  try {
    const payment = await PaymentModel.findOneAndUpdate(
      { stripePaymentIntentId: intentId },
      {
        $setOnInsert: {
          ...insertFields,
          stripePaymentIntentId: intentId,
        },
      },
      { upsert: true, new: true }
    );
    if (!payment) throw new Error(`Payment upsert returned no document (${intentId})`);
    return assertBinding(payment);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Dwa procesy mogły równocześnie obsłużyć ten sam biznesowy PI. Unikalny
    // indeks rozstrzyga wyścig; przegrany odczytuje zwycięski rekord bez
    // nadpisywania statusu succeeded/refunded.
    const payment = await PaymentModel.findOne({ stripePaymentIntentId: intentId });
    if (!payment) throw error;
    return assertBinding(payment);
  }
}

async function findLatestSpecialPayment(order, type) {
  const referencedId = type === 'additional_payment'
    ? order.payment?.additionalPaymentId
    : order.paymentId;
  if (referencedId) {
    const referenced = await Payment.findById(referencedId);
    if (
      referenced &&
      (referenced.metadata?.type === type || referenced.metadata?.subtype === type)
    ) {
      return referenced;
    }
  }
  return Payment.findOne({
    order: order._id,
    $or: [{ 'metadata.type': type }, { 'metadata.subtype': type }],
  }).sort({ createdAt: -1 });
}

async function scanOrderStripeIntents(orderId) {
  if (!stripe || !orderId) return [];
  const payments = await Payment.find({ order: orderId }).sort({ createdAt: -1 }).limit(20);
  const out = [];
  for (const payment of payments) {
    if (paymentOrIntentHasRefund(payment, null)) continue;
    const paymentType = payment.metadata?.type || payment.metadata?.subtype;
    // Ten skaner służy wyłącznie głównej autoryzacji escrow. Dopłata,
    // odblokowanie kontaktu ani prowizja nie mogą zostać uznane za główną
    // płatność tylko dlatego, że mają ten sam orderId.
    if (paymentType && paymentType !== 'order_escrow') continue;
    if (!payment.stripePaymentIntentId) continue;
    try {
      const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      out.push({ payment, intent });
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        console.warn('scanOrderStripeIntents missing:', payment.stripePaymentIntentId);
        continue;
      }
      // Przy błędzie sieciowym/Stripe 5xx nie wiemy, jaki stan ma istniejący
      // Intent. Fail-close zapobiega utworzeniu drugiego escrow.
      throw err;
    }
  }
  return out;
}

/** Anuluje zbędne autoryzacje (requires_capture) — zwalnia blokady na karcie klienta. */
async function cancelDuplicateCapturableIntents(orderId, keepIntentId) {
  if (!stripe || !orderId) return 0;
  let canceled = 0;
  const scanned = await scanOrderStripeIntents(orderId);
  for (const { payment, intent } of scanned) {
    if (intent.id === keepIntentId) continue;
    if (intent.status !== 'requires_capture') continue;
    try {
      await stripe.paymentIntents.cancel(intent.id);
      payment.status = 'canceled';
      await payment.save();
      canceled += 1;
    } catch (err) {
      console.warn('cancelDuplicateCapturableIntents:', intent.id, err.message);
    }
  }
  return canceled;
}

async function applyOrderFundedFromStripeIntent(order, intent, paymentDoc) {
  if (!order) return order;
  if (order.status !== 'accepted' && order.status !== 'funded') return order;

  order.status = 'funded';
  order.paymentStatus = intent.status === 'succeeded' ? 'succeeded' : 'processing';
  order.payment = order.payment || {};
  order.payment.intentId = intent.id;
  const hasGuarantee = orderHasPurchasedGuarantee(order);
  order.paidInSystem = intent.status === 'succeeded';
  order.protectionEligible = hasGuarantee;
  order.protectionStatus = hasGuarantee ? 'active' : 'inactive';
  order.protectionExpiresAt = hasGuarantee
    ? new Date(stripeSourceDate(intent).getTime() + GUARANTEE_DAYS * 24 * 60 * 60 * 1000)
    : null;
  order.payment.protected = hasGuarantee;
  if (paymentDoc) {
    order.paymentId = paymentDoc._id;
    paymentDoc.status = paymentIntentStatusForPaymentModel(intent.status);
    await paymentDoc.save();
  }
  await order.save();
  return order;
}

async function reconcileCapturableEscrowFromWebhook(
  eventIntent,
  {
    stripeClient = stripe,
    PaymentModel = Payment,
    OrderModel = Order,
    UserModel = User,
  } = {}
) {
  const intentId = eventIntent?.id;
  const orderId = eventIntent?.metadata?.orderId;
  if (!intentId || !orderId || !stripeClient) {
    return { applied: false, reason: 'binding_missing' };
  }

  // Webhook delivery is unordered. Only the current Stripe state is allowed
  // to fund an Order; the event snapshot may already be canceled/refunded.
  const intent = await stripeClient.paymentIntents.retrieve(
    intentId,
    { expand: ['latest_charge'] }
  );
  if (!intent || intent.id !== intentId || intent.status !== 'requires_capture') {
    return { applied: false, reason: 'intent_not_capturable', intent };
  }

  const payment = await PaymentModel.findOne({ stripePaymentIntentId: intentId });
  if (
    !payment ||
    !['requires_payment_method', 'processing'].includes(payment.status) ||
    paymentOrIntentHasRefund(payment, intent)
  ) {
    return { applied: false, reason: 'payment_terminal', intent, payment };
  }
  const order = await OrderModel.findById(orderId);
  if (!order || !isCanonicalMainEscrowIntent(intent, payment, order)) {
    return { applied: false, reason: 'not_canonical', intent, payment, order };
  }
  const providerId = order.provider?._id || order.provider;
  const provider = providerId
    ? await UserModel.findById(providerId)
        .select('stripeAccountId stripeConnectStatus')
        .lean()
    : null;
  if (!isDestinationChargeBindingValid(intent, payment, order, provider)) {
    return { applied: false, reason: 'destination_binding_mismatch', intent, payment, order };
  }

  const claimedPayment = await PaymentModel.findOneAndUpdate(
    {
      _id: payment._id,
      stripePaymentIntentId: intentId,
      status: { $in: ['requires_payment_method', 'processing'] },
    },
    { $set: { status: 'processing' } },
    { new: true }
  );
  if (!claimedPayment) {
    return { applied: false, reason: 'payment_state_changed', intent, payment, order };
  }

  const hasGuarantee = orderHasPurchasedGuarantee(order);
  const protectionExpiresAt = hasGuarantee
    ? new Date(stripeSourceDate(intent).getTime() + GUARANTEE_DAYS * 24 * 60 * 60 * 1000)
    : null;
  const claimedOrder = await OrderModel.findOneAndUpdate(
    {
      _id: order._id,
      status: { $in: ['accepted', 'funded'] },
      paymentId: claimedPayment._id,
      'payment.intentId': intentId,
    },
    {
      $set: {
        status: 'funded',
        paymentStatus: 'processing',
        paidInSystem: false,
        protectionEligible: hasGuarantee,
        protectionStatus: hasGuarantee ? 'active' : 'inactive',
        protectionExpiresAt,
        'payment.status': orderPaymentSubStatusFromStripePi('processing'),
        'payment.protected': hasGuarantee,
      },
    },
    { new: true }
  );
  if (!claimedOrder) {
    return { applied: false, reason: 'order_state_changed', intent, payment: claimedPayment, order };
  }
  return { applied: true, intent, payment: claimedPayment, order: claimedOrder };
}

/** Szuka opłaconej autoryzacji Stripe i ustawia zlecenie na funded (naprawa po błędnym UI). */
async function syncOrderPaymentFromStripe(orderId) {
  if (!stripe || !orderId) return { paid: false };
  let order = await Order.findById(orderId);
  if (!order) return { paid: false, reason: 'order_not_found' };

  const scanned = await scanOrderStripeIntents(orderId);
  const authorizedCandidates = scanned.filter(
    (row) => row.intent.status === 'requires_capture' || row.intent.status === 'succeeded'
  );
  const { stripeAmount } = resolveMainPaymentAmounts(order);
  const expected = { amount: stripeAmount, orderId: order._id, type: 'order_escrow' };
  const authorized = authorizedCandidates.find(
    (row) =>
      paymentIntentMatchesExpected(row.intent, expected) &&
      isCanonicalMainEscrowIntent(row.intent, row.payment, order)
  );
  if (!authorized && authorizedCandidates.length > 0) {
    return { paid: false, reason: 'payment_intent_mismatch' };
  }
  if (!authorized) return { paid: false };
  const duplicatesCanceled = await cancelDuplicateCapturableIntents(orderId, authorized.intent.id);
  await applyOrderFundedFromStripeIntent(order, authorized.intent, authorized.payment);
  order = await Order.findById(orderId);
  return {
    paid: true,
    order,
    paymentIntentId: authorized.intent.id,
    stripeStatus: authorized.intent.status,
    duplicatesCanceled,
  };
}

// GET /api/payments/order/:orderId/sync-status — odśwież status z Stripe (np. po udanej płatności, gdy UI utknęło)
router.get('/order/:orderId/sync-status', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });
    const clientId = order.client?._id || order.client;
    const providerId = order.provider?._id || order.provider;
    const uid = String(req.user._id);
    if (String(clientId) !== uid && String(providerId) !== uid) {
      return res.status(403).json({ message: 'Brak dostępu' });
    }
    const result = await syncOrderPaymentFromStripe(req.params.orderId);
    if (result.reason === 'payment_intent_mismatch') {
      return res.status(409).json({
        paid: false,
        code: 'PAYMENT_INTENT_MISMATCH',
        message: 'Autoryzowana płatność nie odpowiada aktualnej wycenie zlecenia. Skontaktuj się z pomocą.',
      });
    }
    if (!result.paid) {
      return res.json({ paid: false, order });
    }
    return res.json({
      paid: true,
      order: result.order,
      paymentIntentId: result.paymentIntentId,
      stripeStatus: result.stripeStatus,
      duplicatesCanceled: result.duplicatesCanceled,
    });
  } catch (e) {
    console.error('sync-status error:', e);
    res.status(500).json({ message: 'Błąd synchronizacji płatności' });
  }
});

// POST /api/payments/complete-return — weryfikacja po powrocie ze Stripe (bez stripe.js)
router.post('/complete-return', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ success: false, message: 'Płatności niedostępne' });
    }
    const { paymentIntentId, orderId: orderIdBody } = req.body || {};
    if (!paymentIntentId) {
      return res.status(400).json({ success: false, message: 'Brak identyfikatora płatności' });
    }

    const intent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge'] }
    );
    const paymentDoc = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
    const metadataOrderId = intent.metadata?.orderId;
    const paymentOrderId = paymentDoc?.order?._id || paymentDoc?.order;
    const paymentType = resolvePaymentType(intent, paymentDoc);

    if (
      metadataOrderId &&
      paymentOrderId &&
      String(metadataOrderId) !== String(paymentOrderId)
    ) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_RECORD_MISMATCH',
        message: 'Metadane Stripe i rekord płatności wskazują różne zlecenia.',
      });
    }

    const boundOrderId = metadataOrderId || paymentOrderId;

    // Wspólny ekran powrotu obsługuje także subskrypcje, wideo, boosty i
    // reklamy. Te płatności nie mają kanonicznego Order, więc weryfikujemy
    // właściciela po serwerowym Payment/metadata i jedynie raportujemy stan.
    if (!ORDER_RELATED_PAYMENT_TYPES.has(paymentType)) {
      if (
        orderIdBody &&
        boundOrderId &&
        String(orderIdBody) !== String(boundOrderId)
      ) {
        return res.status(400).json({
          success: false,
          code: 'PAYMENT_ORDER_MISMATCH',
          message: 'Identyfikator płatności nie należy do wskazanego zlecenia.',
        });
      }
      if (!isPaymentOwnedByUser(intent, paymentDoc, req.user)) {
        return res.status(403).json({
          success: false,
          code: 'PAYMENT_OWNER_MISMATCH',
          message: 'Brak dostępu do tej płatności.',
        });
      }
      if (paymentOrIntentHasRefund(paymentDoc, intent)) {
        return res.status(409).json({
          success: false,
          code: 'PAYMENT_REFUNDED',
          message: 'Ta płatność została już zwrócona i nie może ponownie aktywować usługi.',
        });
      }

      const returnState = classifyPaymentReturnStatus(intent.status, false);
      if (!returnState.accepted) {
        return res.status(returnState.httpStatus).json({
          success: false,
          pending: returnState.pending,
          status: intent.status,
          orderId: boundOrderId ? String(boundOrderId) : null,
          paymentType,
          message: returnState.pending
            ? 'Płatność jest nadal przetwarzana.'
            : intent.last_payment_error?.message || 'Płatność nie została zakończona',
        });
      }

      if (paymentDoc) {
        paymentDoc.status = 'succeeded';
        paymentDoc.method = intent.payment_method_types?.[0] || paymentDoc.method;
        await paymentDoc.save();
      }
      return res.json({
        success: true,
        pending: false,
        status: intent.status,
        orderId: boundOrderId ? String(boundOrderId) : null,
        paymentType,
        duplicatesCanceled: 0,
        message: 'Płatność zakończona pomyślnie.',
      });
    }

    if (
      orderIdBody &&
      (!boundOrderId || String(orderIdBody) !== String(boundOrderId))
    ) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_ORDER_MISMATCH',
        message: 'Identyfikator płatności nie należy do wskazanego zlecenia.',
      });
    }
    if (!boundOrderId) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_NOT_BOUND',
        message: 'Nie można potwierdzić powiązania płatności ze zleceniem.',
      });
    }

    const order = await Order.findById(boundOrderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Nie znaleziono zlecenia' });
    }
    const clientId = order.client?._id || order.client;
    if (String(clientId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Brak dostępu do tego zlecenia' });
    }
    if (paymentOrIntentHasRefund(paymentDoc, intent)) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_REFUNDED',
        message: 'Ta płatność została już zwrócona i nie może ponownie aktywować usługi.',
      });
    }

    if (
      paymentType === 'contact_unlock' &&
      !isContactUnlockBindingValid(intent, paymentDoc, order)
    ) {
      return res.status(409).json({
        success: false,
        code: 'CONTACT_UNLOCK_BINDING_MISMATCH',
        message: 'Płatność za kontakt nie odpowiada aktualnie zaakceptowanej ofercie.',
      });
    }

    if (paymentType === 'order_escrow' || paymentType === 'additional_payment') {
      const providerId = order.provider?._id || order.provider;
      const provider = providerId
        ? await User.findById(providerId)
            .select('stripeAccountId stripeConnectStatus')
            .lean()
        : null;
      if (!isDestinationChargeBindingValid(intent, paymentDoc, order, provider)) {
        return res.status(409).json({
          success: false,
          code: 'DESTINATION_BINDING_MISMATCH',
          message: 'Płatność nie odpowiada aktualnemu wykonawcy, ofercie lub kontu wypłat.',
        });
      }
    }

    const isMainEscrow = isCanonicalMainEscrowIntent(intent, paymentDoc, order);
    if (paymentType === 'order_escrow' && !isMainEscrow) {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_RECORD_MISMATCH',
        message: 'Nie można potwierdzić tej płatności jako głównego escrow zlecenia.',
      });
    }

    const returnState = classifyPaymentReturnStatus(intent.status, isMainEscrow);
    if (!returnState.accepted) {
      return res.status(returnState.httpStatus).json({
        success: false,
        pending: returnState.pending,
        status: intent.status,
        orderId: String(boundOrderId),
        paymentType,
        message: returnState.pending
          ? 'Płatność jest nadal przetwarzana.'
          : intent.last_payment_error?.message || 'Płatność nie została zakończona',
      });
    }

    let duplicatesCanceled = 0;
    if (isMainEscrow) {
      duplicatesCanceled = await cancelDuplicateCapturableIntents(boundOrderId, paymentIntentId);
      await applyOrderFundedFromStripeIntent(order, intent, paymentDoc);
    } else {
      if (paymentType === 'additional_payment') {
        applyAdditionalPaymentSuccess(order, paymentDoc, intent);
      } else if (paymentType === 'contact_unlock') {
        order.contactUnlockStatus = 'succeeded';
        order.contactUnlockedAt = order.contactUnlockedAt || stripeSourceDate(intent);
      } else if (paymentType === 'commission_external') {
        applyExternalCommissionOrderState(order, 'succeeded');
      }
      if (paymentDoc) {
        paymentDoc.status = 'succeeded';
        paymentDoc.method = intent.payment_method_types?.[0] || paymentDoc.method;
        await paymentDoc.save();
      }
      await order.save();
    }

    return res.json({
      success: true,
      pending: false,
      status: intent.status,
      orderId: String(boundOrderId),
      paymentType,
      duplicatesCanceled,
      message: intent.status === 'requires_capture'
        ? 'Środki zabezpieczone w escrow do zakończenia zlecenia.'
        : 'Płatność zakończona pomyślnie.',
    });
  } catch (e) {
    console.error('complete-return error:', e);
    res.status(500).json({ success: false, message: 'Błąd weryfikacji płatności' });
  }
});

// POST /api/payments/create-intent
// body: { orderId, requestInvoice?: boolean }
router.post('/create-intent', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Płatności są chwilowo niedostępne (brak konfiguracji Stripe).' });
    }
    const { orderId, methodHint = 'card', requestInvoice } = req.body;
    const order = await Order.findById(orderId).populate('client').populate('provider');
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });
    const clientId = order.client?._id || order.client;
    const clientName = order.client?.name || '';

    if (!clientId || String(clientId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'To nie jest Twoje zlecenie' });
    }
    if (order.paymentStatus === 'succeeded' || order.status === 'funded') {
      return res.status(409).json({ message: 'Zlecenie jest już opłacone.', alreadyPaid: true });
    }

    const providerId = order.provider?._id || order.provider;
    if (order.status !== 'accepted' || !order.acceptedOfferId || !providerId) {
      return res.status(409).json({
        code: 'ORDER_NOT_READY_FOR_PAYMENT',
        message: 'Płatność można rozpocząć dopiero po zaakceptowaniu oferty wykonawcy.',
      });
    }

    const paysThroughHelpfli =
      order.paymentPreference === 'system' || order.paymentPreference === 'both';
    const providerForConnect = providerId
      ? await User.findById(providerId)
          .select('stripeAccountId stripeConnectStatus name')
          .lean()
      : null;
    const systemPaymentReadiness = getSystemPaymentReadiness({
      enabled: ENABLE_STRIPE_CONNECT,
      paysThroughHelpfli,
      provider: providerForConnect,
    });
    if (!systemPaymentReadiness.ok) {
      return res.status(systemPaymentReadiness.status).json({
        code: systemPaymentReadiness.code,
        message: systemPaymentReadiness.message,
      });
    }

    const {
      amount,
      platformFeeAmount,
      pointsDiscount,
      stripeAmount,
    } = resolveMainPaymentAmounts(order);
    if (!amount || amount < 50) {
      return res.status(400).json({
        message:
          'Brak poprawnej kwoty do zapłaty. Odśwież stronę zlecenia lub skontaktuj się z pomocą.',
      });
    }
    if (pointsDiscount > 0) {
      return res.status(409).json({
        code: 'POINTS_REDEMPTION_REQUIRES_REPRICE',
        message: 'To zlecenie ma starszy rabat punktowy, którego nie można bezpiecznie rozliczyć online. Skontaktuj się z pomocą, aby odświeżyć wycenę.',
      });
    }

    // Klient może zaznaczyć „Chcę fakturę VAT” przy płatności. Zapisujemy
    // wybór również wtedy, gdy zwracamy istniejący Intent.
    if (typeof requestInvoice === 'boolean' && order.requestInvoice !== requestInvoice) {
      order.requestInvoice = requestInvoice;
      await order.save();
    }

    const expectedEscrowIntent = {
      amount: stripeAmount,
      orderId: order._id,
      type: 'order_escrow',
      acceptedOfferId: order.acceptedOfferId,
      providerId,
      destinationAccountId: providerForConnect.stripeAccountId,
    };

    const existingIntents = await scanOrderStripeIntents(order._id);
    const authorizedIntents = existingIntents.filter((row) =>
      row.intent.status === 'requires_capture' || row.intent.status === 'succeeded'
    );
    if (authorizedIntents.length > 0) {
      const alreadyAuthorized = authorizedIntents.find((row) =>
        paymentIntentMatchesExpected(row.intent, expectedEscrowIntent)
      ) || authorizedIntents[0];
      const matchesExpected = paymentIntentMatchesExpected(
        alreadyAuthorized.intent,
        expectedEscrowIntent
      );
      return res.status(409).json({
        code: matchesExpected ? 'ORDER_ALREADY_PAID' : 'PAYMENT_INTENT_MISMATCH',
        message: matchesExpected
          ? 'Płatność za to zlecenie została już przyjęta. Odśwież stronę zlecenia.'
          : 'Istnieje autoryzacja o innych parametrach. Skontaktuj się z pomocą przed ponowieniem płatności.',
        alreadyPaid: matchesExpected,
        paymentIntentId: alreadyAuthorized.intent.id,
      });
    }

    const processingIntents = existingIntents.filter(
      (row) => row.intent.status === 'processing'
    );
    if (processingIntents.length > 0) {
      const processingIntent = processingIntents.find((row) =>
        paymentIntentMatchesExpected(row.intent, expectedEscrowIntent)
      ) || processingIntents[0];
      const matchesExpected = paymentIntentMatchesExpected(
        processingIntent.intent,
        expectedEscrowIntent
      );
      return res.status(matchesExpected ? 202 : 409).json({
        pending: matchesExpected,
        code: matchesExpected ? 'PAYMENT_PROCESSING' : 'PAYMENT_INTENT_MISMATCH',
        message: matchesExpected
          ? 'Płatność jest nadal przetwarzana przez operatora.'
          : 'Przetwarzana płatność ma inne parametry. Skontaktuj się z pomocą.',
        paymentIntentId: processingIntent.intent.id,
      });
    }

    const reusableIntent = existingIntents.find(
      (row) =>
        PI_REUSABLE.has(row.intent.status) &&
        row.intent.client_secret &&
        paymentIntentMatchesExpected(row.intent, expectedEscrowIntent)
    );
    if (reusableIntent) {
      for (const { payment, intent } of existingIntents) {
        if (intent.id === reusableIntent.intent.id || !PI_REUSABLE.has(intent.status)) {
          continue;
        }
        await stripe.paymentIntents.cancel(
          intent.id,
          {},
          { idempotencyKey: `cancel:escrow:${intent.id}` }
        );
        payment.status = 'canceled';
        await payment.save();
      }
      return res.json({
        clientSecret: reusableIntent.intent.client_secret,
        paymentIntentId: reusableIntent.intent.id,
        reused: true,
      });
    }

    for (const { payment, intent } of existingIntents) {
      if (!PI_REUSABLE.has(intent.status)) continue;
      await stripe.paymentIntents.cancel(
        intent.id,
        {},
        { idempotencyKey: `cancel:escrow:${intent.id}` }
      );
      payment.status = 'canceled';
      await payment.save();
    }

  // Stripe Connect: destination charge przekazuje wykonawcy kwotę klienta
  // pomniejszoną wyłącznie o opłaty należące do platformy.
  const guaranteeFeeAmount = Math.max(
    0,
    getPlatformOwnedFeeAmount(order, platformFeeAmount) - platformFeeAmount
  );
  const applicationFeeAmount = Math.min(
    getPlatformOwnedFeeAmount(order, platformFeeAmount),
    stripeAmount
  );
  
  let intentPayload = {
    amount: stripeAmount, // Dokładna kwota pokazana klientowi w podsumowaniu.
    currency: CURRENCY,
    // Pełny escrow – najpierw autoryzacja, później capture po potwierdzeniu zakończenia zlecenia
    capture_method: 'manual',
    description: `Helpfli Order #${order._id}`,
    metadata: {
      type: 'order_escrow',
      orderId: String(order._id),
      clientId: String(clientId),
      providerId: String(providerId || ''),
      acceptedOfferId: String(order.acceptedOfferId),
      destinationAccountId: String(providerForConnect.stripeAccountId),
      platformFeeAmount: String(platformFeeAmount),
      guaranteeFeeAmount: String(guaranteeFeeAmount),
      applicationFeeAmount: String(applicationFeeAmount),
      pointsDiscount: String(pointsDiscount),
      clientPaidAmount: String(amount), // Rzeczywista kwota którą zapłacił klient
    },
    statement_descriptor_suffix: 'HELPFLI',
  };

  if (ENABLE_STRIPE_CONNECT && providerForConnect?.stripeAccountId) {
    intentPayload = {
      ...intentPayload,
      application_fee_amount: applicationFeeAmount,
      transfer_data: {
        destination: providerForConnect.stripeAccountId,
      },
    };
  }

  const creationGeneration = order.paymentId
    ? String(order.paymentId)
    : existingIntents[0]?.payment?._id
      ? String(existingIntents[0].payment._id)
      : 'initial';
  const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload, {
    idempotencyKeyPrefix: `escrow:${order._id}:${stripeAmount}:${creationGeneration}`,
  });
  if (!paymentIntentMatchesExpected(intent, expectedEscrowIntent)) {
    const error = new Error('Created escrow PaymentIntent binding mismatch');
    error.code = 'PAYMENT_INTENT_BINDING_CONFLICT';
    throw error;
  }

    // Zapis w Payment (status wstępny)
    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const foundingFields = buildFoundingPaymentFields(order, platformFeeAmount);

    const payment = await upsertPaymentForIntent(intent.id, {
        order: order._id,
        provider: providerId || null,
        client: clientId,
        providerName: providerForConnect?.name || '',
        clientName,
        amount,
        currency: CURRENCY,
        method: methodHint,
        status: paymentIntentStatusForPaymentModel(intent.status),
        platformFeePercent: normalizeFeeRate(order.platformFeePercent),
        platformFeeAmount: platformFeeAmount, // PlatformFee obliczane od baseAmount (przed zniżkami z punktów)
        ...foundingFields,
        pointsDiscount: pointsDiscount || 0, // Zniżka z punktów pokrywana przez platformę jako koszt marketingowy
        metadata: {
          ...intent.metadata,
          stripeAmount: stripeAmount, // Kwota faktycznie obciążająca klienta.
          clientPaidAmount: amount, // Rzeczywista kwota którą zapłacił klient
        },
      });

    order.paymentId = payment._id;
    order.currency = CURRENCY;
    order.platformFeeAmount = platformFeeAmount;
    order.paymentProvider = 'stripe';
    order.paymentStatus = 'processing';
    order.paidInSystem = false;
    // Zapamiętaj podstawowe info o płatności również w polu order.payment
    order.payment = order.payment || {};
    order.payment.intentId = intent.id;
    order.payment.status = orderPaymentSubStatusFromStripePi(payment.status);
    order.payment.method = methodHint;
    await order.save();

    res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (e) {
    console.error(e);
    await logPaymentError({
      errorType: 'other',
      errorMessage: e.message,
      errorStack: e.stack,
      orderId: req.body?.orderId,
      userId: req.user?._id,
      retryable: true,
      metadata: { action: 'create-intent', methodHint: req.body?.methodHint }
    });
    res.status(500).json({ message: 'Błąd tworzenia płatności' });
  }
});

// POST /api/payments/create-additional-intent
// Dodatkowa płatność klienta po zakończeniu zlecenia (dopłata)
router.post('/create-additional-intent', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Płatności są chwilowo niedostępne (brak konfiguracji Stripe).' });
    }

    const { orderId, methodHint = 'card' } = req.body;
    const order = await Order.findById(orderId).populate('client').populate('provider');
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });

    const clientId = order.client?._id || order.client;
    const clientName = order.client?.name || '';
    if (!clientId || String(clientId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może opłacić dopłatę' });
    }

    if (order.completionType !== 'with_payment') {
      return res.status(400).json({ message: 'To zlecenie nie wymaga dopłaty' });
    }
    if (!['completed', 'funded'].includes(order.status)) {
      return res.status(400).json({ message: 'Dopłatę można opłacić dopiero po oznaczeniu zlecenia jako zakończone' });
    }

    const additionalAmountPln = Number(order.additionalAmount || 0);
    if (!additionalAmountPln || additionalAmountPln <= 0) {
      return res.status(400).json({ message: 'Brak poprawnej kwoty dopłaty' });
    }

    if (order.additionalPaymentStatus === 'succeeded') {
      return res.status(400).json({ message: 'Dopłata została już opłacona' });
    }

    const amount = Math.round(additionalAmountPln * 100);

    const providerId = order.provider?._id || order.provider;
    const acceptedOfferId = order.acceptedOfferId?._id || order.acceptedOfferId;
    if (!providerId || !acceptedOfferId) {
      return res.status(409).json({
        code: 'ORDER_PROVIDER_BINDING_MISSING',
        message: 'Dopłata wymaga aktualnej zaakceptowanej oferty i wykonawcy.',
      });
    }
    const providerForConnect = providerId
      ? await User.findById(providerId)
          .select('stripeAccountId stripeConnectStatus name')
          .lean()
      : null;
    const paysThroughHelpfli =
      order.paymentPreference === 'system' || order.paymentPreference === 'both';
    const systemPaymentReadiness = getSystemPaymentReadiness({
      enabled: ENABLE_STRIPE_CONNECT,
      paysThroughHelpfli,
      provider: providerForConnect,
    });
    if (!systemPaymentReadiness.ok) {
      return res.status(systemPaymentReadiness.status).json({
        code: systemPaymentReadiness.code,
        message: systemPaymentReadiness.message,
      });
    }

    const existingPayment = await findLatestSpecialPayment(order, 'additional_payment');
    const existingResult = await retrieveSpecialPaymentIntent(existingPayment, {
      amount,
      orderId: order._id,
      type: 'additional_payment',
      acceptedOfferId,
      providerId,
      destinationAccountId: providerForConnect.stripeAccountId,
    });
    if (existingResult.kind === 'reusable') {
      existingPayment.status = paymentIntentStatusForPaymentModel(existingResult.intent.status);
      await existingPayment.save();
      order.additionalPaymentStatus = 'processing';
      order.payment = order.payment || {};
      order.payment.additionalIntentId = existingResult.intent.id;
      order.payment.additionalPaymentId = existingPayment._id;
      await order.save();
      return res.json({
        clientSecret: existingResult.intent.client_secret,
        paymentIntentId: existingResult.intent.id,
        reused: true,
      });
    }
    if (existingResult.kind === 'succeeded') {
      existingPayment.status = 'succeeded';
      await existingPayment.save();
      applyAdditionalPaymentSuccess(order, existingPayment, existingResult.intent);
      await order.save();
      return res.json({
        succeeded: true,
        alreadyPaid: true,
        paymentIntentId: existingResult.intent.id,
      });
    }
    if (existingResult.kind === 'busy') {
      return res.status(202).json({
        pending: true,
        paymentIntentId: existingResult.intent.id,
        message: 'Dopłata jest nadal przetwarzana przez operatora płatności.',
      });
    }
    if (existingResult.intent?.status === 'succeeded' && existingResult.kind !== 'refunded') {
      return res.status(409).json({
        code: 'PAYMENT_INTENT_MISMATCH',
        message: 'Istnieje zakończona płatność o innych parametrach. Skontaktuj się z pomocą.',
      });
    }
    if (
      existingResult.intent &&
      PI_REUSABLE_FOR_CHECKOUT.has(existingResult.intent.status)
    ) {
      await stripe.paymentIntents.cancel(
        existingResult.intent.id,
        {},
        { idempotencyKey: `cancel:additional:${existingResult.intent.id}` }
      );
      existingPayment.status = 'canceled';
      await existingPayment.save();
    }

    const additionalPlatformFeePercent = normalizeFeeRate(order.platformFeePercent);
    const platformFeeAmount = Math.round(amount * additionalPlatformFeePercent);

    let intentPayload = {
      amount,
      currency: CURRENCY,
      capture_method: 'automatic',
      description: `Helpfli Additional Payment for Order #${order._id}`,
      metadata: {
        type: 'additional_payment',
        orderId: String(order._id),
        clientId: String(clientId),
        providerId: String(providerId || ''),
        acceptedOfferId: String(acceptedOfferId),
        destinationAccountId: String(providerForConnect.stripeAccountId),
        additionalAmount: String(amount),
      },
      statement_descriptor_suffix: 'HELPFLI',
    };

    if (ENABLE_STRIPE_CONNECT && providerForConnect?.stripeAccountId) {
      intentPayload = {
        ...intentPayload,
        application_fee_amount: Math.min(platformFeeAmount, amount),
        transfer_data: {
          destination: providerForConnect.stripeAccountId,
        },
      };
    }

    const creationGeneration = existingPayment?._id
      ? String(existingPayment._id)
      : 'initial';
    const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload, {
      idempotencyKeyPrefix: `additional:${order._id}:${amount}:${creationGeneration}`,
    });
    if (!paymentIntentMatchesExpected(intent, {
      amount,
      orderId: order._id,
      type: 'additional_payment',
      acceptedOfferId,
      providerId,
      destinationAccountId: providerForConnect.stripeAccountId,
    })) {
      const error = new Error('Created additional PaymentIntent binding mismatch');
      error.code = 'PAYMENT_INTENT_BINDING_CONFLICT';
      throw error;
    }

    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const payment = await upsertPaymentForIntent(intent.id, {
        order: order._id,
        provider: providerId || null,
        client: clientId,
        providerName: providerForConnect?.name || '',
        clientName,
        amount,
        currency: CURRENCY,
        method: methodHint,
        status: paymentIntentStatusForPaymentModel(intent.status),
        platformFeePercent: additionalPlatformFeePercent,
        platformFeeAmount,
        pointsDiscount: 0,
        ...buildFoundingPaymentFields(order, platformFeeAmount),
        metadata: {
          ...intent.metadata,
          subtype: 'additional_payment',
        },
      });

    order.additionalPaymentStatus = intent.status === 'succeeded' ? 'succeeded' : 'processing';
    if (intent.status === 'succeeded') {
      applyAdditionalPaymentSuccess(order, payment, intent);
    }
    order.payment = order.payment || {};
    order.payment.additionalIntentId = intent.id;
    order.payment.additionalPaymentId = payment._id;
    await order.save();

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      succeeded: intent.status === 'succeeded',
    });
  } catch (e) {
    console.error(e);
    await logPaymentError({
      errorType: 'other',
      errorMessage: e.message,
      errorStack: e.stack,
      orderId: req.body?.orderId,
      userId: req.user?._id,
      retryable: true,
      metadata: { action: 'create-additional-intent', methodHint: req.body?.methodHint }
    });
    res.status(500).json({ message: 'Błąd tworzenia płatności dopłaty' });
  }
});

// POST /api/payments/create-commission-intent
// Odblokowanie kontaktu po wyborze wykonawcy (tryb offers_only)
// body: { orderId }
router.post('/create-contact-unlock-intent', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Płatności są chwilowo niedostępne (brak konfiguracji Stripe).' });
    }
    const { orderId, methodHint = 'card' } = req.body;
    const order = await Order.findById(orderId).populate('client');
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });

    if (order.orderMode !== 'offers_only') {
      return res.status(400).json({ message: 'To zlecenie nie wymaga opłaty za kontakt' });
    }

    const clientId = order.client?._id || order.client;
    if (!clientId || String(clientId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko klient może odblokować kontakt' });
    }
    const providerId = order.provider?._id || order.provider;
    const acceptedOfferId = order.acceptedOfferId?._id || order.acceptedOfferId;
    if (order.status !== 'accepted' || !acceptedOfferId || !providerId) {
      return res.status(409).json({
        code: 'CONTACT_UNLOCK_NOT_READY',
        message: 'Kontakt można odblokować dopiero po zaakceptowaniu oferty wykonawcy.',
      });
    }

    const UserSubscription = require('../models/UserSubscription');
    const activeSubscription = await UserSubscription.findOne({
      user: req.user._id,
      validUntil: { $gt: new Date() },
    }).lean();
    const clientPlanKey = activeSubscription?.planKey || null;
    const {
      clientHasFreeContactUnlock,
      getContactUnlockFeePln,
      isContactUnlocked,
    } = require('../utils/offersOnlyMonetization');

    if (isContactUnlocked(order)) {
      return res.status(400).json({ message: 'Kontakt jest już odblokowany' });
    }

    const feePln = getContactUnlockFeePln(clientPlanKey);
    if (clientHasFreeContactUnlock(clientPlanKey) || feePln <= 0) {
      order.contactUnlockStatus = 'waived';
      order.contactUnlockFeePln = 0;
      order.contactUnlockedAt = new Date();
      await order.save();
      return res.json({ waived: true, contactUnlocked: true });
    }

    const nominalGrosze = Math.round(feePln * 100);
    const STRIPE_MIN_PLN_GROSZE = 200;
    const amount = Math.max(nominalGrosze, STRIPE_MIN_PLN_GROSZE);

    const existingPayment = await findLatestSpecialPayment(order, 'contact_unlock');
    const existingResult = await retrieveSpecialPaymentIntent(existingPayment, {
      amount,
      orderId: order._id,
      type: 'contact_unlock',
      acceptedOfferId,
      providerId,
    });
    if (existingResult.kind === 'reusable') {
      existingPayment.status = paymentIntentStatusForPaymentModel(existingResult.intent.status);
      await existingPayment.save();
      order.contactUnlockStatus = 'processing';
      order.contactUnlockFeePln = feePln;
      await order.save();
      return res.json({
        clientSecret: existingResult.intent.client_secret,
        paymentIntentId: existingResult.intent.id,
        contactUnlockFeePln: feePln,
        chargedAmountPln: amount / 100,
        reused: true,
      });
    }
    if (existingResult.kind === 'succeeded') {
      existingPayment.status = 'succeeded';
      await existingPayment.save();
      order.contactUnlockStatus = 'succeeded';
      order.contactUnlockedAt = order.contactUnlockedAt || new Date();
      order.contactUnlockFeePln = feePln;
      await order.save();
      return res.json({
        succeeded: true,
        contactUnlocked: true,
        paymentIntentId: existingResult.intent.id,
      });
    }
    if (existingResult.kind === 'busy') {
      return res.status(202).json({
        pending: true,
        paymentIntentId: existingResult.intent.id,
        message: 'Płatność za kontakt jest nadal przetwarzana.',
      });
    }
    if (existingResult.intent?.status === 'succeeded' && existingResult.kind !== 'refunded') {
      return res.status(409).json({
        code: 'PAYMENT_INTENT_MISMATCH',
        message: 'Istnieje zakończona płatność o innych parametrach. Skontaktuj się z pomocą.',
      });
    }
    if (
      existingResult.intent &&
      PI_REUSABLE_FOR_CHECKOUT.has(existingResult.intent.status)
    ) {
      await stripe.paymentIntents.cancel(
        existingResult.intent.id,
        {},
        { idempotencyKey: `cancel:contact:${existingResult.intent.id}` }
      );
      existingPayment.status = 'canceled';
      await existingPayment.save();
    }

    const intentPayload = {
      amount,
      currency: CURRENCY,
      capture_method: 'automatic',
      description: `Odblokowanie kontaktu — zlecenie #${order._id}`,
      metadata: {
        orderId: String(order._id),
        clientId: String(clientId),
        providerId: String(providerId),
        acceptedOfferId: String(acceptedOfferId),
        type: 'contact_unlock',
        contactUnlockFeePln: String(feePln),
      },
      statement_descriptor_suffix: 'HELPFLI',
    };

    const creationGeneration = existingPayment?._id
      ? String(existingPayment._id)
      : 'initial';
    const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload, {
      idempotencyKeyPrefix: `contact:${order._id}:${amount}:${creationGeneration}`,
    });
    const allowedMethods = ['card', 'p24', 'blik', 'unknown'];
    const payMethod = allowedMethods.includes(methodHint) ? methodHint : 'card';

    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const payment = await upsertPaymentForIntent(intent.id, {
        order: order._id,
        provider: providerId,
        client: clientId,
        amount,
        currency: CURRENCY,
        method: payMethod,
        status: paymentIntentStatusForPaymentModel(intent.status),
        platformFeePercent: 1,
        platformFeeAmount: amount,
        ...buildFoundingPaymentFields(order, amount),
        metadata: {
          type: 'contact_unlock',
          contactUnlockFeePln: feePln,
          providerId: String(providerId),
          acceptedOfferId: String(acceptedOfferId),
        },
      });

    order.contactUnlockStatus = intent.status === 'succeeded' ? 'succeeded' : 'processing';
    order.contactUnlockFeePln = feePln;
    if (intent.status === 'succeeded') {
      order.contactUnlockedAt = order.contactUnlockedAt || new Date();
    }
    await order.save();

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      contactUnlockFeePln: feePln,
      chargedAmountPln: amount / 100,
      succeeded: intent.status === 'succeeded',
    });
  } catch (e) {
    console.error('create-contact-unlock-intent', e);
    res.status(500).json({ message: 'Błąd tworzenia płatności za kontakt' });
  }
});

// Tworzy PaymentIntent tylko na opłatę serwisową (platform fee) przy płatności poza systemem.
// body: { orderId }
router.post('/create-commission-intent', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Płatności są chwilowo niedostępne (brak konfiguracji Stripe).' });
    }
    const { orderId, methodHint = 'card' } = req.body;
    const order = await Order.findById(orderId).populate('client');
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });
    const clientId = order.client?._id || order.client;
    const clientName = order.client?.name || '';

    if (!clientId || String(clientId) !== String(req.user._id)) {
      return res.status(403).json({ message: 'To nie jest Twoje zlecenie' });
    }

    const hasMainPointer = Boolean(order.paymentId || order.payment?.intentId);
    const activeMainEscrow = hasMainPointer
      ? null
      : await Payment.findOne({
          order: order._id,
          $or: [
            { 'metadata.type': 'order_escrow' },
            { 'metadata.subtype': 'order_escrow' },
          ],
          status: { $nin: ['canceled', 'failed', 'refunded'] },
        }).select('_id').lean();
    const commissionReadiness = getExternalCommissionReadiness(order, {
      hasMainEscrow: hasMainPointer || Boolean(activeMainEscrow),
    });
    if (!commissionReadiness.ok) {
      const messages = {
        EXTERNAL_PAYMENT_REQUIRED: 'Prowizja dotyczy wyłącznie zleceń rozliczanych poza Helpfli.',
        ORDER_NOT_READY_FOR_COMMISSION: 'Prowizję można opłacić dopiero po zaakceptowaniu oferty wykonawcy.',
        MAIN_ESCROW_ALREADY_EXISTS: 'Dla tego zlecenia istnieje już główna płatność systemowa.',
      };
      return res.status(409).json({
        code: commissionReadiness.code,
        message: messages[commissionReadiness.code],
      });
    }
    const { providerId, acceptedOfferId } = commissionReadiness;
    const acceptedOffer = await require('../models/Offer').findOne({
      _id: acceptedOfferId,
      order: order._id,
      provider: providerId,
      status: 'accepted',
    }).select('_id').lean();
    if (!acceptedOffer) {
      return res.status(409).json({
        code: 'ACCEPTED_OFFER_BINDING_MISMATCH',
        message: 'Zaakceptowana oferta nie odpowiada aktualnemu wykonawcy zlecenia.',
      });
    }

    const platformFeePln = Number(order.pricing?.platformFee || 0);
    if (!platformFeePln || platformFeePln <= 0) {
      return res.status(400).json({ message: 'Brak opłaty serwisowej do zapłaty' });
    }
    if (order.externalCommissionStatus === 'succeeded') {
      return res.status(400).json({ message: 'Prowizja została już opłacona' });
    }

    // Stripe (PLN): minimalna kwota pojedynczej płatności to zwykle 2,00 zł — inaczej API zwraca błąd.
    const nominalGrosze = Math.round(platformFeePln * 100);
    const STRIPE_MIN_PLN_GROSZE = 200;
    const amount = Math.max(nominalGrosze, STRIPE_MIN_PLN_GROSZE);
    if (!nominalGrosze || nominalGrosze < 1) {
      return res.status(400).json({
        message: 'Kwota opłaty serwisowej jest nieprawidłowa.',
      });
    }

    const existingPayment = await findLatestSpecialPayment(order, 'commission_external');
    const existingResult = await retrieveSpecialPaymentIntent(existingPayment, {
      amount,
      orderId: order._id,
      type: 'commission_external',
      acceptedOfferId,
      providerId,
    });
    if (existingResult.kind === 'reusable') {
      existingPayment.status = paymentIntentStatusForPaymentModel(existingResult.intent.status);
      await existingPayment.save();
      applyExternalCommissionOrderState(order, 'processing');
      await order.save();
      return res.json({
        clientSecret: existingResult.intent.client_secret,
        paymentIntentId: existingResult.intent.id,
        nominalPlatformFeePln: platformFeePln,
        chargedAmountPln: amount / 100,
        reused: true,
      });
    }
    if (existingResult.kind === 'succeeded') {
      existingPayment.status = 'succeeded';
      await existingPayment.save();
      applyExternalCommissionOrderState(order, 'succeeded');
      await order.save();
      return res.json({
        succeeded: true,
        alreadyPaid: true,
        paymentIntentId: existingResult.intent.id,
        nominalPlatformFeePln: platformFeePln,
        chargedAmountPln: amount / 100,
      });
    }
    if (existingResult.kind === 'busy') {
      return res.status(202).json({
        pending: true,
        paymentIntentId: existingResult.intent.id,
        message: 'Płatność prowizji jest nadal przetwarzana.',
      });
    }
    if (existingResult.intent?.status === 'succeeded' && existingResult.kind !== 'refunded') {
      return res.status(409).json({
        code: 'PAYMENT_INTENT_MISMATCH',
        message: 'Istnieje zakończona płatność o innych parametrach. Skontaktuj się z pomocą.',
      });
    }
    if (
      existingResult.intent &&
      PI_REUSABLE_FOR_CHECKOUT.has(existingResult.intent.status)
    ) {
      await stripe.paymentIntents.cancel(
        existingResult.intent.id,
        {},
        { idempotencyKey: `cancel:commission:${existingResult.intent.id}` }
      );
      existingPayment.status = 'canceled';
      await existingPayment.save();
    }

    const intentPayload = {
      amount,
      currency: CURRENCY,
      capture_method: 'automatic',
      description: `Opłata serwisowa Helpfli za zlecenie #${order._id}`,
      metadata: {
        orderId: String(order._id),
        clientId: String(clientId),
        providerId: String(providerId),
        acceptedOfferId: String(acceptedOfferId),
        type: 'commission_external',
        commissionNominalPln: String(platformFeePln),
        commissionAmountPln: String(platformFeePln),
        stripeChargedPln: String((amount / 100).toFixed(2)),
      },
      statement_descriptor_suffix: 'HELPFLI',
    };

    const creationGeneration = existingPayment?._id
      ? String(existingPayment._id)
      : 'initial';
    const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload, {
      idempotencyKeyPrefix: `commission:${order._id}:${amount}:${creationGeneration}`,
    });

    const allowedMethods = ['card', 'p24', 'blik', 'unknown'];
    const payMethod = allowedMethods.includes(methodHint) ? methodHint : 'card';

    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const payment = await upsertPaymentForIntent(intent.id, {
        order: order._id,
        provider: providerId,
        client: clientId,
        providerName: '',
        clientName,
        amount,
        currency: CURRENCY,
        method: payMethod,
        status: paymentIntentStatusForPaymentModel(intent.status),
        // Cała kwota to opłata serwisowa
        platformFeePercent: 1,
        platformFeeAmount: amount,
        pointsDiscount: 0,
        ...buildFoundingPaymentFields(order, nominalGrosze),
        metadata: {
          ...intent.metadata,
          stripeAmount: amount,
          clientPaidAmount: amount,
        },
      });

    order.currency = CURRENCY;
    order.paymentProvider = 'stripe';
    applyExternalCommissionOrderState(
      order,
      intent.status === 'succeeded' ? 'succeeded' : 'processing'
    );
    await order.save();

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      nominalPlatformFeePln: platformFeePln,
      chargedAmountPln: amount / 100,
      succeeded: intent.status === 'succeeded',
    });
  } catch (e) {
    console.error(e);
    await logPaymentError({
      errorType: 'other',
      errorMessage: e.message,
      errorStack: e.stack,
      orderId: req.body?.orderId,
      userId: req.user?._id,
      retryable: true,
      metadata: { action: 'create-commission-intent', methodHint: req.body?.methodHint }
    });
    const stripeMsg = e?.raw?.message || e?.message || '';
    const hint =
      e?.name === 'ValidationError'
        ? 'Błąd zapisu danych zlecenia — skontaktuj się z pomocą.'
        : stripeMsg
          ? `Błąd tworzenia płatności za prowizję: ${stripeMsg}`
          : 'Błąd tworzenia płatności za prowizję';
    res.status(500).json({ message: hint });
  }
});

async function createInvoiceForOrder(client, order, payment, customerType, invoiceMode) {
  const grossAmount = order.amountTotal;
  const taxRate = 23;
  const subtotal = Math.round(grossAmount / (1 + taxRate / 100));
  const taxAmount = grossAmount - subtotal;

  const buyerName = customerType === 'company'
    ? (client.billing?.companyName || client.name || client.email)
    : (client.name || client.email);

  const saleDate = new Date();
  const dueDate = new Date(saleDate);
  dueDate.setDate(dueDate.getDate() + 14);

  const invoice = await Invoice.create({
    ownerType: 'user',
    owner: client._id,
    source: 'order',
    order: order._id,
    payment: payment._id,
    saleDate,
    dueDate,
    buyer: {
      name: buyerName,
      email: client.email,
      nip: customerType === 'company' ? (client.billing?.nip || '') : '',
      address: {
        street: client.billing?.street || '',
        city: client.billing?.city || '',
        postalCode: client.billing?.postalCode || '',
        country: client.billing?.country || 'Polska'
      }
    },
    seller: {
      name: process.env.INVOICE_SELLER_NAME || 'Helpfli',
      nip: process.env.INVOICE_SELLER_NIP || '',
      address: {
        street: process.env.INVOICE_SELLER_STREET || '',
        city: process.env.INVOICE_SELLER_CITY || '',
        postalCode: process.env.INVOICE_SELLER_POSTAL || '',
        country: process.env.INVOICE_SELLER_COUNTRY || 'Polska'
      }
    },
    items: [
      {
        description: order.service || 'Usługa Helpfli',
        quantity: 1,
        unitPrice: subtotal,
        totalPrice: subtotal
      }
    ],
    summary: {
      subtotal,
      taxRate,
      taxAmount,
      total: grossAmount,
      currency: (process.env.CURRENCY || 'pln').toUpperCase()
    },
    status: 'issued',
    metadata: {
      generatedAutomatically: true,
      customerType,
      invoiceMode
    }
  });

  try {
    await NotificationService.sendNotification(
      'client_invoice_issued',
      [client._id],
      {
        clientName: client.name || client.email,
        service: order.service || 'Usługa Helpfli',
        orderId: order._id,
        invoiceNumber: invoice.invoiceNumber
      }
    );
  } catch (notifyErr) {
    console.error('client_invoice_issued notification error:', notifyErr);
  }

  return invoice;
}

// POST /api/payments/capture - capture PaymentIntent dla escrow
router.post('/capture', authMiddleware, async (req, res) => {
  // Capture escrow jest dozwolony wyłącznie w kontrolowanym cyklu
  // confirm-receipt/releaseOrderEscrow.
  return res.status(410).json({
    code: 'DIRECT_CAPTURE_DISABLED',
    message: 'Bezpośrednia finalizacja płatności została wyłączona.',
  });
});

// STRIPE WEBHOOK
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  let webhookLockToken = null;
  const ProcessedStripeEvent = require('../models/ProcessedStripeEvent');

  try {
    event = require('stripe').webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed.', err.message);
    await logPaymentError({
      errorType: 'webhook_verification',
      errorMessage: err.message,
      errorStack: err.stack,
      stripeEventId: req.body?.id,
      retryable: false,
      metadata: { signature: sig ? 'present' : 'missing' }
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const lock = await acquireStripeEventLock(ProcessedStripeEvent, event);
    if (lock.duplicate) {
      return res.json({ received: true, duplicate: true });
    }
    if (!lock.acquired) {
      return res.status(503).json({
        received: false,
        retry: true,
        message: 'Stripe event is already being processed',
      });
    }
    webhookLockToken = lock.lockToken;

    // Wszystkie dotychczasowe gałęzie kończą się przez res.json({received:true}).
    // Przechwytujemy wyłącznie tę odpowiedź, aby najpierw trwale oznaczyć event
    // jako przetworzony. Stripe nigdy nie dostanie 2xx, jeśli zapis znacznika
    // sukcesu się nie powiedzie.
    const sendJson = res.json.bind(res);
    res.json = (payload) => {
      if (payload?.received !== true) return sendJson(payload);
      return (async () => {
        await markStripeEventProcessed(
          ProcessedStripeEvent,
          event.id,
          webhookLockToken
        );
        webhookLockToken = null;
        return sendJson(payload);
      })().catch(async (completionError) => {
        if (webhookLockToken) {
          try {
            await markStripeEventFailed(
              ProcessedStripeEvent,
              event.id,
              webhookLockToken,
              completionError
            );
          } catch (lockError) {
            console.error('Failed to mark Stripe event as failed:', lockError);
          }
          webhookLockToken = null;
        }
        console.error('Webhook completion error:', completionError);
        if (!res.headersSent) return res.status(500).send('Webhook handler error');
        return undefined;
      });
    };

    // Obsługa Stripe Subscriptions events
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      const planKey = subscription.metadata?.planKey;
      
      try {
        const UserSubscription = require('../models/UserSubscription');
        const SubscriptionPlan = require('../models/SubscriptionPlan');
        const User = require('../models/User');
        
        if (userId && planKey) {
          const plan = await SubscriptionPlan.findOne({ key: planKey, active: true });
          if (plan) {
            const validUntil = new Date(subscription.current_period_end * 1000); // Stripe używa Unix timestamp
            const startedAt = new Date(subscription.current_period_start * 1000);
            const periodEffectKey = stripeEffectKey(
              'subscription_period',
              `${subscription.id}:${subscription.current_period_start}`
            );
            
            let sub = await UserSubscription.findOne({ 
              $or: [
                { user: userId },
                { stripeSubscriptionId: subscription.id }
              ]
            });
            
            if (sub) {
              await UserSubscription.updateOne(
                {
                  _id: sub._id,
                  $or: [
                    { startedAt: { $lte: startedAt } },
                    { startedAt: null },
                    { startedAt: { $exists: false } },
                  ],
                },
                {
                  $set: {
                    planKey,
                    startedAt,
                    validUntil,
                    renews: subscription.status === 'active' || subscription.status === 'trialing',
                    stripeSubscriptionId: subscription.id,
                    stripeCustomerId: subscription.customer,
                  },
                }
              );
              // Quota/retry reset exactly once for a Stripe billing period.
              await applyStripeEffectOnce(
                UserSubscription,
                {
                  _id: sub._id,
                  $or: [
                    { startedAt: { $lte: startedAt } },
                    { startedAt: null },
                    { startedAt: { $exists: false } },
                  ],
                },
                periodEffectKey,
                {
                  $set: {
                    freeExpressLeft: plan.freeExpressPerMonth || 0,
                    paymentRetryCount: 0,
                    nextRetryAt: null,
                    lastPaymentAttempt: null,
                  },
                }
              );
            } else {
              sub = await UserSubscription.create({
                user: userId,
                planKey: planKey,
                startedAt,
                validUntil: validUntil,
                renews: subscription.status === 'active' || subscription.status === 'trialing',
                freeExpressLeft: plan.freeExpressPerMonth || 0,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: subscription.customer,
                stripeAppliedEffects: [periodEffectKey],
              });
            }
            
            // Aktualizuj User.stripeCustomerId jeśli potrzeba
            const user = await User.findById(userId);
            if (user && !user.stripeCustomerId) {
              user.stripeCustomerId = subscription.customer;
              await user.save();
            }
          }
        }
      } catch (e) {
        console.error('Subscription webhook handling error:', e);
        throw e;
      }
      
      return res.json({ received: true });
    }
    
    // Obsługa invoice.payment_failed - failed payment retry
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id;
      
      try {
        const UserSubscription = require('../models/UserSubscription');
        const subscription = await UserSubscription.findOne({ stripeSubscriptionId: subscriptionId });
        
        if (subscription) {
          const paidInvoice = await Payment.exists({
            stripeInvoiceId: invoice.id,
            status: 'succeeded',
          });
          if (paidInvoice) return res.json({ received: true, staleFailureIgnored: true });
          const failedAt = stripeSourceDate(invoice, event);
          const nextRetryAt = Number(invoice.next_payment_attempt) > 0
            ? new Date(Number(invoice.next_payment_attempt) * 1000)
            : null;
          const failedEffectKey = stripeEffectKey('invoice_failed', invoice.id);
          const applied = await applyStripeEffectOnce(
            UserSubscription,
            { _id: subscription._id },
            failedEffectKey,
            {
              $inc: { paymentRetryCount: 1 },
              $set: {
                lastPaymentAttempt: failedAt,
                nextRetryAt,
              },
            }
          );

          if (!applied) return res.json({ received: true, duplicateBusinessEffect: true });

          const retryCount = (subscription.paymentRetryCount || 0) + 1;
          
          // Wyślij email z informacją o failed payment
          const User = require('../models/User');
          const SubscriptionPlan = require('../models/SubscriptionPlan');
          const { sendMail } = require('../utils/mailer');
          
          const user = await User.findById(subscription.user);
          const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
          
          if (user && plan) {
            await sendMail({
              to: user.email,
              subject: '⚠️ Płatność za subskrypcję nie powiodła się',
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0;">⚠️ Płatność nie powiodła się</h1>
                  </div>
                  <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <p>Cześć ${user.name || ''},</p>
                    <p>Płatność za subskrypcję <strong>${plan.name}</strong> nie powiodła się.</p>
                    
                    <div style="background: #fff5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #fa709a;">
                      <p style="margin: 0; color: #fa709a; font-weight: bold;">
                        ⚠️ Stripe automatycznie ponowi próbę płatności (${retryCount}/3).
                      </p>
                    </div>
                    
                    <h2 style="color: #667eea; margin-top: 30px;">Co możesz zrobić:</h2>
                    <ul style="line-height: 1.8;">
                      <li>✅ Zaktualizuj metodę płatności - to najszybsze rozwiązanie</li>
                      <li>✅ Sprawdź czy karta nie wygasła</li>
                      <li>✅ Upewnij się że masz wystarczające środki</li>
                    </ul>
                    
                    <div style="text-align: center; margin: 30px 0;">
                      <a href="${getFrontendUrl()}/account/subscriptions?updatePayment=true" 
                         style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                        Zaktualizuj metodę płatności
                      </a>
                    </div>
                    
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                      Jeśli płatność nie powiedzie się po 3 próbach, subskrypcja zostanie anulowana.<br/>
                      Pozdrawiamy,<br/>
                      <strong>Zespół Helpfli</strong>
                    </p>
                  </div>
                </div>
              `
            });
          }
        }
      } catch (e) {
        console.error('Failed payment webhook handling error:', e);
        throw e;
      }
      
      return res.json({ received: true });
    }
    
    // Obsługa invoice.payment_succeeded - udana płatność subskrypcji
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id;
      
      try {
        const UserSubscription = require('../models/UserSubscription');
        const Payment = require('../models/Payment');
        const subscription = await UserSubscription.findOne({ stripeSubscriptionId: subscriptionId });
        
        if (subscription) {
          const { calculatePerformanceDiscount } = require('../utils/performancePricing');
          const user = await User.findById(subscription.user);
          const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
          const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
          const latestInvoiceId = typeof stripeSub.latest_invoice === 'string'
            ? stripeSub.latest_invoice
            : stripeSub.latest_invoice?.id;
          const isCurrentInvoice = !latestInvoiceId || latestInvoiceId === invoice.id;
          let performanceDiscount = 0;
          let performanceDiscountOrders = 0;
          let performanceDiscountTier = 'none';
          let stripePriceId = subscription.stripePriceId || null;

          // A delayed old invoice may be recorded, but cannot replenish current
          // quota or rewrite the currently active Stripe subscription.
          if (isCurrentInvoice && user?.role === 'provider') {
            const perfDiscount = await calculatePerformanceDiscount(subscription.user);
            performanceDiscount = perfDiscount.discountPercent;
            performanceDiscountOrders = perfDiscount.ordersCompleted;
            performanceDiscountTier = perfDiscount.tier;

            if (performanceDiscount > 0 && plan && stripeSub.status === 'active') {
              const basePrice = plan.priceMonthly || 0;
              const discountedPrice = Math.round(basePrice * (1 - performanceDiscount / 100) * 100);
              const priceData = {
                unit_amount: discountedPrice,
                currency: 'pln',
                recurring: { interval: 'month', interval_count: 1 },
                product_data: {
                  name: `${plan.name} - Performance Discount ${performanceDiscount}%`,
                },
                metadata: {
                  planKey: plan.key,
                  performanceDiscount: String(performanceDiscount),
                  discountNote: `Zniżka za ${performanceDiscountOrders} zleceń (poprz. miesiąc)`.slice(0, 450),
                },
              };
              const stripePrice = await stripe.prices.create(
                priceData,
                { idempotencyKey: `invoice:${invoice.id}:performance-price` }
              );
              await stripe.subscriptions.update(
                subscriptionId,
                {
                  items: [{ id: stripeSub.items.data[0].id, price: stripePrice.id }],
                  proration_behavior: 'none',
                  metadata: {
                    ...stripeSub.metadata,
                    performanceDiscount: String(performanceDiscount),
                    performanceDiscountOrders: String(performanceDiscountOrders),
                  },
                },
                { idempotencyKey: `invoice:${invoice.id}:performance-subscription` }
              );
              stripePriceId = stripePrice.id;
            }
          }

          if (isCurrentInvoice) {
            await applyStripeEffectOnce(
              UserSubscription,
              { _id: subscription._id },
              stripeEffectKey('invoice_succeeded', invoice.id),
              {
                $set: {
                  validUntil: new Date(stripeSub.current_period_end * 1000),
                  startedAt: new Date(stripeSub.current_period_start * 1000),
                  freeExpressLeft: plan?.freeExpressPerMonth || 0,
                  paymentRetryCount: 0,
                  nextRetryAt: null,
                  lastPaymentAttempt: null,
                  performanceDiscount,
                  performanceDiscountOrders,
                  performanceDiscountTier,
                  ...(stripePriceId ? { stripePriceId } : {}),
                },
              }
            );
          }

          const renewalBusinessKey = `subscription_invoice:${invoice.id}`;
          const legacyInvoicePayment = await Payment.findOne({
            $or: [
              { stripeBusinessKey: renewalBusinessKey },
              { stripeInvoiceId: invoice.id },
            ],
          });
          if (legacyInvoicePayment && !legacyInvoicePayment.stripeBusinessKey) {
            await Payment.updateOne(
              { _id: legacyInvoicePayment._id, stripeBusinessKey: null },
              { $set: { stripeBusinessKey: renewalBusinessKey } }
            );
          }
          await Payment.updateOne(
            { stripeBusinessKey: renewalBusinessKey },
            {
              $set: {
                status: 'succeeded',
                stripeChargeId: typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id,
              },
              $setOnInsert: {
                purpose: 'subscription',
                subscriptionUser: subscription.user,
                subscriptionPlanKey: subscription.planKey,
                amount: invoice.amount_paid,
                currency: invoice.currency,
                stripeSubscriptionId: subscriptionId,
                stripeCustomerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id,
                stripeInvoiceId: invoice.id,
                stripeBusinessKey: renewalBusinessKey,
                metadata: {
                  type: 'subscription_renewal',
                  invoiceId: invoice.id,
                  performanceDiscount: performanceDiscount > 0 ? String(performanceDiscount) : null,
                },
              },
            },
            { upsert: true }
          );
        }
      } catch (e) {
        console.error('Invoice payment succeeded webhook handling error:', e);
        throw e;
      }
      
      return res.json({ received: true });
    }
    
    // Obsługa customer.subscription.deleted - anulowana subskrypcja
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      
      try {
        const UserSubscription = require('../models/UserSubscription');
        const sub = await UserSubscription.findOne({ stripeSubscriptionId: subscription.id });
        
        if (sub) {
          await UserSubscription.updateOne(
            { _id: sub._id },
            {
              $set: {
                renews: false,
                cancelledAt: stripeSourceDate(subscription, event),
              },
            }
          );
        }
      } catch (e) {
        console.error('Subscription deleted webhook handling error:', e);
        throw e;
      }
      
      return res.json({ received: true });
    }

    // Stripe Checkout — wcześniej tylko w osobnym payments.webhook.js (nienamontowanym na /api/payments)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const md = session.metadata || {};
      const paid = session.payment_status === 'paid';

      try {
        // Ranking TOP z /api/promotions/checkout (Promotion + metadata.plan)
        if (paid && md.type === 'promotion' && md.plan) {
          const Promotion = require('../models/promotion');
          const PLAN_CFG = {
            PROMO_24H: { days: 1, points: 20 },
            TOP_7: { days: 7, points: 40 },
            TOP_14: { days: 14, points: 60 },
            TOP_31: { days: 31, points: 100 },
          };
          const rec = await Promotion.findOne({
            stripeCheckoutSessionId: session.id,
            plan: md.plan,
            ...(md.userId ? { user: md.userId } : {}),
          });
          if (rec) {
            const cfg = PLAN_CFG[rec.plan];
            if (cfg) {
              const checkoutAuthorization = await authorizeOneTimeCheckoutFulfillment(
                session,
                {
                  type: 'checkout_promotion',
                  userId: rec.user,
                  metadata: { plan: rec.plan },
                }
              );
              if (!checkoutAuthorization.allowed) {
                return res.json({
                  received: true,
                  ignoredRefundedPayment: checkoutAuthorization.reason === 'refunded',
                  checkoutFulfillmentBlocked: true,
                });
              }
              const activeFrom = stripeSourceDate(session, event);
              const activeTo = new Date(activeFrom.getTime() + cfg.days * 24 * 60 * 60 * 1000);
              const effectKey = stripeEffectKey('checkout_promotion', session.id);
              await applyStripeEffectOnce(
                Promotion,
                { _id: rec._id },
                effectKey,
                {
                  $set: {
                    status: 'active',
                    activeFrom,
                    activeTo,
                    pointsGranted: cfg.points,
                  },
                }
              );
              await applyStripeEffectOnce(
                User,
                { _id: rec.user },
                effectKey,
                {
                  $inc: { rankingPoints: cfg.points },
                  $max: {
                    'promo.topBadgeUntil': activeTo,
                    'promo.rankBoostUntil': activeTo,
                    'promo.rankBoostPoints': cfg.points,
                  },
                }
              );
            }
          }
          return res.json({ received: true });
        }

        // PRO badge (/api/pro/checkout)
        if (paid && md.type === 'pro' && md.userId) {
          const ProSubscription = require('../models/proSubscription');
          const paidAt = stripeSourceDate(session, event);
          let periodEnd = new Date(paidAt.getTime() + 30 * 24 * 60 * 60 * 1000);
          const subRef = session.subscription;
          const subId = typeof subRef === 'string' ? subRef : subRef?.id;
          if (stripe && subId) {
            try {
              const stripeSub = await stripe.subscriptions.retrieve(subId);
              periodEnd = new Date(stripeSub.current_period_end * 1000);
            } catch (e) {
              console.error('checkout.session.completed PRO: retrieve subscription', e);
            }
          }
          const pending = await ProSubscription.findOne({ user: md.userId, status: 'incomplete' }).sort({
            createdAt: -1,
          });
          if (pending) {
            await ProSubscription.updateOne(
              { _id: pending._id },
              {
                $set: {
                  status: 'active',
                  stripeCheckoutSessionId: session.id,
                  stripeSubscriptionId: subId || pending.stripeSubscriptionId,
                  currentPeriodEnd: periodEnd,
                },
              }
            );
          } else {
            await ProSubscription.updateOne(
              { stripeCheckoutSessionId: session.id },
              {
                $setOnInsert: {
                  user: md.userId,
                  tier: md.tier === 'PRO_YEARLY' ? 'PRO_YEARLY' : 'PRO_MONTHLY',
                  status: 'active',
                  stripeCheckoutSessionId: session.id,
                  stripeSubscriptionId: subId,
                  currentPeriodEnd: periodEnd,
                },
              },
              { upsert: true }
            );
          }
          await User.findByIdAndUpdate(md.userId, { $set: { 'badges.pro': true } });
          return res.json({ received: true });
        }

        // Pakiety wyróżnień providera (/api/promo/checkout — metadata.productKey)
        if (paid && md.productKey && md.userId) {
          if (md.autoRenew !== 'true') {
            const checkoutAuthorization = await authorizeOneTimeCheckoutFulfillment(
              session,
              {
                type: 'checkout_provider_promo',
                userId: md.userId,
                metadata: { productKey: md.productKey },
              }
            );
            if (!checkoutAuthorization.allowed) {
              return res.json({
                received: true,
                ignoredRefundedPayment: checkoutAuthorization.reason === 'refunded',
                checkoutFulfillmentBlocked: true,
              });
            }
          }
          const { activatePromo } = require('./promo');
          await activatePromo(md.userId, md.productKey, {
            effectKey: stripeEffectKey('checkout_provider_promo', session.id),
            startsAt: stripeSourceDate(session, event),
          });
          if (md.autoRenew === 'true' && session.subscription) {
            const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
            await User.findByIdAndUpdate(md.userId, {
              $set: {
                'promo.autoRenew': true,
                'promo.subscriptionId': subId,
                'promo.subscriptionProductKey': md.productKey,
              },
            });
          }
          return res.json({ received: true });
        }

        // Kampanie sponsorowane w wynikach (/api/sponsor/checkout — metadata.kind)
        if (paid && md.kind === 'sponsor' && md.userId && md.startAt && md.endAt) {
          const checkoutAuthorization = await authorizeOneTimeCheckoutFulfillment(
            session,
            {
              type: 'checkout_sponsor',
              userId: md.userId,
              metadata: {
                service: md.service || '*',
                startAt: md.startAt,
                endAt: md.endAt,
              },
            }
          );
          if (!checkoutAuthorization.allowed) {
            return res.json({
              received: true,
              ignoredRefundedPayment: checkoutAuthorization.reason === 'refunded',
              checkoutFulfillmentBlocked: true,
            });
          }
          const SponsorCampaign = require('../models/SponsorCampaign');
          const positions = String(md.positions || '2,7')
            .split(',')
            .map((x) => Number(String(x).trim()))
            .filter((n) => !Number.isNaN(n) && n > 0);
          await SponsorCampaign.updateOne(
            { stripeCheckoutSessionId: session.id },
            {
              $setOnInsert: {
                provider: md.userId,
                service: md.service || '*',
                positions: positions.length ? positions : [2, 7],
                startAt: new Date(md.startAt),
                endAt: new Date(md.endAt),
                dailyCap: 1,
                isActive: true,
                stripeCheckoutSessionId: session.id,
              },
            },
            { upsert: true }
          );
          return res.json({ received: true });
        }

        // Zamówienie opłacone Checkoutem (wymaga zapisania stripeCheckoutSessionId przy tworzeniu sesji)
        if (paid && md.type === 'order') {
          const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
          if (payment) {
            const verification = await verifyLegacyOrderCheckoutSettlement(
              session,
              payment,
              stripe
            );
            const piId = stripeObjectId(session.payment_intent);
            if (!verification.allowed) {
              if (verification.refundStatus) {
                await Payment.updateOne(
                  { _id: payment._id },
                  {
                    $set: {
                      status: verification.refundStatus,
                      ...(verification.chargeId
                        ? { stripeChargeId: verification.chargeId }
                        : {}),
                    },
                  }
                );
              }
              return res.json({ received: true, ignoredRefundedPayment: true });
            }
            const pm0 = session.payment_method_types?.[0];
            const freshChargeId = stripeObjectId(verification.intent?.latest_charge);
            const reconciledPayment = await Payment.findOneAndUpdate(
              {
                _id: payment._id,
                status: { $nin: ['refunded', 'partial_refund'] },
              },
              {
                $set: {
                  status: 'succeeded',
                  ...(piId ? { stripePaymentIntentId: piId } : {}),
                  ...(freshChargeId ? { stripeChargeId: freshChargeId } : {}),
                  ...(pm0 && ['card', 'p24', 'blik'].includes(pm0)
                    ? { method: pm0 }
                    : {}),
                },
              },
              { new: true }
            );
            if (!reconciledPayment) {
              return res.json({ received: true, ignoredRefundedPayment: true });
            }

            const order = await Order.findById(reconciledPayment.order);
            if (order) {
              const hasGuarantee = orderHasPurchasedGuarantee(order);
              order.payment = {
                ...(typeof order.payment?.toObject === 'function'
                  ? order.payment.toObject()
                  : order.payment || {}),
                status: 'paid',
                method: pm0 || order.payment?.method || 'card',
                intentId: piId || order.payment?.intentId || null,
                protected: hasGuarantee,
              };
              order.protectionEligible = hasGuarantee;
              order.protectionStatus = hasGuarantee ? 'active' : 'inactive';
              order.protectionExpiresAt = hasGuarantee
                ? new Date(stripeSourceDate(session, event).getTime() + GUARANTEE_DAYS*24*60*60*1000)
                : null;
              if (order.status === 'awaiting_payment') order.status = 'paid';
              await order.save();
            }
          }
          return res.json({ received: true });
        }
      } catch (e) {
        console.error('checkout.session.completed webhook error:', e);
        throw e;
      }

      return res.json({ received: true });
    }

    // Escrow (capture_method: manual) — po autoryzacji karty status = requires_capture (nie succeeded)
    if (event.type === 'payment_intent.amount_capturable_updated') {
      const eventIntent = event.data.object;
      const orderId = eventIntent.metadata?.orderId;
      if (orderId) {
        try {
          const reconciliation = await reconcileCapturableEscrowFromWebhook(eventIntent);
          if (reconciliation.applied) {
            await cancelDuplicateCapturableIntents(orderId, eventIntent.id);
          }
        } catch (e) {
          console.error('payment_intent.amount_capturable_updated webhook error:', e);
          throw e;
        }
      }
      return res.json({ received: true });
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;

      // Subskrypcja: metadata na PI (po /subscribe) albo w Mongo Payment
      const subscriptionPayment = await Payment.findOne({ stripePaymentIntentId: intent.id });
      if (paymentOrIntentHasRefund(subscriptionPayment, intent)) {
        return res.json({ received: true, ignoredRefundedPayment: true });
      }
      let userId =
        intent.metadata?.userId ||
        (subscriptionPayment?.subscriptionUser
          ? String(subscriptionPayment.subscriptionUser)
          : null) ||
        subscriptionPayment?.metadata?.userId;
      let planKey =
        intent.metadata?.planKey ||
        subscriptionPayment?.metadata?.planKey ||
        subscriptionPayment?.subscriptionPlanKey;
      let billingPeriod =
        intent.metadata?.billingPeriod ||
        subscriptionPayment?.metadata?.billingPeriod ||
        'monthly';
      let referralCode = intent.metadata?.referralCode || subscriptionPayment?.metadata?.referralCode;
      let earlyAdopter =
        intent.metadata?.earlyAdopter === 'true' ||
        subscriptionPayment?.metadata?.earlyAdopter === 'true';

      const looksLikeSubscription =
        intent.metadata?.type === 'subscription' ||
        subscriptionPayment?.metadata?.type === 'subscription' ||
        subscriptionPayment?.purpose === 'subscription';

      if (looksLikeSubscription && userId && planKey) {
        userId = String(userId);
        try {
          const plan = await SubscriptionPlan.findOne({ key: planKey, active: true });
          const buyerForCompany = planKey.startsWith('BUSINESS_')
            ? await User.findById(userId).populate('company')
            : null;

          if (subscriptionPayment) {
            subscriptionPayment.status = 'succeeded';
            subscriptionPayment.method = intent.payment_method_types?.[0] || subscriptionPayment.method;
            subscriptionPayment.amount = intent.amount;
            subscriptionPayment.currency = intent.currency || subscriptionPayment.currency;
            subscriptionPayment.subscriptionUser = subscriptionPayment.subscriptionUser || userId;
            subscriptionPayment.subscriptionPlanKey = subscriptionPayment.subscriptionPlanKey || planKey;
            await subscriptionPayment.save();
          }

          if (userId && plan) {
            const now = stripeSourceDate(intent, event);
            const validUntil = new Date(now);
            const subscriptionEffectKey = stripeEffectKey('subscription_payment', intent.id);

            if (billingPeriod === 'yearly') {
              validUntil.setFullYear(validUntil.getFullYear() + 1);
            } else {
              validUntil.setMonth(validUntil.getMonth() + 1);
            }

            const totalUsers = await User.countDocuments();
            const isEarlyAdopter = earlyAdopter || totalUsers <= 1000;
            const earlyAdopterDiscount = isEarlyAdopter ? 30 : 0;

            let loyaltyMonths = 0;
            let loyaltyDiscount = 0;
            const existingSub = await UserSubscription.findOne({ user: userId });
            if (existingSub) {
              const monthsDiff = Math.floor((now - existingSub.startedAt) / (1000 * 60 * 60 * 24 * 30));
              loyaltyMonths = monthsDiff;
              if (loyaltyMonths >= 24) {
                loyaltyDiscount = 15;
              } else if (loyaltyMonths >= 12) {
                loyaltyDiscount = 10;
              } else if (loyaltyMonths >= 6) {
                loyaltyDiscount = 5;
              }
            }

            let sub = await UserSubscription.findOne({ user: userId });
            if (sub) {
              const resetDate = new Date(now.getFullYear(), now.getMonth(), 1);
              const subscriptionSet = {
                planKey: plan.key,
                startedAt: now,
                validUntil,
                renews: true,
                freeExpressLeft: plan.freeExpressPerMonth || 0,
                earlyAdopter: isEarlyAdopter,
                earlyAdopterDiscount,
                loyaltyMonths,
                loyaltyDiscount,
                ...(referralCode ? { referralCodeUsed: referralCode.toUpperCase() } : {}),
                isBusinessPlan: planKey.startsWith('BUSINESS_'),
                pendingPlanKey: null,
                pendingBillingPeriod: null,
              };
              if (planKey === 'CLIENT_PRO' || planKey === 'PROV_PRO') {
                Object.assign(subscriptionSet, {
                  freeOrderBoostsLimit: 10,
                  freeOrderBoostsLeft: 10,
                  freeOrderBoostsResetDate: resetDate,
                  freeOfferBoostsLimit: 10,
                  freeOfferBoostsLeft: 10,
                  freeOfferBoostsResetDate: resetDate,
                });
              } else if (planKey === 'CLIENT_STD' || planKey === 'PROV_STD') {
                Object.assign(subscriptionSet, {
                  freeOrderBoostsLimit: 5,
                  freeOrderBoostsLeft: 5,
                  freeOrderBoostsResetDate: resetDate,
                  freeOfferBoostsLimit: 5,
                  freeOfferBoostsLeft: 5,
                  freeOfferBoostsResetDate: resetDate,
                });
              } else {
                Object.assign(subscriptionSet, {
                  freeOrderBoostsLimit: 0,
                  freeOrderBoostsLeft: 0,
                  freeOfferBoostsLimit: 0,
                  freeOfferBoostsLeft: 0,
                });
              }

              if (planKey.startsWith('BUSINESS_')) {
                const compId = buyerForCompany?.company?._id || buyerForCompany?.company || sub.companyId;
                if (compId) {
                  subscriptionSet.companyId = compId;
                  subscriptionSet.useCompanyResourcePool = true;
                }
              }

              await applyStripeEffectOnce(
                UserSubscription,
                {
                  _id: sub._id,
                  $or: [
                    { startedAt: { $lte: now } },
                    { startedAt: null },
                    { startedAt: { $exists: false } },
                  ],
                },
                subscriptionEffectKey,
                { $set: subscriptionSet }
              );
            } else {
              const resetDate = new Date(now.getFullYear(), now.getMonth(), 1);
              let freeOrderBoostsLimit = 0;
              let freeOrderBoostsLeft = 0;
              let freeOfferBoostsLimit = 0;
              let freeOfferBoostsLeft = 0;

              if (planKey === 'CLIENT_PRO' || planKey === 'PROV_PRO') {
                freeOrderBoostsLimit = 10;
                freeOrderBoostsLeft = 10;
                freeOfferBoostsLimit = 10;
                freeOfferBoostsLeft = 10;
              } else if (planKey === 'CLIENT_STD' || planKey === 'PROV_STD') {
                freeOrderBoostsLimit = 5;
                freeOrderBoostsLeft = 5;
                freeOfferBoostsLimit = 5;
                freeOfferBoostsLeft = 5;
              }

              let companyIdCreate = null;
              if (planKey.startsWith('BUSINESS_')) {
                companyIdCreate = buyerForCompany?.company?._id || buyerForCompany?.company || null;
              }

              sub = await UserSubscription.create({
                user: userId,
                planKey: plan.key,
                startedAt: now,
                validUntil,
                renews: true,
                freeExpressLeft: plan.freeExpressPerMonth || 0,
                earlyAdopter: isEarlyAdopter,
                earlyAdopterDiscount: earlyAdopterDiscount,
                loyaltyMonths: loyaltyMonths,
                loyaltyDiscount: loyaltyDiscount,
                referralCodeUsed: referralCode ? referralCode.toUpperCase() : null,
                isBusinessPlan: planKey.startsWith('BUSINESS_'),
                companyId: companyIdCreate,
                useCompanyResourcePool: Boolean(companyIdCreate && planKey.startsWith('BUSINESS_')),
                stripeSubscriptionId: subscriptionPayment?.stripeSubscriptionId || null,
                stripeCustomerId: subscriptionPayment?.stripeCustomerId || null,
                freeOrderBoostsLimit,
                freeOrderBoostsLeft,
                freeOrderBoostsResetDate: resetDate,
                freeOfferBoostsLimit,
                freeOfferBoostsLeft,
                freeOfferBoostsResetDate: resetDate,
                stripeAppliedEffects: [subscriptionEffectKey],
              });
            }

            if (planKey.startsWith('BUSINESS_')) {
              const Company = require('../models/Company');
              const { initializeCompanyResourcePool } = require('../utils/resourcePool');
              const compId =
                buyerForCompany?.company?._id || buyerForCompany?.company || sub?.companyId;
              if (compId) {
                await initializeCompanyResourcePool(compId.toString(), planKey, {
                  effectKey: stripeEffectKey('business_resource_pool', intent.id),
                  occurredAt: now,
                });
                const company = await Company.findById(compId);
                if (company) {
                  company.onboardingSteps = company.onboardingSteps || {};
                  if (!company.onboardingSteps.planSelected) {
                    company.onboardingSteps.planSelected = true;
                    await company.save();
                  }
                }
              } else {
                console.warn('[webhook] BUSINESS_ subscription paid but buyer has no company', userId);
              }
            }

            if (referralCode) {
              const ReferralCode = require('../models/ReferralCode');
              const refCode = await ReferralCode.findOne({ code: referralCode.toUpperCase(), active: true });
              if (refCode && refCode.referrer.toString() !== userId) {
                const referrer = await User.findById(refCode.referrer);
                if (referrer) {
                  const rewardPlanKey = refCode.rewards.referrerReward === '1_month_pro'
                    ? (referrer.role === 'provider' ? 'PROV_PRO' : 'CLIENT_PRO')
                    : (referrer.role === 'provider' ? 'PROV_STD' : 'CLIENT_STD');

                  const rewardPlan = await SubscriptionPlan.findOne({ key: rewardPlanKey, active: true });
                  if (rewardPlan) {
                    let referrerSub = await UserSubscription.findOne({ user: referrer._id });
                    const referralEffectKey = stripeEffectKey('referral_reward', intent.id);
                    if (referrerSub) {
                      await UserSubscription.updateOne(
                        {
                          _id: referrerSub._id,
                          stripeAppliedEffects: { $ne: referralEffectKey },
                        },
                        [
                          {
                            $set: {
                              validUntil: {
                                $dateAdd: {
                                  startDate: { $max: ['$validUntil', now] },
                                  unit: 'month',
                                  amount: 1,
                                },
                              },
                              stripeAppliedEffects: {
                                $concatArrays: [
                                  { $ifNull: ['$stripeAppliedEffects', []] },
                                  [referralEffectKey],
                                ],
                              },
                            },
                          },
                        ]
                      );
                    } else {
                      const rewardValidUntil = new Date(now);
                      rewardValidUntil.setMonth(rewardValidUntil.getMonth() + 1);
                      referrerSub = await UserSubscription.create({
                        user: referrer._id,
                        planKey: rewardPlanKey,
                        startedAt: now,
                        validUntil: rewardValidUntil,
                        renews: false,
                        freeExpressLeft: rewardPlan.freeExpressPerMonth || 0,
                        stripeAppliedEffects: [referralEffectKey],
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error('Subscription webhook handling error:', e);
          throw e;
        }

        return res.json({ received: true });
      }

      // Obsługa pay-per-use dla AI Concierge
      if (intent.metadata?.type === 'ai_concierge_pay_per_use') {
        const userId = intent.metadata.userId;
        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            payment.amount = intent.amount;
            payment.currency = intent.currency || payment.currency;
            await payment.save();
          }

          // Zaznacz użycie jako płatne w User model
          await applyStripeEffectOnce(
            User,
            { _id: userId },
            stripeEffectKey('ai_concierge_usage', intent.id),
            {
              $push: {
                aiConciergeUsage: {
                  date: stripeSourceDate(intent, event),
                  description: '',
                  service: '',
                  paid: true,
                  payPerUsePrice: intent.amount,
                  stripePaymentIntentId: intent.id,
                },
              },
            }
          );
        } catch (e) {
          console.error('AI Concierge pay-per-use webhook error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      // Obsługa pay-per-use dla Provider Responses
      if (intent.metadata?.type === 'provider_response_pay_per_use') {
        const userId = intent.metadata.userId;
        const orderId = intent.metadata.orderId;
        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            payment.amount = intent.amount;
            payment.currency = intent.currency || payment.currency;
            await payment.save();
          }

          // Zapisz płatne użycie w UsageAnalytics
          const UsageAnalytics = require('../models/UsageAnalytics');
          const occurredAt = stripeSourceDate(intent, event);
          const monthKey = `${occurredAt.getUTCFullYear()}-${String(occurredAt.getUTCMonth() + 1).padStart(2, '0')}`;
          await applyStripeEffectOnce(
            UsageAnalytics,
            { user: userId, monthKey },
            stripeEffectKey('provider_response_usage', intent.id),
            {
              $inc: { providerResponses: 1, providerResponsesPaid: 1 },
              $setOnInsert: { planKey: 'PAY_PER_USE', date: occurredAt },
            },
            { updateOptions: { upsert: true } }
          );

          // Pozwól na dodanie odpowiedzi (limit został przekroczony, ale zapłacono)
          // Frontend powinien ponownie wywołać endpoint POST /api/orders/:id/proposals z payPerUse: true
        } catch (e) {
          console.error('Provider response pay-per-use webhook error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      // Obsługa dopłat do zleceń (additional payment)
      if (intent.metadata?.type === 'additional_payment') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });

          const providerId = order?.provider?._id || order?.provider;
          const provider = providerId
            ? await User.findById(providerId)
                .select('stripeAccountId stripeConnectStatus')
                .lean()
            : null;
          if (!isDestinationChargeBindingValid(intent, payment, order, provider)) {
            throw new Error(`Additional payment destination binding mismatch (${intent.id})`);
          }
          if (paymentOrIntentHasRefund(payment, intent)) {
            return res.json({ received: true, ignoredRefundedPayment: true });
          }
          const claimedPayment = await claimPaymentSucceededFromWebhook(payment, intent);
          if (!claimedPayment) {
            return res.json({ received: true, ignoredRefundedPayment: true });
          }
          if (order) {
            const now = stripeSourceDate(intent, event);
            await Order.findOneAndUpdate(
              {
                _id: order._id,
                additionalPaymentStatus: { $nin: ['refunded', 'partial_refund'] },
                $and: [
                  {
                    $or: [
                      { 'payment.additionalPaymentId': claimedPayment._id },
                      { 'payment.additionalPaymentId': null },
                      { 'payment.additionalPaymentId': { $exists: false } },
                    ],
                  },
                  {
                    $or: [
                      { 'payment.additionalIntentId': intent.id },
                      { 'payment.additionalIntentId': null },
                      { 'payment.additionalIntentId': { $exists: false } },
                    ],
                  },
                ],
              },
              {
                $set: {
                  additionalPaymentStatus: 'succeeded',
                  additionalPaymentPaidAt: order.additionalPaymentPaidAt || now,
                  clientCompletionStatus: 'accepted',
                  clientCompletionAcceptedAt: order.clientCompletionAcceptedAt || now,
                  'payment.additionalIntentId': intent.id,
                  'payment.additionalPaymentId': claimedPayment._id,
                },
              }
            );
          }
        } catch (e) {
          console.error('Additional payment webhook handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      // Obsługa subscription upgrade przez PaymentIntent (fallback)
      if (intent.metadata?.type === 'subscription_upgrade') {
        const userId = intent.metadata.userId;
        const newPlanKey = intent.metadata.newPlanKey;
        
        try {
          const UserSubscription = require('../models/UserSubscription');
          const SubscriptionPlan = require('../models/SubscriptionPlan');
          const subscription = await UserSubscription.findOne({ user: userId });
          const newPlan = await SubscriptionPlan.findOne({ key: newPlanKey });
          
          if (subscription && newPlan) {
            const occurredAt = stripeSourceDate(intent, event);
            await applyStripeEffectOnce(
              UserSubscription,
              {
                _id: subscription._id,
                $or: [
                  { startedAt: { $lte: occurredAt } },
                  { startedAt: null },
                  { startedAt: { $exists: false } },
                ],
              },
              stripeEffectKey('subscription_upgrade', intent.id),
              {
                $set: {
                  planKey: newPlanKey,
                  freeExpressLeft: newPlan.freeExpressPerMonth || 0,
                  startedAt: occurredAt,
                },
              }
            );
          }
        } catch (e) {
          console.error('Subscription upgrade webhook error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      // Opłata prowizji dla zlecenia rozliczanego poza systemem
      if (intent.metadata?.type === 'commission_external') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });

          const providerId = order?.provider?._id || order?.provider;
          const acceptedOfferId = order?.acceptedOfferId?._id || order?.acceptedOfferId;
          const bindingMatches = Boolean(order && payment) &&
            resolvePaymentType(intent, payment) === 'commission_external' &&
            String(payment.order || '') === String(order._id) &&
            String(payment.provider || '') === String(providerId || '') &&
            String(intent.metadata?.providerId || '') === String(providerId || '') &&
            String(intent.metadata?.acceptedOfferId || '') === String(acceptedOfferId || '');
          if (!bindingMatches) {
            throw new Error(`External commission binding mismatch (${intent.id})`);
          }

          const claimedPayment = await claimPaymentSucceededFromWebhook(payment, intent);
          if (!claimedPayment) {
            return res.json({ received: true, ignoredRefundedPayment: true });
          }
          // External flow never activates escrow/protection. The refund status
          // is terminal and wins regardless of webhook delivery ordering.
          await Order.findOneAndUpdate(
            {
              _id: order._id,
              paymentPreference: 'external',
              provider: providerId,
              acceptedOfferId,
              externalCommissionStatus: { $nin: ['refunded', 'partial_refund'] },
            },
            { $set: { externalCommissionStatus: 'succeeded', paidInSystem: false } }
          );
        } catch (e) {
          console.error('External commission webhook handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'contact_unlock') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order && isContactUnlockBindingValid(intent, payment, order)) {
            order.contactUnlockStatus = 'succeeded';
            order.contactUnlockedAt = stripeSourceDate(intent, event);
            await order.save();
          } else {
            throw new Error(`Contact unlock binding mismatch (${intent.id})`);
          }
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }
        } catch (e) {
          console.error('Contact unlock webhook handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'listing_addons') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order) {
            const { pricing: listingPricing } = require('../utils/listingAddons');
            const occurredAt = stripeSourceDate(intent, event);
            const fastTrack = intent.metadata.fastTrack === '1';
            const highlight = intent.metadata.highlight === '1';
            const verifiedProvidersOnly = intent.metadata.verifiedProvidersOnly === '1';
            const listingSet = {
              listingAddonsStatus: 'succeeded',
              listingAddonsPaidAt: occurredAt,
              listingAddonsPaymentIntentId: intent.id,
              ...(fastTrack
                ? { priority: 'priority', priorityFee: 0, priorityDateTime: order.priorityDateTime || occurredAt }
                : {}),
              ...(highlight
                ? {
                    boostFree: false,
                  }
                : {}),
              ...(verifiedProvidersOnly ? { verifiedProvidersOnly: true } : {}),
            };
            await Order.updateOne(
              { _id: order._id, listingAddonsPaymentIntentId: { $ne: intent.id } },
              {
                $set: listingSet,
                ...(highlight
                  ? {
                      $max: {
                        boostedAt: occurredAt,
                        boostedUntil: new Date(
                          occurredAt.getTime() + listingPricing.listHighlightHours * 60 * 60 * 1000
                        ),
                        lastBoostedAt: occurredAt,
                      },
                    }
                  : {}),
                ...(highlight ? { $inc: { boostCount: 1 } } : {}),
              }
            );
            await Revenue.updateOne(
              { stripeSourceId: intent.id, type: 'priority_fee' },
              {
                $setOnInsert: {
                  orderId: order._id,
                  clientId: order.client,
                  type: 'priority_fee',
                  amount: payment?.amount || Math.round(Number(intent.metadata.totalPln || 0) * 100),
                  description: 'Boost widoczności zlecenia (offers_only)',
                  status: 'paid',
                  paidAt: occurredAt,
                  stripeSourceId: intent.id,
                },
              },
              { upsert: true }
            );
          }
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }
        } catch (e) {
          console.error('Listing addons webhook handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      // Obsługa boostów (profile / wyróżnienia)
      if (intent.metadata?.type === 'boost_purchase') {
        try {
          const { fulfillBoostPaymentFromWebhook } = require('../services/boostPurchaseService');
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          await fulfillBoostPaymentFromWebhook(intent, payment);
        } catch (e) {
          console.error('boost_purchase webhook error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'sponsor_ad_payment') {
        try {
          const { fulfillSponsorAdPaymentFromWebhook } = require('../services/sponsorAdPaymentService');
          await fulfillSponsorAdPaymentFromWebhook(intent);
        } catch (e) {
          console.error('sponsor_ad_payment webhook error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'sponsor_ad_renewal') {
        try {
          const { fulfillSponsorAdRenewalFromWebhook } = require('../services/sponsorAdPaymentService');
          const renewed = await fulfillSponsorAdRenewalFromWebhook(intent);
          if (renewed) {
            const SponsorAd = require('../models/SponsorAd');
            const { sendAutoRenewalEmail } = require('../cron/sponsorAdsCron');
            const ad = await SponsorAd.findById(intent.metadata?.adId);
            if (ad) {
              await sendAutoRenewalEmail(ad, ad.campaign?.renewalPeriod || 30);
            }
          }
        } catch (e) {
          console.error('sponsor_ad_renewal webhook error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      // Obsługa promocji
      if (intent.metadata?.type === 'promotion') {
        const planId = intent.metadata.planId;
        const providerId = intent.metadata.providerId;
        const PromotionPurchase = require('../models/promotionPurchase');

        const purchase = await PromotionPurchase.findOne({ stripePaymentIntentId: intent.id });
        const plan = await require('../models/promotionPlan').findById(planId);
        const user = await require('../models/User').findById(providerId);
        const payment = await require('../models/Payment').findOne({ stripePaymentIntentId: intent.id });

        if (!plan || !user || !purchase || !payment) {
          throw new Error(`Promotion payment target missing (${intent.id})`);
        }
        {
          if (
            String(purchase.provider) !== String(providerId) ||
            String(purchase.plan) !== String(planId) ||
            Number(intent.amount_received || intent.amount) < Number(purchase.amount || 0)
          ) {
            throw new Error(`Promotion PaymentIntent binding mismatch (${intent.id})`);
          }
          const claimedPayment = await Payment.findOneAndUpdate(
            {
              _id: payment._id,
              stripePaymentIntentId: intent.id,
              status: { $nin: ['refunded', 'partial_refund'] },
            },
            {
              $set: {
                status: 'succeeded',
                method: intent.payment_method_types?.[0] || payment.method,
              },
            },
            { new: true }
          );
          if (!claimedPayment) {
            // A refund tombstone won the race. Never grant a benefit from this
            // delayed success event.
            return res.json({ received: true });
          }

          const occurredAt = stripeSourceDate(intent, event);
          const prevEnd = purchase.endsAt && purchase.endsAt > occurredAt
            ? purchase.endsAt
            : occurredAt;
          const calculatedEndsAt = new Date(
            prevEnd.getTime() + plan.durationDays * 24 * 60 * 60 * 1000
          );
          const promotionEffectKey = stripeEffectKey('promotion_purchase', intent.id);
          const { reversalKey } = promotionPurchaseEffectKeys(intent.id);

          await applyStripeEffectOnce(
            PromotionPurchase,
            {
              _id: purchase._id,
              status: { $ne: 'refunded' },
              $and: [{ stripeAppliedEffects: { $ne: reversalKey } }],
            },
            promotionEffectKey,
            {
              $set: {
                status: 'active',
                startsAt: purchase.startsAt || occurredAt,
                endsAt: calculatedEndsAt,
              },
            }
          );

          const activePurchase = await PromotionPurchase.findById(purchase._id);
          if (
            !activePurchase ||
            activePurchase.status === 'refunded' ||
            activePurchase.stripeAppliedEffects?.includes(reversalKey)
          ) {
            return res.json({ received: true });
          }
          const endsAt = activePurchase.endsAt || calculatedEndsAt;

          const promoSet = {};
          if (plan.effects?.highlight) promoSet['promo.highlightUntil'] = endsAt;
          if (plan.effects?.topBadge) promoSet['promo.topBadgeUntil'] = endsAt;
          if (plan.effects?.aiBadge) promoSet['promo.aiTopTagUntil'] = endsAt;
          await applyStripeEffectOnce(
            User,
            {
              _id: providerId,
              $and: [{ stripeAppliedEffects: { $ne: reversalKey } }],
            },
            promotionEffectKey,
            {
              $inc: { rankingPoints: plan.rankingPointsAdd || 0 },
              ...(Object.keys(promoSet).length ? { $max: promoSet } : {}),
            }
          );

          // Zaznacz użycie kuponu (jeśli był użyty)
          const appliedCouponId = intent.metadata?.appliedCouponId;
          if (appliedCouponId) {
            await applyStripeEffectOnce(
              Coupon,
              { _id: appliedCouponId },
              stripeEffectKey('promotion_coupon', intent.id),
              { $inc: { used: 1 } }
            );
          }
        }
          // Zakończ obróbkę — nie wpadaj w ścieżkę „order"
        return res.json({ received: true });
      }

      // Obsługa wideo-wizyt
      if (intent.metadata?.type === 'video') {
        const VideoSession = require('../models/VideoSession');
        const providerId = intent.metadata.providerId;
        const clientId = intent.metadata.clientId;
        const orderId = intent.metadata.orderId;

        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            payment.amount = intent.amount;
            payment.currency = intent.currency || payment.currency;
            await payment.save();
          }

          // Aktualizuj sesję wideo (jeśli już istnieje)
          if (payment?.videoSession) {
            const session = await VideoSession.findById(payment.videoSession);
            if (session) {
              session.paid = true;
              session.paymentId = payment._id;
              await session.save();
            }
          }
        } catch (e) {
          console.error('Video payment webhook handling error:', e);
          throw e;
        }

        return res.json({ received: true });
      }
      
      // Obsługa zleceń (istniejąca logika)
      const orderId = intent.metadata?.orderId;
      if (orderId) {
        const order = await Order.findById(orderId);
        const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
        const isMainEscrow = isCanonicalMainEscrowIntent(intent, payment, order);

        const claimedPayment = payment
          ? await claimPaymentSucceededFromWebhook(payment, intent)
          : null;
        if (isMainEscrow && claimedPayment) {
          const hasGuarantee = orderHasPurchasedGuarantee(order);
          const protectionExpiresAt = hasGuarantee
            ? new Date(stripeSourceDate(intent, event).getTime() + GUARANTEE_DAYS*24*60*60*1000)
            : null;
          await Order.findOneAndUpdate(
            {
              _id: order._id,
              paymentId: claimedPayment._id,
              'payment.intentId': intent.id,
              paymentStatus: { $nin: ['refunded', 'partial_refund'] },
            },
            {
              $set: {
                paymentStatus: 'succeeded',
                paidInSystem: true,
                paymentMethod: intent.payment_method_types?.[0] || 'unknown',
                protectionEligible: hasGuarantee,
                protectionStatus: hasGuarantee ? 'active' : 'inactive',
                protectionExpiresAt,
                'payment.status': 'paid',
                'payment.protected': hasGuarantee,
              },
            }
          );
        }
      }
    }

    if (event.type === 'payment_intent.canceled') {
      const intent = event.data.object;
      try {
        const orderId = intent.metadata?.orderId;
        const order = orderId ? await Order.findById(orderId) : null;
        const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });

        // Dokładny Payment może zostać zsynchronizowany dla każdego typu, ale
        // cofnięcie funded jest dozwolone tylko dla aktualnego głównego escrow.
        if (
          payment &&
          !['succeeded', 'refunded', 'partial_refund'].includes(payment.status)
        ) {
          payment.status = 'canceled';
          await payment.save();
        }
        if (applyCanonicalMainCancellation(order, payment, intent)) {
          await order.save();
        }
      } catch (e) {
        console.error('payment_intent.canceled webhook handling error:', e);
        throw e;
      }
      return res.json({ received: true });
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object;
      
      // Obsługa subskrypcji (PI może nie mieć metadata — wtedy Payment z /subscribe)
      {
        const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
        const isSubscriptionFailure =
          intent.metadata?.type === 'subscription' || payment?.metadata?.type === 'subscription';
        if (isSubscriptionFailure) {
          try {
            if (payment && !['succeeded', 'refunded', 'partial_refund'].includes(payment.status)) {
              payment.status = 'failed';
              await payment.save();
              if (payment.stripeSubscriptionId) {
                await UserSubscription.updateOne(
                  { stripeSubscriptionId: payment.stripeSubscriptionId },
                  { $set: { pendingPlanKey: null, pendingBillingPeriod: null } }
                );
              }
            }
          } catch (e) {
            console.error('Subscription payment_failed handling error:', e);
            throw e;
          }
          return res.json({ received: true });
        }
      }

      // Dopłata ma własny stan. Nie wolno przepuszczać jej do ogólnej
      // obsługi błędu, która wyłącza główne escrow i ochronę zlecenia.
      if (intent.metadata?.type === 'additional_payment') {
        await handleAdditionalPaymentFailure(intent);
        return res.json({ received: true });
      }

      // Błąd płatności prowizji dla rozliczenia poza systemem
      if (intent.metadata?.type === 'commission_external') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          const paymentIsSettled = payment &&
            ['succeeded', 'refunded', 'partial_refund'].includes(payment.status);
          if (order && !paymentIsSettled) {
            applyExternalCommissionOrderState(order, 'failed');
            await order.save();
          }
          if (payment && !paymentIsSettled) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('External commission payment_failed handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'contact_unlock') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order && order.contactUnlockStatus !== 'succeeded') {
            order.contactUnlockStatus = 'unpaid';
            await order.save();
          }
          if (payment && !['succeeded', 'refunded', 'partial_refund'].includes(payment.status)) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Contact unlock payment_failed handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'listing_addons') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order && order.listingAddonsStatus === 'processing') {
            order.listingAddonsStatus = 'none';
            await order.save();
          }
          if (payment && !['succeeded', 'refunded', 'partial_refund'].includes(payment.status)) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Listing addons payment_failed handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }
      
      // Obsługa promocji
      if (intent.metadata?.type === 'promotion') {
        const purchase = await require('../models/promotionPurchase').findOne({ stripePaymentIntentId: intent.id });
        if (purchase && !['active', 'refunded'].includes(purchase.status)) {
          purchase.status = 'failed';
          await purchase.save();
        }
        const payment = await require('../models/Payment').findOne({ stripePaymentIntentId: intent.id });
        if (payment && !['succeeded', 'refunded', 'partial_refund'].includes(payment.status)) {
          payment.status = 'failed';
          await payment.save();
        }
        return res.json({ received: true });
      }

      // Obsługa wideo-wizyt
      if (intent.metadata?.type === 'video') {
        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (payment && !['succeeded', 'refunded', 'partial_refund'].includes(payment.status)) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Video payment_failed handling error:', e);
          throw e;
        }
        return res.json({ received: true });
      }
      
      // Obsługa zleceń (istniejąca logika)
      const orderId = intent.metadata?.orderId;
      if (orderId) {
        const order = await Order.findById(orderId);
        const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
        const isMainEscrow = isCanonicalMainEscrowIntent(intent, payment, order);
        const paymentIsSettled = payment &&
          ['succeeded', 'refunded', 'partial_refund'].includes(payment.status);
        if (isMainEscrow && !paymentIsSettled && order.paymentStatus !== 'succeeded') {
          order.paymentStatus = 'failed';
          order.paidInSystem = false;
          order.protectionEligible = false;
          order.protectionStatus = 'inactive';
          order.protectionExpiresAt = null;
          await order.save();
          await Notification.updateOne(
            { dedupeKey: `payment-failed:${intent.id}` },
            {
              $setOnInsert: {
                user: order.client,
                type: 'order_updated',
                title: 'Płatność nieudana',
                message: 'Płatność za zlecenie nie powiodła się. Spróbuj ponownie inną metodą.',
                link: `/orders/${order._id}`,
                dedupeKey: `payment-failed:${intent.id}`,
                metadata: {
                  orderId: String(order._id),
                  paymentIntentId: intent.id,
                },
              },
            },
            { upsert: true }
          );
        }
        if (payment && !paymentIsSettled) {
          payment.status = 'failed';
          await payment.save();
        }
      }
    }

    if (
      event.type === 'charge.refunded' ||
      event.type === 'charge.refund.updated' ||
      event.type === 'refund.updated' ||
      event.type === 'refund.created' ||
      event.type === 'refund.failed'
    ) {
      const normalizedRefund = await normalizeStripeRefundEvent(event, stripe);
      const { charge, refund, chargeId, paymentIntentId: pi } = normalizedRefund;
      const PaymentRefundAudit = require('../models/PaymentRefundAudit');
      const refundObjects = refund
        ? [refund]
        : (Array.isArray(charge.refunds?.data) ? charge.refunds.data : []);
      for (const refundObject of refundObjects) {
        // eslint-disable-next-line no-await-in-loop
        await reconcilePaymentRefundAudit(
          refundObject,
          { chargeId, paymentIntentId: pi },
          PaymentRefundAudit
        );
      }

      const payment = await Payment.findOne({
        $or: [
          ...(pi ? [{ stripePaymentIntentId: pi }] : []),
          { stripeChargeId: chargeId },
        ],
      });
      const amountRefunded = Number(charge.amount_refunded || 0);
      const hasSucceededRefund = amountRefunded > 0 && (
        event.type === 'charge.refunded' ||
        !refund ||
        refund.status === 'succeeded'
      );

      if (payment && amountRefunded > 0) {
        const chargeAmount = Number(charge.amount || payment.amount);
        const refundStatus = amountRefunded < chargeAmount
          ? 'partial_refund'
          : 'refunded';

        // Tombstone the Order-facing state first. Success handlers use a CAS
        // that excludes these states, so no interleaving can leave the Order
        // finally reactivated after this refund event.
        if (payment.order) {
          const order = await Order.findById(payment.order);
          if (order) {
            payment.status = refundStatus;
            applyPaymentRefundToOrder(order, payment, pi);
            await order.save();
          }
        }

        await Payment.findOneAndUpdate(
          { _id: payment._id },
          {
            $set: {
              status: refundStatus,
              stripeChargeId: chargeId,
              ...(pi ? { stripePaymentIntentId: pi } : {}),
            },
            $addToSet: {
              stripeAppliedEffects: stripeEffectKey('refund_observed', pi || chargeId),
            },
          },
          { new: true }
        );
      }

      let promotionPurchaseCompensated = false;
      let manualBenefitReason = null;
      if (hasSucceededRefund && pi) {
        const PromotionPurchase = require('../models/promotionPurchase');
        const purchase = payment?.promotionPurchase
          ? await PromotionPurchase.findById(payment.promotionPurchase)
          : await PromotionPurchase.findOne({ stripePaymentIntentId: pi });
        if (purchase) {
          const plan = await require('../models/promotionPlan').findById(purchase.plan);
          const refundedAt = stripeSourceDate(null, event);
          const reversal = await reversePromotionPurchaseBenefit(
            purchase,
            plan,
            {
              paymentIntentId: pi,
              refundedAt,
            },
            { UserModel: User, PromotionPurchaseModel: PromotionPurchase }
          );
          promotionPurchaseCompensated = reversal.fullyCompensated;
          manualBenefitReason = reversal.manualReason;
        }
      }

      if (
        hasSucceededRefund &&
        (
          (!payment && !promotionPurchaseCompensated) ||
          (requiresManualBenefitRefund(payment) && !promotionPurchaseCompensated)
        )
      ) {
        await logPaymentError({
          errorType: 'refund_failed',
          errorCode: 'UNSUPPORTED_BENEFIT_REFUND',
          errorMessage: 'Stripe refund succeeded, but its benefit requires manual compensation.',
          paymentId: payment?._id || null,
          orderId: payment?.order || null,
          userId: payment?.provider || payment?.client || payment?.subscriptionUser || null,
          stripePaymentIntentId: pi,
          stripeChargeId: chargeId,
          stripeEventId: event.id,
          eventType: event.type,
          eventPayload: refund || charge,
          retryable: false,
          metadata: {
            action: 'manual_benefit_refund_reconciliation',
            paymentPurpose: payment?.purpose || null,
            paymentType: payment?.metadata?.type || payment?.metadata?.subtype || null,
            amountRefunded,
            manualBenefitReason,
          },
        });
      }

    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
    if (webhookLockToken) {
      try {
        await markStripeEventFailed(
          ProcessedStripeEvent,
          event.id,
          webhookLockToken,
          e
        );
      } catch (lockError) {
        console.error('Failed to mark Stripe event as failed:', lockError);
      }
      webhookLockToken = null;
    }
    await logPaymentError({
      errorType: 'other',
      errorMessage: e.message,
      errorStack: e.stack,
      stripeEventId: event?.id,
      eventType: event?.type,
      eventPayload: event?.data?.object || {},
      retryable: true,
      metadata: { action: 'webhook_handler' }
    });
    res.status(500).send('Webhook handler error');
  }
});

// POST /api/payments/refund – tylko admin
router.post('/refund', authMiddleware, requireRole(['admin', 'superadmin']), async (req, res) => {
  let auditKey = null;
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe nie jest skonfigurowany' });
    }

    const { paymentId, amount } = req.body || {}; // amount w groszach (brak = cały pozostały zwrot)
    const payment = await Payment.findById(paymentId);
    if (!payment || !payment.stripePaymentIntentId) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    if (requiresManualBenefitRefund(payment)) {
      return res.status(409).json({
        code: 'UNSUPPORTED_BENEFIT_REFUND',
        message: 'Ta płatność przyznała benefit, którego nie można jeszcze bezpiecznie cofnąć automatycznie. Wykonaj kontrolowaną korektę benefitu przed zwrotem.',
      });
    }

    const pi = await stripe.paymentIntents.retrieve(
      payment.stripePaymentIntentId,
      { expand: ['latest_charge'] }
    );
    let charge = typeof pi.latest_charge === 'object'
      ? pi.latest_charge
      : pi.charges?.data?.[0];
    const chargeId = typeof pi.latest_charge === 'string'
      ? pi.latest_charge
      : charge?.id;
    if (!chargeId) return res.status(400).json({ message: 'No charge to refund' });
    if (!charge || typeof charge !== 'object') {
      charge = await stripe.charges.retrieve(chargeId);
    }

    const refundableAmount = Number(charge.amount || 0) - Number(charge.amount_refunded || 0);
    const refundRequest = resolveRefundRequest(amount, refundableAmount);
    if (!refundRequest.ok) {
      const status = refundRequest.code === 'NOTHING_TO_REFUND' ? 409 : 400;
      return res.status(status).json({
        code: refundRequest.code,
        message: refundRequest.code === 'REFUND_EXCEEDS_AVAILABLE'
          ? `Maksymalna kwota zwrotu to ${refundableAmount} gr.`
          : refundRequest.code === 'NOTHING_TO_REFUND'
            ? 'Ta płatność została już zwrócona w całości.'
            : 'Kwota zwrotu musi być dodatnią liczbą całkowitą w groszach.',
      });
    }

    const requestKey = String(req.headers['idempotency-key'] || '').trim();
    if (requestKey && !/^[A-Za-z0-9._:-]{8,160}$/.test(requestKey)) {
      return res.status(400).json({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Nieprawidłowy klucz idempotencji zwrotu.',
      });
    }
    auditKey = `payment:${payment._id}:${
      requestKey || (refundRequest.fullRefund ? 'full' : refundRequest.amount)
    }`.slice(0, 180);
    const stripeIdempotencyKey = `admin-refund:${auditKey}`.slice(0, 255);
    const isDestinationCharge = Boolean(pi.transfer_data?.destination || charge.transfer);
    const PaymentRefundAudit = require('../models/PaymentRefundAudit');
    const auditBinding = {
      payment: payment._id,
      requestedBy: req.user._id,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      stripeChargeId: chargeId,
      amount: refundRequest.amount,
      fullRefund: refundRequest.fullRefund,
    };
    const refundAudit = await PaymentRefundAudit.findOneAndUpdate(
      { idempotencyKey: auditKey },
      {
        $setOnInsert: {
          idempotencyKey: auditKey,
          ...auditBinding,
          refundableBefore: refundableAmount,
          reverseTransfer: isDestinationCharge,
          refundApplicationFee: isDestinationCharge,
          status: 'pending',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (!refundAuditMatchesRequest(refundAudit, auditBinding)) {
      return res.status(409).json({
        code: 'REFUND_IDEMPOTENCY_CONFLICT',
        message: 'Ten klucz idempotencji został już użyty dla innego zwrotu.',
        auditKey,
      });
    }

    const refund = await stripe.refunds.create(
      {
        charge: chargeId,
        amount: refundRequest.amount,
        ...(isDestinationCharge
          ? { reverse_transfer: true, refund_application_fee: true }
          : {}),
        metadata: {
          paymentId: String(payment._id),
          requestedBy: String(req.user._id),
          auditKey,
        },
      },
      { idempotencyKey: stripeIdempotencyKey }
    );

    const refundResult = classifyStripeRefundResult(refund);
    const confirmedRefundAmount = Number(refund.amount);
    if (
      !Number.isSafeInteger(confirmedRefundAmount) ||
      confirmedRefundAmount <= 0 ||
      confirmedRefundAmount !== refundRequest.amount ||
      stripeObjectId(refund.charge) !== chargeId
    ) {
      const error = new Error('Stripe refund response does not match the audited request');
      error.code = 'REFUND_RESPONSE_BINDING_MISMATCH';
      throw error;
    }
    if (refundResult.materializePayment) {
      const paymentStatus = confirmedRefundAmount === refundableAmount
        ? 'refunded'
        : 'partial_refund';
      await Payment.updateOne(
        {
          _id: payment._id,
          stripePaymentIntentId: payment.stripePaymentIntentId,
          ...(paymentStatus === 'partial_refund'
            ? { status: { $ne: 'refunded' } }
            : {}),
        },
        {
          $set: {
            status: paymentStatus,
            stripeChargeId: chargeId,
          },
        }
      );
    }
    await reconcilePaymentRefundAudit(
      refund,
      { chargeId, paymentIntentId: payment.stripePaymentIntentId },
      PaymentRefundAudit
    );

    const responseBody = {
      refund,
      status: refundResult.auditStatus,
      pending: refundResult.pending,
      fullRefund: confirmedRefundAmount === refundableAmount,
      amount: confirmedRefundAmount,
      refundableRemaining: refundResult.materializePayment
        ? refundableAmount - confirmedRefundAmount
        : refundableAmount,
      auditKey,
    };
    if (refundResult.failed) {
      return res.status(refundResult.httpStatus).json({
        ...responseBody,
        message: refund.failure_reason || 'Stripe odrzucił zwrot.',
      });
    }
    return res.status(refundResult.httpStatus).json(responseBody);
  } catch (e) {
    console.error(e);
    if (auditKey) {
      try {
        const PaymentRefundAudit = require('../models/PaymentRefundAudit');
        await recordAmbiguousRefundError(PaymentRefundAudit, auditKey, e);
      } catch (auditError) {
        console.error('Refund audit update failed:', auditError);
      }
    }
    res.status(500).json({
      message: 'Nie udało się jednoznacznie potwierdzić zwrotu. Ponów żądanie z tym samym kluczem idempotencji.',
      retryable: true,
      auditKey,
    });
  }
});

module.exports = router;
module.exports.syncOrderPaymentFromStripe = syncOrderPaymentFromStripe;
module.exports.__test = {
  acquireStripeEventLock,
  markStripeEventProcessed,
  markStripeEventFailed,
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
  assertCheckoutPaymentBinding,
  upsertCheckoutPaymentBinding,
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
};
