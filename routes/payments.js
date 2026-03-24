?const express = require('express');
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
const { authMiddleware } = require('../middleware/authMiddleware');
const NotificationService = require('../services/NotificationService');
const { validateNIP } = require('../utils/companyValidation');

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

// Feature flag – umożliwia stopniowe włączanie Stripe Connect
const ENABLE_STRIPE_CONNECT = process.env.ENABLE_STRIPE_CONNECT === 'true';

// --- STRIPE CONNECT: tworzenie konta i linków onboardingowych ---

// POST /api/payments/connect/create-account
// Tworzy konto Stripe Connect (Express) dla zalogowanego wykonawcy
router.post('/connect/create-account', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    if (user.role !== 'provider') {
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
    res.status(500).json({ message: 'Nie udało się utworzyć konta Stripe Connect' });
  }
});

// POST /api/payments/connect/account-link
// Generuje link onboardingowy / refresh do panelu Stripe dla providera
router.post('/connect/account-link', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    if (user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą aktywować wypłaty Stripe' });
    }
    if (!stripe) {
      return res.status(500).json({ message: 'Stripe nie jest skonfigurowany' });
    }

    // Upewnij się, że mamy konto
    if (!user.stripeAccountId) {
      return res.status(400).json({ message: 'Brak konta Stripe. Najpierw wywołaj /connect/create-account.' });
    }

    const refreshUrl = `${FRONTEND_URL}/account?tab=wallet`;
    const returnUrl = `${FRONTEND_URL}/account?tab=wallet&stripe_connected=1`;

    const accountLink = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (e) {
    console.error('Stripe Connect account-link error:', e);
    res.status(500).json({ message: 'Nie udało się wygenerować linku onboardingowego Stripe' });
  }
});

