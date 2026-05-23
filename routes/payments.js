const express = require('express');
const router = express.Router();
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

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:5173';

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

function resolveFrontendUrl(req) {
  const envUrl = normalizeUrl(process.env.FRONTEND_URL || process.env.APP_URL || '');
  if (envUrl) return envUrl;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return 'http://localhost:5173';
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
async function createPaymentIntentPreferLocalWallets(stripe, basePayload) {
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
  for (const body of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await stripe.paymentIntents.create(body);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const PI_OK_FOR_CLIENT = new Set(['requires_capture', 'succeeded', 'processing']);
const PI_REUSABLE = new Set(['requires_payment_method', 'requires_confirmation']);

async function scanOrderStripeIntents(orderId) {
  if (!stripe || !orderId) return [];
  const payments = await Payment.find({ order: orderId }).sort({ createdAt: -1 }).limit(20);
  const out = [];
  for (const payment of payments) {
    if (!payment.stripePaymentIntentId) continue;
    try {
      const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      out.push({ payment, intent });
    } catch (err) {
      console.warn('scanOrderStripeIntents retrieve:', payment.stripePaymentIntentId, err.message);
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
  if (order.status === 'funded') return order;
  if (order.status !== 'accepted') return order;

  order.status = 'funded';
  order.paymentStatus = intent.status === 'succeeded' ? 'succeeded' : 'processing';
  order.payment = order.payment || {};
  order.payment.intentId = intent.id;
  if (paymentDoc) {
    order.paymentId = paymentDoc._id;
    paymentDoc.status = paymentIntentStatusForPaymentModel(intent.status);
    await paymentDoc.save();
  }
  await order.save();
  return order;
}

/** Szuka opłaconej autoryzacji Stripe i ustawia zlecenie na funded (naprawa po błędnym UI). */
async function syncOrderPaymentFromStripe(orderId) {
  if (!stripe || !orderId) return { paid: false };
  const scanned = await scanOrderStripeIntents(orderId);
  const authorized = scanned.find(
    (row) => row.intent.status === 'requires_capture' || row.intent.status === 'succeeded'
  );
  if (!authorized) return { paid: false };
  const duplicatesCanceled = await cancelDuplicateCapturableIntents(orderId, authorized.intent.id);
  let order = await Order.findById(orderId);
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

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const orderId = orderIdBody || intent.metadata?.orderId;

    if (orderId) {
      const order = await Order.findById(orderId);
      if (!order) {
        return res.status(404).json({ success: false, message: 'Nie znaleziono zlecenia' });
      }
      const clientId = order.client?._id || order.client;
      if (String(clientId) !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'Brak dostępu do tego zlecenia' });
      }
    }

    if (!PI_OK_FOR_CLIENT.has(intent.status)) {
      return res.json({
        success: false,
        status: intent.status,
        message: intent.last_payment_error?.message || 'Płatność nie została zakończona',
      });
    }

    let duplicatesCanceled = 0;
    if (orderId) {
      duplicatesCanceled = await cancelDuplicateCapturableIntents(orderId, paymentIntentId);
      const order = await Order.findById(orderId);
      const paymentDoc = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
      await applyOrderFundedFromStripeIntent(order, intent, paymentDoc);
    }

    return res.json({
      success: true,
      status: intent.status,
      orderId: orderId || null,
      duplicatesCanceled,
      message:
        intent.status === 'requires_capture'
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

    const existingIntents = await scanOrderStripeIntents(order._id);
    const alreadyAuthorized = existingIntents.find((row) =>
      row.intent.status === 'requires_capture' || row.intent.status === 'succeeded'
    );
    if (alreadyAuthorized) {
      return res.status(409).json({
        message: 'Płatność za to zlecenie została już przyjęta. Odśwież stronę zlecenia.',
        alreadyPaid: true,
        paymentIntentId: alreadyAuthorized.intent.id,
      });
    }

    const reusableIntent = existingIntents.find(
      (row) => PI_REUSABLE.has(row.intent.status) && row.intent.client_secret
    );
    if (reusableIntent) {
      return res.json({
        clientSecret: reusableIntent.intent.client_secret,
        paymentIntentId: reusableIntent.intent.id,
        reused: true,
      });
    }

    for (const { payment, intent } of existingIntents) {
      if (!PI_REUSABLE.has(intent.status)) continue;
      try {
        await stripe.paymentIntents.cancel(intent.id);
        payment.status = 'canceled';
        await payment.save();
      } catch (cancelErr) {
        console.warn('create-intent cancel stale PI:', intent.id, cancelErr.message);
      }
    }

    // Klient może zaznaczyć „Chcę fakturę VAT” przy płatności – zapisz w zleceniu
    if (typeof requestInvoice === 'boolean') {
      order.requestInvoice = requestInvoice;
    }

  // Kwota w groszach: schema Order.amountTotal = grosze; po akceptacji oferty często było tylko pricing.total (PLN)
  let amount = order.amountTotal;
  if (!amount || amount <= 0) {
    const totalPln = order.pricing?.total;
    if (totalPln != null && Number(totalPln) > 0) {
      amount = Math.round(Number(totalPln) * 100);
    }
  }

  let platformFeeAmount = order.platformFeeAmount;
  if (!platformFeeAmount || platformFeeAmount <= 0) {
    const pfPln = order.pricing?.platformFee;
    if (pfPln != null && Number(pfPln) >= 0) {
      platformFeeAmount = Math.round(Number(pfPln) * 100);
    } else {
      const basePln = order.pricing?.baseAmount;
      const pct = order.platformFeePercent != null ? Number(order.platformFeePercent) : PLATFORM_FEE_PERCENT;
      if (basePln != null && Number(basePln) > 0) {
        platformFeeAmount = Math.round(Number(basePln) * 100 * pct);
      } else {
        platformFeeAmount = 0;
      }
    }
  }

  const pointsDiscount = order.pricing?.discountPoints || 0;

  const providerId = order.provider?._id || order.provider;
  const providerForConnect = providerId
    ? await User.findById(providerId)
        .select('stripeAccountId stripeConnectStatus name')
        .lean()
    : null;

  const paysThroughHelpfli =
    order.paymentPreference === 'system' || order.paymentPreference === 'both';

  if (ENABLE_STRIPE_CONNECT && paysThroughHelpfli) {
    if (!providerForConnect?.stripeAccountId || !providerForConnect.stripeConnectStatus?.payoutsEnabled) {
      return res.status(400).json({
        message:
          'Ten wykonawca nie ma jeszcze aktywowanych wypłat Stripe. Wybierz płatność poza systemem albo poproś wykonawcę o dokończenie onboardingu Stripe.',
      });
    }
  }

  if (!amount || amount < 50) {
    return res.status(400).json({
      message:
        'Brak poprawnej kwoty do zapłaty. Odśwież stronę zlecenia lub skontaktuj się z pomocą.',
    });
  }

  // Jeżeli Stripe Connect jest włączony i provider ma konto – użyj destination charges
  // WAŻNE: Jeśli klient użył punktów, musimy zwiększyć amount w Stripe o pointsDiscount,
  // żeby provider otrzymał pełną kwotę. Platforma pokrywa różnicę jako koszt marketingowy.
  const stripeAmount = pointsDiscount > 0 ? amount + pointsDiscount : amount;
  
  let intentPayload = {
    amount: stripeAmount, // Kwota w Stripe = kwota którą płaci klient + zniżka z punktów (pokrywana przez platformę)
    currency: CURRENCY,
    // Pełny escrow – najpierw autoryzacja, później capture po potwierdzeniu zakończenia zlecenia
    capture_method: 'manual',
    description: `Helpfli Order #${order._id}`,
    metadata: {
      orderId: String(order._id),
        clientId: String(clientId),
      providerId: String(providerId || ''),
      platformFeeAmount: String(platformFeeAmount),
      pointsDiscount: String(pointsDiscount),
      clientPaidAmount: String(amount), // Rzeczywista kwota którą zapłacił klient
    },
    statement_descriptor_suffix: 'HELPFLI',
  };

  if (
    ENABLE_STRIPE_CONNECT &&
    paysThroughHelpfli &&
    providerForConnect?.stripeAccountId
  ) {
    intentPayload = {
      ...intentPayload,
      application_fee_amount: Math.min(platformFeeAmount, stripeAmount),
      transfer_data: {
        destination: providerForConnect.stripeAccountId,
      },
    };
  }

  const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload);

    // Zapis w Payment (status wstępny)
    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const foundingFields = buildFoundingPaymentFields(order, platformFeeAmount);

    const payment = await Payment.create({
      order: order._id,
      provider: providerId || null,
      client: clientId,
      providerName: providerForConnect?.name || '',
      clientName,
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: methodHint,
      status: paymentIntentStatusForPaymentModel(intent.status),
      platformFeePercent: order.platformFeePercent || PLATFORM_FEE_PERCENT,
      platformFeeAmount: platformFeeAmount, // PlatformFee obliczane od baseAmount (przed zniżkami z punktów)
      ...foundingFields,
      pointsDiscount: pointsDiscount || 0, // Zniżka z punktów pokrywana przez platformę jako koszt marketingowy
      metadata: {
        ...intent.metadata,
        stripeAmount: stripeAmount, // Kwota w Stripe (amount + pointsDiscount) - dla rozliczeń
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
    if (order.additionalPaymentStatus === 'processing') {
      return res.status(400).json({ message: 'Dopłata jest już w trakcie płatności. Dokończ lub odśwież status.' });
    }

    const amount = Math.round(additionalAmountPln * 100);

    const providerId = order.provider?._id || order.provider;
    const providerForConnect = providerId
      ? await User.findById(providerId)
          .select('stripeAccountId stripeConnectStatus name')
          .lean()
      : null;
    const paysThroughHelpfli =
      order.paymentPreference === 'system' || order.paymentPreference === 'both';
    const platformFeeAmount = Math.round(amount * (order.platformFeePercent || PLATFORM_FEE_PERCENT));

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
        additionalAmount: String(amount),
      },
      statement_descriptor_suffix: 'HELPFLI',
    };

    if (
      ENABLE_STRIPE_CONNECT &&
      paysThroughHelpfli &&
      providerForConnect?.stripeAccountId &&
      providerForConnect?.stripeConnectStatus?.payoutsEnabled
    ) {
      intentPayload = {
        ...intentPayload,
        application_fee_amount: Math.min(platformFeeAmount, amount),
        transfer_data: {
          destination: providerForConnect.stripeAccountId,
        },
      };
    }

    const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload);

    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const payment = await Payment.create({
      order: order._id,
      provider: providerId || null,
      client: clientId,
      providerName: providerForConnect?.name || '',
      clientName,
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: methodHint,
      status: paymentIntentStatusForPaymentModel(intent.status),
      platformFeePercent: order.platformFeePercent || PLATFORM_FEE_PERCENT,
      platformFeeAmount,
      pointsDiscount: 0,
      ...buildFoundingPaymentFields(order, platformFeeAmount),
      metadata: {
        ...intent.metadata,
        subtype: 'additional_payment',
      },
    });

    order.additionalPaymentStatus = 'processing';
    order.payment = order.payment || {};
    order.payment.additionalIntentId = intent.id;
    order.payment.additionalPaymentId = payment._id;
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

    if (order.contactUnlockStatus === 'processing') {
      return res.status(400).json({ message: 'Płatność za kontakt jest w trakcie realizacji' });
    }

    const nominalGrosze = Math.round(feePln * 100);
    const STRIPE_MIN_PLN_GROSZE = 200;
    const amount = Math.max(nominalGrosze, STRIPE_MIN_PLN_GROSZE);

    const intentPayload = {
      amount,
      currency: CURRENCY,
      capture_method: 'automatic',
      description: `Odblokowanie kontaktu — zlecenie #${order._id}`,
      metadata: {
        orderId: String(order._id),
        clientId: String(clientId),
        type: 'contact_unlock',
        contactUnlockFeePln: String(feePln),
      },
      statement_descriptor_suffix: 'HELPFLI',
    };

    const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload);
    const allowedMethods = ['card', 'p24', 'blik', 'unknown'];
    const payMethod = allowedMethods.includes(methodHint) ? methodHint : 'card';

    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const payment = await Payment.create({
      order: order._id,
      provider: order.provider || null,
      client: clientId,
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: payMethod,
      status: paymentIntentStatusForPaymentModel(intent.status),
      platformFeePercent: 1,
      platformFeeAmount: amount,
      ...buildFoundingPaymentFields(order, amount),
      metadata: { type: 'contact_unlock', contactUnlockFeePln: feePln },
    });

    order.contactUnlockStatus = 'processing';
    order.contactUnlockFeePln = feePln;
    order.paymentId = payment._id;
    await order.save();

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      contactUnlockFeePln: feePln,
      chargedAmountPln: amount / 100,
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

    const intentPayload = {
      amount,
      currency: CURRENCY,
      capture_method: 'automatic',
      description: `Opłata serwisowa Helpfli za zlecenie #${order._id}`,
      metadata: {
        orderId: String(order._id),
        clientId: String(clientId),
        type: 'commission_external',
        commissionNominalPln: String(platformFeePln),
        commissionAmountPln: String(platformFeePln),
        stripeChargedPln: String((amount / 100).toFixed(2)),
      },
      statement_descriptor_suffix: 'HELPFLI',
    };

    const intent = await createPaymentIntentPreferLocalWallets(stripe, intentPayload);

    const allowedMethods = ['card', 'p24', 'blik', 'unknown'];
    const payMethod = allowedMethods.includes(methodHint) ? methodHint : 'card';

    const { buildFoundingPaymentFields } = require('../utils/foundingProvider');
    const payment = await Payment.create({
      order: order._id,
      provider: null,
      client: clientId,
      providerName: '',
      clientName,
      stripePaymentIntentId: intent.id,
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

    order.paymentId = payment._id;
    order.currency = CURRENCY;
    order.platformFeeAmount = amount;
    order.paymentProvider = 'stripe';
    order.externalCommissionStatus = 'processing';
    order.paidInSystem = false;
    order.payment = order.payment || {};
    order.payment.intentId = intent.id;
    order.payment.status = orderPaymentSubStatusFromStripePi(payment.status);
    order.payment.method = payMethod;
    await order.save();

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      nominalPlatformFeePln: platformFeePln,
      chargedAmountPln: amount / 100,
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
  try {
    const { paymentIntentId } = req.body;
    
    if (!paymentIntentId) {
      return res.status(400).json({ message: 'PaymentIntent ID jest wymagany' });
    }

    // Znajdź płatność w bazie
    const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
    if (!payment) {
      return res.status(404).json({ message: 'Nie znaleziono płatności' });
    }

    // Sprawdź czy użytkownik ma uprawnienia
    if (String(payment.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Brak uprawnień do tej płatności' });
    }

    // Capture PaymentIntent w Stripe
    const intent = await stripe.paymentIntents.capture(paymentIntentId);

    if (intent.status === 'succeeded') {
      // Aktualizuj status w bazie
      payment.status = 'succeeded';
      await payment.save();

      // Aktualizuj zlecenie
      const order = await Order.findById(payment.order);
      if (order) {
        order.paymentStatus = 'succeeded';
        order.paidInSystem = true;
        order.protectionEligible = true;
        order.protectionStatus = 'active';
        order.protectionExpiresAt = new Date(Date.now() + 30*24*60*60*1000); // 30 dni
        await order.save();

        // Wystaw fakturę dla klienta zgodnie z przepisami VAT
        try {
          const client = await User.findById(order.client);
          if (client) {
            const customerType = client.billing?.customerType || 'individual';
            const invoiceMode = client.billing?.invoiceMode || 'per_order';
            const wantInvoice = client.billing?.wantInvoice || false;
            const requestInvoice = order.requestInvoice || false; // Klient prosił o fakturę przy płatności

            // Zgodnie z przepisami VAT:
            // 1. Dla firm (B2B) - faktura jest WYMAGANA zawsze
            // 2. Dla osób fizycznych - faktura tylko na żądanie (wantInvoice === true LUB requestInvoice === true)
            // 3. Tryb miesięczny - nie wystawiamy od razu, tylko zapisujemy do późniejszego wystawienia
            const shouldIssueInvoiceNow = 
              customerType === 'company' || // Firma - zawsze wymagana
              (customerType === 'individual' && (wantInvoice || requestInvoice) && invoiceMode === 'per_order'); // Osoba fizyczna - jeśli chce (ustawienia LUB przy płatności) i tryb per_order

            if (shouldIssueInvoiceNow) {
              // Walidacja dla firm B2B - NIP jest wymagany i musi być poprawny
              if (customerType === 'company') {
                if (!client.billing?.nip) {
                  console.warn(`[Payment] Firma ${client.email} nie ma NIP - faktura nie została wystawiona. NIP jest wymagany dla faktur B2B.`);
                  // Nie przerywamy płatności, ale logujemy ostrzeżenie
                } else {
                  const nipValidation = validateNIP(client.billing.nip);
                  if (!nipValidation.valid) {
                    console.warn(`[Payment] Firma ${client.email} ma nieprawidłowy NIP (${client.billing.nip}): ${nipValidation.error} - faktura nie została wystawiona.`);
                    // Nie przerywamy płatności, ale logujemy ostrzeżenie
                  } else {
                    // NIP jest poprawny - wystawiamy fakturę
                    await createInvoiceForOrder(client, order, payment, customerType, invoiceMode);
                  }
                }
              } else {
                // Osoba fizyczna - wystawiamy fakturę bez walidacji NIP
                await createInvoiceForOrder(client, order, payment, customerType, invoiceMode);
              }
            } else {
              // Nie wystawiamy faktury teraz (tryb miesięczny lub osoba fizyczna bez zgody)
              console.log(`[Payment] Faktura nie została wystawiona dla ${client.email}: customerType=${customerType}, wantInvoice=${wantInvoice}, invoiceMode=${invoiceMode}`);
            }
          }
        } catch (invoiceError) {
          console.error('Błąd podczas wystawiania faktury:', invoiceError);
          // Nie przerywamy płatności nawet jeśli faktura się nie udała
        }

        try {
          await Revenue.updateMany(
            { orderId: order._id, status: 'pending' },
            { $set: { status: 'paid', paidAt: new Date() } }
          );
        } catch (revErr) {
          console.error('Revenue update after capture:', revErr);
        }
        try {
          await NotificationService.notifyOrderFunded(order._id);
        } catch (error) {
          console.error('Notification error:', error);
        }
      }
    } else {
      return res.status(400).json({ message: 'Nie można sfinalizować płatności w tym statusie' });
    }

    res.json({ success: true, payment });
  } catch (error) {
    console.error('Błąd capture payment:', error);
    await logPaymentError({
      errorType: 'CAPTURE_ERROR',
      errorMessage: error.message,
      errorStack: error.stack,
      paymentId: payment?._id,
      orderId: payment?.order,
      userId: req.user?._id
    });
    res.status(500).json({ message: 'Błąd podczas finalizacji płatności', error: error.message });
  }
});

// STRIPE WEBHOOK
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

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
            const now = new Date();
            const validUntil = new Date(subscription.current_period_end * 1000); // Stripe używa Unix timestamp
            
            let sub = await UserSubscription.findOne({ 
              $or: [
                { user: userId },
                { stripeSubscriptionId: subscription.id }
              ]
            });
            
            if (sub) {
              sub.planKey = planKey;
              sub.startedAt = new Date(subscription.current_period_start * 1000);
              sub.validUntil = validUntil;
              sub.renews = subscription.status === 'active' || subscription.status === 'trialing';
              sub.freeExpressLeft = plan.freeExpressPerMonth || 0;
              sub.stripeSubscriptionId = subscription.id;
              sub.stripeCustomerId = subscription.customer;
              sub.paymentRetryCount = 0; // Reset retry count po udanej płatności
              await sub.save();
            } else {
              sub = await UserSubscription.create({
                user: userId,
                planKey: planKey,
                startedAt: new Date(subscription.current_period_start * 1000),
                validUntil: validUntil,
                renews: subscription.status === 'active' || subscription.status === 'trialing',
                freeExpressLeft: plan.freeExpressPerMonth || 0,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: subscription.customer
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
      }
      
      return res.json({ received: true });
    }
    
    // Obsługa invoice.payment_failed - failed payment retry
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      
      try {
        const UserSubscription = require('../models/UserSubscription');
        const subscription = await UserSubscription.findOne({ stripeSubscriptionId: subscriptionId });
        
        if (subscription) {
          subscription.paymentRetryCount = (subscription.paymentRetryCount || 0) + 1;
          subscription.lastPaymentAttempt = new Date();
          
          // Stripe automatycznie retry'uje płatności (3 próby w ciągu 7 dni)
          // Ustawiamy nextRetryAt na podstawie Stripe retry schedule
          const retrySchedule = [1, 3, 5]; // dni od failed payment
          const retryDay = retrySchedule[Math.min(subscription.paymentRetryCount - 1, 2)] || 7;
          const nextRetry = new Date();
          nextRetry.setDate(nextRetry.getDate() + retryDay);
          subscription.nextRetryAt = nextRetry;
          
          await subscription.save();
          
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
                        ⚠️ Stripe automatycznie ponowi próbę płatności (${subscription.paymentRetryCount}/3).
                      </p>
                    </div>
                    
                    <h2 style="color: #667eea; margin-top: 30px;">Co możesz zrobić:</h2>
                    <ul style="line-height: 1.8;">
                      <li>✅ Zaktualizuj metodę płatności - to najszybsze rozwiązanie</li>
                      <li>✅ Sprawdź czy karta nie wygasła</li>
                      <li>✅ Upewnij się że masz wystarczające środki</li>
                    </ul>
                    
                    <div style="text-align: center; margin: 30px 0;">
                      <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/account/subscriptions?updatePayment=true" 
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
      }
      
      return res.json({ received: true });
    }
    
    // Obsługa invoice.payment_succeeded - udana płatność subskrypcji
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      
      try {
        const UserSubscription = require('../models/UserSubscription');
        const Payment = require('../models/Payment');
        const subscription = await UserSubscription.findOne({ stripeSubscriptionId: subscriptionId });
        
        if (subscription) {
          const User = require('../models/User');
          const SubscriptionPlan = require('../models/SubscriptionPlan');
          const { calculatePerformanceDiscount } = require('../utils/performancePricing');
          
          const user = await User.findById(subscription.user);
          
          // Sprawdź czy to provider i czy kwalifikuje się do performance discount
          let performanceDiscount = 0;
          let performanceDiscountOrders = 0;
          let performanceDiscountTier = 'none';
          
          if (user && user.role === 'provider') {
            const perfDiscount = await calculatePerformanceDiscount(subscription.user);
            performanceDiscount = perfDiscount.discountPercent;
            performanceDiscountOrders = perfDiscount.ordersCompleted;
            performanceDiscountTier = perfDiscount.tier;
            
            // Jeśli provider osiągnął cele - zastosuj zniżkę na następny okres
            if (performanceDiscount > 0) {
              // Zaktualizuj subscription z performance discount
              subscription.performanceDiscount = performanceDiscount;
              subscription.performanceDiscountOrders = performanceDiscountOrders;
              subscription.performanceDiscountTier = performanceDiscountTier;
              
              // Jeśli subskrypcja się odnawia - zastosuj zniżkę w Stripe
              const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
              const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
              
              if (plan && stripeSub.status === 'active') {
                // Oblicz nową cenę z performance discount
                const basePrice = plan.priceMonthly || 0;
                const discountedPrice = Math.round(basePrice * (1 - performanceDiscount / 100) * 100);
                
                // Utwórz nowy Price w Stripe z zniżką
                const priceData = {
                  unit_amount: discountedPrice,
                  currency: 'pln',
                  recurring: {
                    interval: 'month',
                    interval_count: 1
                  },
                  product_data: {
                    name: `${plan.name} - Performance Discount ${performanceDiscount}%`,
                  },
                  metadata: {
                    planKey: plan.key,
                    performanceDiscount: String(performanceDiscount),
                    discountNote: `Zniżka za ${performanceDiscountOrders} zleceń (poprz. miesiąc)`.slice(0, 450),
                  }
                };
                
                const stripePrice = await stripe.prices.create(priceData);
                
                // Update subscription w Stripe z nową ceną
                await stripe.subscriptions.update(subscriptionId, {
                  items: [{
                    id: stripeSub.items.data[0].id,
                    price: stripePrice.id
                  }],
                  proration_behavior: 'none', // Bez proracji - zmiana na następny okres
                  metadata: {
                    ...stripeSub.metadata,
                    performanceDiscount: String(performanceDiscount),
                    performanceDiscountOrders: String(performanceDiscountOrders)
                  }
                });
                
                subscription.stripePriceId = stripePrice.id;
              }
            }
          }
          
          // Pobierz aktualną subskrypcję z Stripe żeby zaktualizować validUntil
          const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
          const plan = await SubscriptionPlan.findOne({ key: subscription.planKey });
          
          // Aktualizuj validUntil na podstawie Stripe subscription
          subscription.validUntil = new Date(stripeSub.current_period_end * 1000);
          subscription.startedAt = new Date(stripeSub.current_period_start * 1000);
          
          // Reset freeExpressLeft na początku nowego okresu
          if (plan) {
            subscription.freeExpressLeft = plan.freeExpressPerMonth || 0;
          }
          
          // Reset retry count po udanej płatności
          subscription.paymentRetryCount = 0;
          subscription.nextRetryAt = null;
          subscription.lastPaymentAttempt = null;
          await subscription.save();
          
          // Zapisz Payment record
          await Payment.create({
            purpose: 'subscription',
            subscriptionUser: subscription.user,
            subscriptionPlanKey: subscription.planKey,
            amount: invoice.amount_paid,
            currency: invoice.currency,
            status: 'succeeded',
            stripeSubscriptionId: subscriptionId,
            stripeCustomerId: invoice.customer,
            stripeInvoiceId: invoice.id,
            stripeChargeId: invoice.charge,
            metadata: {
              type: 'subscription_renewal',
              invoiceId: invoice.id,
              performanceDiscount: performanceDiscount > 0 ? String(performanceDiscount) : null
            }
          });
        }
      } catch (e) {
        console.error('Invoice payment succeeded webhook handling error:', e);
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
          sub.renews = false;
          sub.cancelledAt = new Date();
          await sub.save();
        }
      } catch (e) {
        console.error('Subscription deleted webhook handling error:', e);
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
          const rec = await Promotion.findOne({ stripeCheckoutSessionId: session.id });
          if (rec) {
            const cfg = PLAN_CFG[rec.plan];
            if (cfg) {
              const now = new Date();
              const to = new Date(now.getTime() + cfg.days * 24 * 60 * 60 * 1000);
              rec.status = 'active';
              rec.activeFrom = now;
              rec.activeTo = to;
              rec.pointsGranted = cfg.points;
              await rec.save();

              const u = await User.findById(rec.user);
              if (u) {
                u.rankingPoints = (u.rankingPoints || 0) + cfg.points;
                u.badges = u.badges || {};
                u.badges.topUntil = to;
                await u.save();
              }
            }
          }
          return res.json({ received: true });
        }

        // PRO badge (/api/pro/checkout)
        if (paid && md.type === 'pro' && md.userId) {
          const ProSubscription = require('../models/proSubscription');
          let periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
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
            pending.status = 'active';
            pending.stripeSubscriptionId = subId || pending.stripeSubscriptionId;
            pending.currentPeriodEnd = periodEnd;
            await pending.save();
          } else {
            await ProSubscription.create({
              user: md.userId,
              tier: md.tier === 'PRO_YEARLY' ? 'PRO_YEARLY' : 'PRO_MONTHLY',
              status: 'active',
              stripeSubscriptionId: subId,
              currentPeriodEnd: periodEnd,
            });
          }
          await User.findByIdAndUpdate(md.userId, { $set: { 'badges.pro': true } });
          return res.json({ received: true });
        }

        // Pakiety wyróżnień providera (/api/promo/checkout — metadata.productKey)
        if (paid && md.productKey && md.userId) {
          const { activatePromo } = require('./promo');
          await activatePromo(md.userId, md.productKey);
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
          const SponsorCampaign = require('../models/SponsorCampaign');
          const positions = String(md.positions || '2,7')
            .split(',')
            .map((x) => Number(String(x).trim()))
            .filter((n) => !Number.isNaN(n) && n > 0);
          await SponsorCampaign.create({
            provider: md.userId,
            service: md.service || '*',
            positions: positions.length ? positions : [2, 7],
            startAt: new Date(md.startAt),
            endAt: new Date(md.endAt),
            dailyCap: 1,
            isActive: true,
          });
          return res.json({ received: true });
        }

        // Zamówienie opłacone Checkoutem (wymaga zapisania stripeCheckoutSessionId przy tworzeniu sesji)
        if (paid && md.type === 'order') {
          const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
          if (payment) {
            payment.status = 'succeeded';
            const piRef = session.payment_intent;
            const piId = typeof piRef === 'string' ? piRef : piRef?.id;
            if (piId) payment.stripePaymentIntentId = payment.stripePaymentIntentId || piId;
            const pm0 = session.payment_method_types?.[0];
            if (pm0 && ['card', 'p24', 'blik'].includes(pm0)) payment.method = pm0;
            await payment.save();

            const order = await Order.findById(payment.order);
            if (order) {
              order.payment = {
                status: 'paid',
                method: pm0 || order.payment?.method || 'card',
                intentId: piId || order.payment?.intentId || null,
                protected: true,
              };
              if (order.status === 'awaiting_payment') order.status = 'paid';
              await order.save();
            }
          }
          return res.json({ received: true });
        }
      } catch (e) {
        console.error('checkout.session.completed webhook error:', e);
      }

      return res.json({ received: true });
    }

    // Escrow (capture_method: manual) — po autoryzacji karty status = requires_capture (nie succeeded)
    if (event.type === 'payment_intent.amount_capturable_updated') {
      const intent = event.data.object;
      const orderId = intent.metadata?.orderId;
      if (orderId && intent.status === 'requires_capture') {
        try {
          await cancelDuplicateCapturableIntents(orderId, intent.id);
          const order = await Order.findById(orderId);
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          await applyOrderFundedFromStripeIntent(order, intent, payment);
        } catch (e) {
          console.error('payment_intent.amount_capturable_updated webhook error:', e);
        }
      }
      return res.json({ received: true });
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;

      // Subskrypcja: metadata na PI (po /subscribe) albo w Mongo Payment
      const subscriptionPayment = await Payment.findOne({ stripePaymentIntentId: intent.id });
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
            const now = new Date();
            const validUntil = new Date(now);

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
              sub.planKey = plan.key;
              sub.startedAt = now;
              sub.validUntil = validUntil;
              sub.renews = true;
              sub.freeExpressLeft = plan.freeExpressPerMonth || 0;
              sub.earlyAdopter = isEarlyAdopter;
              sub.earlyAdopterDiscount = earlyAdopterDiscount;
              sub.loyaltyMonths = loyaltyMonths;
              sub.loyaltyDiscount = loyaltyDiscount;
              if (referralCode) {
                sub.referralCodeUsed = referralCode.toUpperCase();
              }
              sub.isBusinessPlan = planKey.startsWith('BUSINESS_');
              sub.pendingPlanKey = null;
              sub.pendingBillingPeriod = null;

              const resetDate = new Date(now.getFullYear(), now.getMonth(), 1);
              if (planKey === 'CLIENT_PRO' || planKey === 'PROV_PRO') {
                sub.freeOrderBoostsLimit = 10;
                sub.freeOrderBoostsLeft = 10;
                sub.freeOrderBoostsResetDate = resetDate;
                sub.freeOfferBoostsLimit = 10;
                sub.freeOfferBoostsLeft = 10;
                sub.freeOfferBoostsResetDate = resetDate;
              } else if (planKey === 'CLIENT_STD' || planKey === 'PROV_STD') {
                sub.freeOrderBoostsLimit = 5;
                sub.freeOrderBoostsLeft = 5;
                sub.freeOrderBoostsResetDate = resetDate;
                sub.freeOfferBoostsLimit = 5;
                sub.freeOfferBoostsLeft = 5;
                sub.freeOfferBoostsResetDate = resetDate;
              } else {
                sub.freeOrderBoostsLimit = 0;
                sub.freeOrderBoostsLeft = 0;
                sub.freeOfferBoostsLimit = 0;
                sub.freeOfferBoostsLeft = 0;
              }

              if (planKey.startsWith('BUSINESS_')) {
                const compId = buyerForCompany?.company?._id || buyerForCompany?.company || sub.companyId;
                if (compId) {
                  sub.companyId = compId;
                  sub.useCompanyResourcePool = true;
                }
              }

              await sub.save();
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
              });
            }

            if (planKey.startsWith('BUSINESS_')) {
              const Company = require('../models/Company');
              const { initializeCompanyResourcePool } = require('../utils/resourcePool');
              const compId =
                buyerForCompany?.company?._id || buyerForCompany?.company || sub?.companyId;
              if (compId) {
                await initializeCompanyResourcePool(compId.toString(), planKey);
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
                    if (referrerSub) {
                      const newValidUntil = new Date(referrerSub.validUntil);
                      newValidUntil.setMonth(newValidUntil.getMonth() + 1);
                      referrerSub.validUntil = newValidUntil;
                      await referrerSub.save();
                    } else {
                      const rewardValidUntil = new Date(now);
                      rewardValidUntil.setMonth(rewardValidUntil.getMonth() + 1);
                      referrerSub = await UserSubscription.create({
                        user: referrer._id,
                        planKey: rewardPlanKey,
                        startedAt: now,
                        validUntil: rewardValidUntil,
                        renews: false,
                        freeExpressLeft: rewardPlan.freeExpressPerMonth || 0
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error('Subscription webhook handling error:', e);
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
          const User = require('../models/User');
          const user = await User.findById(userId);
          if (user) {
            user.aiConciergeUsage.push({
              date: new Date(),
              description: '',
              service: '',
              paid: true,
              payPerUsePrice: intent.amount
            });
            await user.save();
          }
        } catch (e) {
          console.error('AI Concierge pay-per-use webhook error:', e);
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
          const now = new Date();
          const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          await UsageAnalytics.incrementUsage(userId, monthKey, 'providerResponses', 1, true);

          // Pozwól na dodanie odpowiedzi (limit został przekroczony, ale zapłacono)
          // Frontend powinien ponownie wywołać endpoint POST /api/orders/:id/proposals z payPerUse: true
        } catch (e) {
          console.error('Provider response pay-per-use webhook error:', e);
        }
        return res.json({ received: true });
      }

      // Obsługa dopłat do zleceń (additional payment)
      if (intent.metadata?.type === 'additional_payment') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });

          if (order) {
            order.additionalPaymentStatus = 'succeeded';
            order.additionalPaymentPaidAt = new Date();
            order.clientCompletionStatus = 'accepted';
            order.clientCompletionAcceptedAt = order.clientCompletionAcceptedAt || new Date();
            await order.save();
          }
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }
        } catch (e) {
          console.error('Additional payment webhook handling error:', e);
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
            subscription.planKey = newPlanKey;
            subscription.freeExpressLeft = newPlan.freeExpressPerMonth || 0;
            await subscription.save();
          }
        } catch (e) {
          console.error('Subscription upgrade webhook error:', e);
        }
        return res.json({ received: true });
      }

      // Opłata prowizji dla zlecenia rozliczanego poza systemem
      if (intent.metadata?.type === 'commission_external') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });

          if (order) {
            order.externalCommissionStatus = 'succeeded';
            // External flow nie aktywuje escrow/protection.
            order.paidInSystem = false;
            await order.save();
          }
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }
        } catch (e) {
          console.error('External commission webhook handling error:', e);
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'contact_unlock') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order) {
            order.contactUnlockStatus = 'succeeded';
            order.contactUnlockedAt = new Date();
            await order.save();
          }
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }
        } catch (e) {
          console.error('Contact unlock webhook handling error:', e);
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'listing_addons') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          const { applyListingAddonsToOrder } = require('../utils/listingAddons');
          if (order) {
            await applyListingAddonsToOrder(order, {
              fastTrack: intent.metadata.fastTrack === '1',
              highlight: intent.metadata.highlight === '1',
              verifiedProvidersOnly: intent.metadata.verifiedProvidersOnly === '1',
            });
            try {
              const Revenue = require('../models/Revenue');
              await Revenue.create({
                orderId: order._id,
                clientId: order.client,
                type: 'priority_fee',
                amount: payment?.amount || Math.round(Number(intent.metadata.totalPln || 0) * 100),
                description: 'Boost widoczności zlecenia (offers_only)',
                status: 'paid',
              });
            } catch (revErr) {
              console.warn('Revenue listing_addons:', revErr.message);
            }
          }
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }
        } catch (e) {
          console.error('Listing addons webhook handling error:', e);
        }
        return res.json({ received: true });
      }

      // Błąd płatności dopłaty
      if (intent.metadata?.type === 'additional_payment') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order) {
            order.additionalPaymentStatus = 'failed';
            await order.save();
          }
          if (payment) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Additional payment payment_failed handling error:', e);
        }
        return res.json({ received: true });
      }

      // Obsługa promocji
      if (intent.metadata?.type === 'promotion') {
        const planId = intent.metadata.planId;
        const providerId = intent.metadata.providerId;

        const purchase = await require('../models/promotionPurchase').findOne({ stripePaymentIntentId: intent.id });
        const plan = await require('../models/promotionPlan').findById(planId);
        const user = await require('../models/User').findById(providerId);
        const payment = await require('../models/Payment').findOne({ stripePaymentIntentId: intent.id });

        if (plan && user) {
          const now = new Date();
          const prevEnd = purchase?.endsAt && purchase.endsAt > now ? purchase.endsAt : now;
          const endsAt = new Date(prevEnd.getTime() + plan.durationDays*24*60*60*1000);

          // Aktualizacja zakupu
          if (purchase) {
            purchase.status = 'active';
            purchase.startsAt = purchase.startsAt || now;
            purchase.endsAt = endsAt;
            await purchase.save();
          }

          // Punkty rankingowe
          user.rankingPoints = (user.rankingPoints || 0) + (plan.rankingPointsAdd || 0);

          // Badge'y wg efektów planu
          user.badges = user.badges || {};
          if (plan.effects?.highlight) user.badges.highlightUntil = endsAt;
          if (plan.effects?.topBadge) user.badges.topUntil = endsAt;
          if (plan.effects?.aiBadge) user.badges.aiRecommendedUntil = endsAt;

          await user.save();

          // Zaktualizuj Payment
          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            await payment.save();
          }

          // Zaznacz użycie kuponu (jeśli był użyty)
          const appliedCouponId = intent.metadata?.appliedCouponId;
          if (appliedCouponId) {
            try {
              await Coupon.findByIdAndUpdate(appliedCouponId, { $inc: { used: 1 } });
            } catch (e) {
              console.error('Coupon increment error (promotion):', e);
            }
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
        }

        return res.json({ received: true });
      }
      
      // Obsługa zleceń (istniejąca logika)
      const orderId = intent.metadata?.orderId;
      if (orderId) {
        const order = await Order.findById(orderId);
        const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });

        if (order) {
          order.paymentStatus = 'succeeded';
          order.paidInSystem = true;
          order.paymentMethod = intent.payment_method_types?.[0] || 'unknown';
          order.protectionEligible = true;
          order.protectionStatus = 'active';
          order.protectionExpiresAt = new Date(Date.now() + GUARANTEE_DAYS*24*60*60*1000);
          await order.save();
        }
        if (payment) {
          payment.status = 'succeeded';
          payment.method = intent.payment_method_types?.[0] || payment.method;
          await payment.save();
        }
      }
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
            if (payment) {
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
          }
          return res.json({ received: true });
        }
      }

      // Błąd płatności prowizji dla rozliczenia poza systemem
      if (intent.metadata?.type === 'commission_external') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order) {
            order.externalCommissionStatus = 'failed';
            await order.save();
          }
          if (payment) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('External commission payment_failed handling error:', e);
        }
        return res.json({ received: true });
      }

      if (intent.metadata?.type === 'contact_unlock') {
        const orderId = intent.metadata?.orderId;
        try {
          const order = orderId ? await Order.findById(orderId) : null;
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (order) {
            order.contactUnlockStatus = 'unpaid';
            await order.save();
          }
          if (payment) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Contact unlock payment_failed handling error:', e);
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
          if (payment) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Listing addons payment_failed handling error:', e);
        }
        return res.json({ received: true });
      }
      
      // Obsługa promocji
      if (intent.metadata?.type === 'promotion') {
        const purchase = await require('../models/promotionPurchase').findOne({ stripePaymentIntentId: intent.id });
        if (purchase) { purchase.status = 'failed'; await purchase.save(); }
        const payment = await require('../models/Payment').findOne({ stripePaymentIntentId: intent.id });
        if (payment) { payment.status = 'failed'; await payment.save(); }
        return res.json({ received: true });
      }

      // Obsługa wideo-wizyt
      if (intent.metadata?.type === 'video') {
        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (payment) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Video payment_failed handling error:', e);
        }
        return res.json({ received: true });
      }
      
      // Obsługa zleceń (istniejąca logika)
      const orderId = intent.metadata?.orderId;
      if (orderId) {
        const order = await Order.findById(orderId);
        const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
        if (order) {
          order.paymentStatus = 'failed';
          order.paidInSystem = false;
          order.protectionEligible = false;
          order.protectionStatus = 'inactive';
          order.protectionExpiresAt = null;
          await order.save();
          try {
            await Notification.create({
              user: order.client,
              type: 'order_updated',
              title: 'Płatność nieudana',
              message: 'Płatność za zlecenie nie powiodła się. Spróbuj ponownie inną metodą.',
              link: `/orders/${order._id}`,
              metadata: {
                orderId: String(order._id),
                paymentIntentId: intent.id
              }
            });
          } catch (notifyError) {
            console.error('Failed to create payment-failed notification:', notifyError);
          }
        }
        if (payment) {
          payment.status = 'failed';
          await payment.save();
        }
      }
    }

    if (event.type === 'charge.refunded' || event.type === 'charge.refund.updated') {
      const charge = event.data.object;
      const piRaw = charge.payment_intent;
      const pi = typeof piRaw === 'string' ? piRaw : piRaw?.id;
      const payment = pi ? await Payment.findOne({ stripePaymentIntentId: pi }) : null;
      const isAdditionalPayment = payment?.metadata?.type === 'additional_payment' || payment?.metadata?.subtype === 'additional_payment';
      
      if (payment?.purpose === 'promotion') {
        const purchase = await require('../models/promotionPurchase').findById(payment.promotionPurchase);
        if (purchase) {
          purchase.status = 'refunded';
          // opcjonalnie: skróć badge do teraz
          const user = await require('../models/User').findById(purchase.provider);
          if (user?.badges) {
            const now = new Date();
            if (user.badges.topUntil && user.badges.topUntil > now) user.badges.topUntil = now;
            if (user.badges.highlightUntil && user.badges.highlightUntil > now) user.badges.highlightUntil = now;
            if (user.badges.aiRecommendedUntil && user.badges.aiRecommendedUntil > now) user.badges.aiRecommendedUntil = now;
            await user.save();
          }
          await purchase.save();
        }
        // zaktualizuj status payment (już robisz wyżej)
      }
      
      if (payment) {
        const order = await Order.findById(payment.order);
        payment.status = charge.amount_refunded > 0
          ? (charge.amount_refunded < payment.amount ? 'partial_refund' : 'refunded')
          : payment.status;
        await payment.save();

        if (order) {
          if (isAdditionalPayment) {
            order.additionalPaymentStatus = payment.status;
          } else {
            order.paymentStatus = payment.status;
            // Gwarancja wygasa po pełnym zwrocie
            if (payment.status === 'refunded') {
              order.protectionStatus = 'void';
              order.protectionEligible = false;
            }
          }
          await order.save();
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
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
  try {
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe nie jest skonfigurowany' });
    }

    const { paymentId, amount } = req.body; // amount w groszach (opcjonalnie)
    const payment = await Payment.findById(paymentId);
    if (!payment || !payment.stripePaymentIntentId) return res.status(404).json({ message: 'Payment not found' });

    const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
    const chargeId = pi.charges?.data?.[0]?.id;
    if (!chargeId) return res.status(400).json({ message: 'No charge to refund' });

    const refund = await stripe.refunds.create({
      charge: chargeId,
      amount: amount || undefined,
    });

    res.json({ refund });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Błąd zwrotu' });
  }
});

module.exports = router;
module.exports.syncOrderPaymentFromStripe = syncOrderPaymentFromStripe;