// GET /api/payments/connect/status
// Zwraca aktualny status konta Stripe Connect dla zalogowanego użytkownika
router.get('/connect/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    if (user.role !== 'provider') {
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

// POST /api/payments/create-intent
// body: { orderId, methodHint: 'card'|'p24'|'blik', requestInvoice?: boolean }
router.post('/create-intent', authMiddleware, async (req, res) => {
  try {
    const { orderId, methodHint = 'card', requestInvoice } = req.body;
    const order = await Order.findById(orderId).populate('client serviceProvider');
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });

    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'To nie jest Twoje zlecenie' });
    }
    if (order.paymentStatus === 'succeeded') {
      return res.status(400).json({ message: 'Zlecenie już opłacone' });
    }

    // Klient może zaznaczyć „Chcę fakturę VAT” przy płatności – zapisz w zleceniu
    if (typeof requestInvoice === 'boolean') {
      order.requestInvoice = requestInvoice;
    }

  // Kwota którą płaci klient (może być mniejsza jeśli użył punktów)
  const amount = order.amountTotal;
  
  // WAŻNE: PlatformFee obliczane od kwoty bazowej PRZED zniżkami z punktów
  // To zapewnia, że provider otrzymuje pełną kwotę (baseAmount + extrasCost - platformFee)
  // Zniżka z punktów jest pokrywana przez platformę jako koszt marketingowy
  const baseAmount = order.pricing?.baseAmount || order.amountTotal;
  const platformFeeAmount = Math.round(baseAmount * (order.platformFeePercent || PLATFORM_FEE_PERCENT));
  
  // Jeśli są zniżki z punktów, platforma pokrywa różnicę jako koszt marketingowy
  const pointsDiscount = order.pricing?.discountPoints || 0;

  // Jeżeli Stripe Connect jest wymagany dla płatności systemowych – upewnij się, że provider ma aktywne konto
  if (ENABLE_STRIPE_CONNECT && order.paymentMethod === 'system') {
    const provider = await User.findById(order.serviceProvider || order.provider).lean();
    if (!provider || !provider.stripeAccountId || !provider.stripeConnectStatus?.payoutsEnabled) {
      return res.status(400).json({
        message: 'Ten wykonawca nie ma jeszcze aktywowanych wypłat Stripe. Wybierz płatność poza systemem.'
      });
    }
  }

  // Stripe PaymentIntent
  const payment_method_types = (methodHint === 'p24')
      ? ['p24','card']
      : (methodHint === 'blik')
        ? ['blik','card']
        : ['card','p24']; // domyślnie card + p24

  // Jeżeli Stripe Connect jest włączony i provider ma konto – użyj destination charges
  // WAŻNE: Jeśli klient użył punktów, musimy zwiększyć amount w Stripe o pointsDiscount,
  // żeby provider otrzymał pełną kwotę. Platforma pokrywa różnicę jako koszt marketingowy.
  const stripeAmount = pointsDiscount > 0 ? amount + pointsDiscount : amount;
  
  let intentPayload = {
    amount: stripeAmount, // Kwota w Stripe = kwota którą płaci klient + zniżka z punktów (pokrywana przez platformę)
    currency: CURRENCY,
    payment_method_types,
    // Pełny escrow – najpierw autoryzacja, później capture po potwierdzeniu zakończenia zlecenia
    capture_method: 'manual',
    description: `Helpfli Order #${order._id}`,
    metadata: {
      orderId: String(order._id),
      clientId: String(order.client),
      providerId: String(order.serviceProvider),
      platformFeeAmount: String(platformFeeAmount),
      pointsDiscount: String(pointsDiscount),
      clientPaidAmount: String(amount), // Rzeczywista kwota którą zapłacił klient
    },
    statement_descriptor: 'HELPFLI',
  };

  if (ENABLE_STRIPE_CONNECT && order.serviceProvider && order.serviceProvider.stripeAccountId) {
    // Provider otrzyma: stripeAmount - platformFeeAmount = pełna kwota minus platformFee
    // Przykład: klient płaci 1250 zł, pointsDiscount = 50 zł, stripeAmount = 1300 zł
    // Provider otrzyma: 1300 - 100 = 1200 zł (baseAmount + extrasCost - platformFee)
    intentPayload = {
      ...intentPayload,
      application_fee_amount: platformFeeAmount,
      transfer_data: {
        destination: order.serviceProvider.stripeAccountId,
      },
    };
  }

  const intent = await stripe.paymentIntents.create(intentPayload);

    // Zapis w Payment (status wstępny)
    const payment = await Payment.create({
      order: order._id,
      provider: order.serviceProvider,
      client: order.client,
      providerName: order.serviceProvider?.name || '',
      clientName: order.client?.name || '',
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: methodHint,
      status: intent.status, // najczęściej "requires_payment_method" lub "requires_confirmation"
      platformFeePercent: order.platformFeePercent || PLATFORM_FEE_PERCENT,
      platformFeeAmount: platformFeeAmount, // PlatformFee obliczane od baseAmount (przed zniżkami z punktów)
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
    order.payment.status = payment.status;
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

// POST /api/payments/create-commission-intent
// Tworzy PaymentIntent tylko na opłatę serwisową (platform fee) przy płatności poza systemem.
// body: { orderId, methodHint: 'card'|'p24'|'blik' }
router.post('/create-commission-intent', authMiddleware, async (req, res) => {
  try {
    const { orderId, methodHint = 'card' } = req.body;
    const order = await Order.findById(orderId).populate('client');
    if (!order) return res.status(404).json({ message: 'Nie znaleziono zlecenia' });

    if (String(order.client) !== String(req.user._id)) {
      return res.status(403).json({ message: 'To nie jest Twoje zlecenie' });
    }

    const platformFeePln = order.pricing?.platformFee || 0;
    if (!platformFeePln || platformFeePln <= 0) {
      return res.status(400).json({ message: 'Brak opłaty serwisowej do zapłaty' });
    }

    // Stripe kwota w groszach
    const amount = Math.round(platformFeePln * 100);

    const payment_method_types = (methodHint === 'p24')
      ? ['p24', 'card']
      : (methodHint === 'blik')
        ? ['blik', 'card']
        : ['card', 'p24'];

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: CURRENCY,
      payment_method_types,
      // Dla prowizji nie używamy escrow ani Stripe Connect – całość trafia do Helpfli
      capture_method: 'automatic',
      description: `Opłata serwisowa Helpfli za zlecenie #${order._id}`,
      metadata: {
        orderId: String(order._id),
        clientId: String(order.client),
        type: 'commission_external',
        commissionAmountPln: String(platformFeePln),
      },
      statement_descriptor: 'HELPFLI',
    });

    const payment = await Payment.create({
      order: order._id,
      provider: null,
      client: order.client,
      providerName: '',
      clientName: order.client?.name || '',
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: methodHint,
      status: intent.status,
      // Cała kwota to opłata serwisowa
      platformFeePercent: 1,
      platformFeeAmount: amount,
      pointsDiscount: 0,
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
    order.paymentStatus = 'processing';
    order.paidInSystem = false;
    order.payment = order.payment || {};
    order.payment.intentId = intent.id;
    order.payment.status = payment.status;
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
      metadata: { action: 'create-commission-intent', methodHint: req.body?.methodHint }
    });
    res.status(500).json({ message: 'Błąd tworzenia płatności za prowizję' });
  }
});

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

// Funkcja pomocnicza do tworzenia faktury
async function createInvoiceForOrder(client, order, payment, customerType, invoiceMode) {
  const grossAmount = order.amountTotal;
  const taxRate = 23;
  const subtotal = Math.round(grossAmount / (1 + taxRate / 100));
  const taxAmount = grossAmount - subtotal;

  const buyerName = customerType === 'company' 
    ? (client.billing?.companyName || client.name || client.email)
    : (client.name || client.email);

  const saleDate = new Date(); // Data sprzedaży = data płatności
  const dueDate = new Date(saleDate);
  dueDate.setDate(dueDate.getDate() + 14); // Termin płatności: 14 dni

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
      name: process.env.INVOICE_SELLER_NAME || 'Helpfli Sp. z o.o.',
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

  // Wyślij mail do klienta z informacją o fakturze
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

        // Aktualizuj Revenue
        await Revenue.updateMany(
          { orderId: order._id, status: 'pending' },
          { $set: { status: 'paid', paidAt: new Date() } }
        );

        // Wyślij powiadomienie do providera o zabezpieczeniu środków
        try {
          await NotificationService.notifyOrderFunded(order._id);
        } catch (error) {
          console.error('Notification error:', error);
        }
      }

      res.json({ 
        message: 'Płatność została zabezpieczona',
        status: intent.status,
        amount: intent.amount_received
      });
    } else {
      res.status(400).json({ 
        message: 'Nie udało się zabezpieczyć płatności',
        status: intent.status
      });
    }

  } catch (error) {
    console.error('Capture payment error:', error);
    await logPaymentError({
      errorType: 'capture_failed',
      errorMessage: error.message,
      errorStack: error.stack,
      paymentId: payment?._id,
      orderId: payment?.order,
      userId: req.user?._id,
      stripePaymentIntentId: paymentIntentId,
      retryable: true,
      metadata: { action: 'capture' }
    });
    res.status(500).json({ message: 'Błąd zabezpieczania płatności' });
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
                    description: `Zniżka za osiągnięcie ${performanceDiscountOrders} zleceń w poprzednim miesiącu`
                  },
                  metadata: {
                    planKey: plan.key,
                    performanceDiscount: String(performanceDiscount)
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
    
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      
      // Obsługa subskrypcji
      if (intent.metadata?.type === 'subscription') {
        const userId = intent.metadata.userId;
        const planKey = intent.metadata.planKey;
        const billingPeriod = intent.metadata.billingPeriod || 'monthly';
        const referralCode = intent.metadata.referralCode;
        const earlyAdopter = intent.metadata.earlyAdopter === 'true';

        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          const plan = await SubscriptionPlan.findOne({ key: planKey, active: true });
          const User = require('../models/User');

          if (payment) {
            payment.status = 'succeeded';
            payment.method = intent.payment_method_types?.[0] || payment.method;
            payment.amount = intent.amount;
            payment.currency = intent.currency || payment.currency;
            payment.subscriptionUser = payment.subscriptionUser || userId;
            payment.subscriptionPlanKey = payment.subscriptionPlanKey || planKey;
            await payment.save();
          }

          if (userId && plan) {
            const now = new Date();
            const validUntil = new Date(now);
            
            // Obsługa rocznych planów
            if (billingPeriod === 'yearly') {
              validUntil.setFullYear(validUntil.getFullYear() + 1);
            } else {
              validUntil.setMonth(validUntil.getMonth() + 1);
            }

            // Sprawdź czy użytkownik jest early adopterem
            const totalUsers = await User.countDocuments();
            const isEarlyAdopter = earlyAdopter || totalUsers <= 1000;
            const earlyAdopterDiscount = isEarlyAdopter ? 30 : 0;

            // Sprawdź loyalty discount
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
              
              // Inicjalizuj limity boostów
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
              
              await sub.save();
            } else {
              // Inicjalizuj limity boostów dla nowej subskrypcji
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
                freeOrderBoostsLimit,
                freeOrderBoostsLeft,
                freeOrderBoostsResetDate: resetDate,
                freeOfferBoostsLimit,
                freeOfferBoostsLeft,
                freeOfferBoostsResetDate: resetDate
              });
            }

            // Obsługa referral code - przyznaj nagrodę referrerowi
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
      
      // Obsługa subskrypcji
      if (intent.metadata?.type === 'subscription') {
        try {
          const payment = await Payment.findOne({ stripePaymentIntentId: intent.id });
          if (payment) {
            payment.status = 'failed';
            await payment.save();
          }
        } catch (e) {
          console.error('Subscription payment_failed handling error:', e);
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
        }
        if (payment) {
          payment.status = 'failed';
          await payment.save();
        }
      }
    }

    if (event.type === 'charge.refunded' || event.type === 'charge.refund.updated') {
      const charge = event.data.object;
      const pi = charge.payment_intent;
      const payment = await Payment.findOne({ stripePaymentIntentId: pi });
      
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
          order.paymentStatus = payment.status;
          // Gwarancja wygasa po pełnym zwrocie
          if (payment.status === 'refunded') {
            order.protectionStatus = 'void';
            order.protectionEligible = false;
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

// (Opcjonalnie) POST /api/payments/refund – tylko admin
router.post('/refund', authMiddleware, async (req, res) => {
  // Wersja demo – dodaj weryfikację roli admin
  try {
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
