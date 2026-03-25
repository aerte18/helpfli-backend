const express = require('express');
const router = express.Router();
const SubscriptionPlan = require('../models/SubscriptionPlan');
const UserSubscription = require('../models/UserSubscription');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const Payment = require('../models/Payment');
const PointTransaction = require('../models/PointTransaction');
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const CURRENCY = process.env.CURRENCY || 'pln';

router.get('/plans', async (req, res) => {
  const { audience } = req.query;
  
  let filter = { active: true };
  
  // Filtruj plany po audience (client/provider/business)
  if (audience === 'client') {
    filter.key = { $regex: /^CLIENT_/ };
  } else if (audience === 'provider') {
    filter.key = { $regex: /^PROV_/ };
  } else if (audience === 'business') {
    filter.key = { $regex: /^BUSINESS_/ };
  }
  // Jeśli brak audience, zwróć wszystkie plany (dla kompatybilności wstecznej)
  
  const plans = await SubscriptionPlan.find(filter).sort({ priceMonthly: 1 });
  res.json(plans);
});

router.post('/subscribe', auth, async (req, res) => {
  const { planKey, billingPeriod = 'monthly', referralCode, earlyAdopter = false, requestInvoice = false } = req.body || {};
  
  // Sprawdź performance discount dla providerów
  const { getCurrentPerformanceDiscount } = require('../utils/performancePricing');
  let performanceDiscount = 0;
  if (req.user.role === 'provider') {
    const perfDiscount = await getCurrentPerformanceDiscount(req.user._id);
    performanceDiscount = perfDiscount.discountPercent;
  } 
  // billingPeriod: 'monthly' lub 'yearly'
  // referralCode: kod polecający (opcjonalny)
  // earlyAdopter: czy użytkownik jest early adopterem (pierwsze 1000 użytkowników)
  
  const plan = await SubscriptionPlan.findOne({ key: planKey, active: true });
  if (!plan) return res.status(404).json({ message: 'Plan nie istnieje' });

  const now = new Date();
  const validUntil = new Date(now);
  
  // Obsługa rocznych planów (20% zniżki)
  if (billingPeriod === 'yearly') {
    validUntil.setFullYear(validUntil.getFullYear() + 1);
  } else {
    validUntil.setMonth(validUntil.getMonth() + 1);
  }
  
  // Sprawdź czy użytkownik jest early adopterem (pierwsze 1000 użytkowników)
  const totalUsers = await User.countDocuments();
  const isEarlyAdopter = earlyAdopter || totalUsers <= 1000;
  const earlyAdopterDiscount = isEarlyAdopter ? 30 : 0; // 30% zniżki dla early adopters
  
  // Sprawdź referral code jeśli podany
  let referralDiscount = 0;
  if (referralCode) {
    const ReferralCode = require('../models/ReferralCode');
    const refCode = await ReferralCode.findOne({ code: referralCode.toUpperCase(), active: true });
    if (refCode && refCode.rewards.refereeReward === '20_percent_discount') {
      referralDiscount = 20;
    }
  }
  
  // Sprawdź loyalty discount (liczba miesięcy ciągłej subskrypcji)
  const existingSub = await UserSubscription.findOne({ user: req.user._id });
  let loyaltyMonths = 0;
  let loyaltyDiscount = 0;
  
  if (existingSub) {
    // Oblicz liczbę miesięcy ciągłej subskrypcji
    const monthsDiff = Math.floor((now - existingSub.startedAt) / (1000 * 60 * 60 * 24 * 30));
    loyaltyMonths = monthsDiff;
    
    // Zastosuj zniżki lojalnościowe
    if (loyaltyMonths >= 24) {
      loyaltyDiscount = 15; // 15% po 24 miesiącach
    } else if (loyaltyMonths >= 12) {
      loyaltyDiscount = 10; // 10% po 12 miesiącach
    } else if (loyaltyMonths >= 6) {
      loyaltyDiscount = 5; // 5% po 6 miesiącach
    }
  }
  
  // Oblicz finalną cenę z wszystkimi zniżkami
  const basePrice = billingPeriod === 'yearly' 
    ? (plan.priceYearly || plan.priceMonthly * 12 * 0.8)
    : (plan.priceMonthly || 0);
  
  // Zastosuj zniżki (największa zniżka ma pierwszeństwo, nie sumują się)
  const maxDiscount = Math.max(earlyAdopterDiscount, referralDiscount, loyaltyDiscount);
  let finalPrice = Math.round(basePrice * (1 - maxDiscount / 100) * 100); // w groszach
  
  // Zastosuj performance discount (dodatkowa zniżka dla providerów)
  if (performanceDiscount > 0) {
    finalPrice = Math.round(finalPrice * (1 - performanceDiscount / 100));
  }

  // W trybie development - mockowa płatność + od razu aktywacja subskrypcji
  if (process.env.NODE_ENV === 'development') {
    const amount = finalPrice; // Użyj już obliczonej ceny z zniżkami
    const isBusinessPlan = planKey.startsWith('BUSINESS_');
    
    // Jeśli to business plan, pobierz companyId użytkownika
    let companyId = null;
    if (isBusinessPlan) {
      const User = require('../models/User');
      const user = await User.findById(req.user._id).populate('company');
      if (user && user.company) {
        companyId = user.company._id;
      }
    }

    await Payment.create({
      purpose: 'subscription',
      subscriptionUser: req.user._id,
      subscriptionPlanKey: plan.key,
      amount,
      currency: CURRENCY,
      status: 'succeeded',
      metadata: {
        type: 'subscription',
        planKey: plan.key,
        userId: String(req.user._id),
        environment: 'development',
      },
    });

    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (existing) {
      existing.planKey = plan.key;
      existing.startedAt = now;
      existing.validUntil = validUntil;
      existing.renews = true;
      existing.freeExpressLeft = plan.freeExpressPerMonth || 0;
      // Ustaw limity boostów z planu
      const freeBoostsPerMonth = plan.freeBoostsPerMonth || 0;
      if (freeBoostsPerMonth > 0) {
        existing.freeOrderBoostsLimit = freeBoostsPerMonth;
        existing.freeOrderBoostsLeft = freeBoostsPerMonth;
        existing.freeOrderBoostsResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
      } else {
        existing.freeOrderBoostsLimit = 0;
        existing.freeOrderBoostsLeft = 0;
      }
      existing.earlyAdopter = isEarlyAdopter;
      existing.earlyAdopterDiscount = earlyAdopterDiscount;
      existing.loyaltyMonths = loyaltyMonths;
      existing.loyaltyDiscount = loyaltyDiscount;
      existing.performanceDiscount = performanceDiscount;
      existing.performanceDiscountOrders = performanceDiscountOrders;
      existing.performanceDiscountTier = performanceDiscountTier;
      existing.isBusinessPlan = isBusinessPlan;
      existing.companyId = companyId; // Zapisz companyId dla business planów
      existing.useCompanyResourcePool = isBusinessPlan; // Automatycznie włącz dla business planów
      if (referralCode) {
        existing.referralCodeUsed = referralCode.toUpperCase();
      }
      await existing.save();
      
      // Jeśli to business plan, zainicjalizuj resource pool
      if (isBusinessPlan && companyId) {
        const { initializeCompanyResourcePool } = require('../utils/resourcePool');
        await initializeCompanyResourcePool(companyId, planKey);
      }
      
      return res.json({ 
        message: 'Subskrypcja odnowiona', 
        sub: existing,
        discounts: {
          earlyAdopter: earlyAdopterDiscount,
          referral: referralDiscount,
          loyalty: loyaltyDiscount,
          total: maxDiscount
        }
      });
    }

    // Inicjalizuj limity boostów z planu
    const resetDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const freeBoostsPerMonth = plan.freeBoostsPerMonth || 0;
    let freeOrderBoostsLimit = freeBoostsPerMonth;
    let freeOrderBoostsLeft = freeBoostsPerMonth;
    let freeOfferBoostsLimit = 0; // Dla providerów - na razie bez darmowych boostów
    let freeOfferBoostsLeft = 0;
    
    const created = await UserSubscription.create({
      user: req.user._id,
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
      isBusinessPlan: isBusinessPlan,
      companyId: companyId, // Zapisz companyId dla business planów
      useCompanyResourcePool: isBusinessPlan, // Automatycznie włącz dla business planów
      performanceDiscount: performanceDiscount,
      performanceDiscountOrders: performanceDiscountOrders,
      performanceDiscountTier: performanceDiscountTier,
      freeOrderBoostsLimit,
      freeOrderBoostsLeft,
      freeOrderBoostsResetDate: resetDate,
      freeOfferBoostsLimit,
      freeOfferBoostsLeft,
      freeOfferBoostsResetDate: resetDate
    });
    
    // Jeśli to business plan, zainicjalizuj resource pool
    if (isBusinessPlan && companyId) {
      const { initializeCompanyResourcePool } = require('../utils/resourcePool');
      await initializeCompanyResourcePool(companyId, planKey);
    }
    
    return res.json({ 
      message: 'Subskrypcja aktywna', 
      sub: created,
      discounts: {
        earlyAdopter: earlyAdopterDiscount,
        referral: referralDiscount,
        loyalty: loyaltyDiscount,
        total: maxDiscount
      }
    });
  }

  // Produkcja – użyj Stripe Subscriptions API dla automatycznego odnawiania
  try {
    if (!stripe) {
      return res.status(500).json({ message: 'Płatności Stripe nie są skonfigurowane' });
    }

    const User = require('../models/User');
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Użytkownik nie znaleziony' });

    // Oblicz finalną cenę z zniżkami
    const basePriceProd = billingPeriod === 'yearly' 
      ? (plan.priceYearly || plan.priceMonthly * 12 * 0.8)
      : (plan.priceMonthly || 0);
    const maxDiscountProd = Math.max(earlyAdopterDiscount, referralDiscount, loyaltyDiscount);
    const finalPriceProd = Math.round(basePriceProd * (1 - maxDiscountProd / 100) * 100);

    // Utwórz lub pobierz Stripe Customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
          userId: String(user._id),
          role: user.role || 'client'
        }
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    // Utwórz lub znajdź Price w Stripe
    // W produkcji powinieneś mieć wcześniej utworzone Prices w Stripe Dashboard
    // Tutaj tworzymy Price dynamicznie (można też użyć istniejących Price IDs)
    const priceData = {
      unit_amount: finalPriceProd,
      currency: CURRENCY.toLowerCase(),
      recurring: {
        interval: billingPeriod === 'yearly' ? 'year' : 'month',
        interval_count: 1
      },
      product_data: {
        name: `${plan.name} - ${billingPeriod === 'yearly' ? 'Roczna' : 'Miesięczna'}`,
        description: plan.perks?.join(', ') || ''
      },
      metadata: {
        planKey: plan.key,
        billingPeriod: billingPeriod
      }
    };

    const stripePrice = await stripe.prices.create(priceData);

    // Utwórz Subscription w Stripe
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: stripePrice.id }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        payment_method_types: ['card', 'p24'],
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        userId: String(req.user._id),
        planKey: plan.key,
        billingPeriod: billingPeriod,
        referralCode: referralCode || '',
        earlyAdopter: String(isEarlyAdopter),
        loyaltyMonths: String(loyaltyMonths),
        loyaltyDiscount: String(loyaltyDiscount)
      },
      // Automatyczne odnawianie
      collection_method: 'charge_automatically'
      // Stripe automatycznie retry'uje failed payments (3 próby w ciągu 7 dni)
    });

    // Zapisz Subscription ID w UserSubscription
    const isBusinessPlan = planKey.startsWith('BUSINESS_');
    
    // Jeśli to business plan, pobierz companyId użytkownika
    let companyId = null;
    if (isBusinessPlan) {
      const user = await User.findById(req.user._id).populate('company');
      if (user && user.company) {
        companyId = user.company._id;
      }
    }
    
    const existingSub = await UserSubscription.findOne({ user: req.user._id });
    
    if (existingSub) {
      existingSub.stripeSubscriptionId = subscription.id;
      existingSub.stripeCustomerId = customerId;
      existingSub.stripePriceId = stripePrice.id;
      existingSub.planKey = plan.key;
      existingSub.isBusinessPlan = isBusinessPlan;
      existingSub.companyId = companyId; // Zapisz companyId dla business planów
      existingSub.useCompanyResourcePool = isBusinessPlan; // Automatycznie włącz dla business planów
      
      // Zaktualizuj limity boostów przy zmianie planu (z planu)
      const resetDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const freeBoostsPerMonth = plan.freeBoostsPerMonth || 0;
      existingSub.freeOrderBoostsLimit = freeBoostsPerMonth;
      existingSub.freeOrderBoostsLeft = freeBoostsPerMonth;
      existingSub.freeOrderBoostsResetDate = resetDate;
      existingSub.freeOfferBoostsLimit = 0; // Dla providerów - na razie bez darmowych boostów
      existingSub.freeOfferBoostsLeft = 0;
      
      await existingSub.save();
    } else {
      // Inicjalizuj limity boostów dla nowej subskrypcji (z planu)
      const resetDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const freeBoostsPerMonth = plan.freeBoostsPerMonth || 0;
      let freeOrderBoostsLimit = freeBoostsPerMonth;
      let freeOrderBoostsLeft = freeBoostsPerMonth;
      let freeOfferBoostsLimit = 0; // Dla providerów - na razie bez darmowych boostów
      let freeOfferBoostsLeft = 0;
      
      // Stary kod dla kompatybilności (do usunięcia później)
      if (false && (plan.key === 'CLIENT_PRO' || plan.key === 'PROV_PRO')) {
        freeOrderBoostsLimit = 10;
        freeOrderBoostsLeft = 10;
        freeOfferBoostsLimit = 10;
        freeOfferBoostsLeft = 10;
      } else if (plan.key === 'CLIENT_STD' || plan.key === 'PROV_STD') {
        freeOrderBoostsLimit = 5;
        freeOrderBoostsLeft = 5;
        freeOfferBoostsLimit = 5;
        freeOfferBoostsLeft = 5;
      }
      
      await UserSubscription.create({
        user: req.user._id,
        planKey: plan.key,
        startedAt: now,
        validUntil: validUntil,
        renews: true,
        freeExpressLeft: plan.freeExpressPerMonth || 0,
        earlyAdopter: isEarlyAdopter,
        earlyAdopterDiscount: earlyAdopterDiscount,
        loyaltyMonths: loyaltyMonths,
        loyaltyDiscount: loyaltyDiscount,
        referralCodeUsed: referralCode ? referralCode.toUpperCase() : null,
        isBusinessPlan: isBusinessPlan,
        companyId: companyId, // Zapisz companyId dla business planów
        useCompanyResourcePool: isBusinessPlan, // Automatycznie włącz dla business planów
        stripeSubscriptionId: subscription.id,
        freeOrderBoostsLimit,
        freeOrderBoostsLeft,
        freeOrderBoostsResetDate: resetDate,
        freeOfferBoostsLimit,
        freeOfferBoostsLeft,
        freeOfferBoostsResetDate: resetDate,
        stripeCustomerId: customerId,
        stripePriceId: stripePrice.id
      });
    }
    
    // Jeśli to business plan, zainicjalizuj resource pool dla firmy użytkownika
    if (isBusinessPlan && companyId) {
      const { initializeCompanyResourcePool } = require('../utils/resourcePool');
      await initializeCompanyResourcePool(companyId, planKey);
      
      // Aktualizuj krok onboardingu - plan został wybrany
      const Company = require('../models/Company');
      const company = await Company.findById(companyId);
      if (company && !company.onboardingSteps.planSelected) {
        company.onboardingSteps.planSelected = true;
        await company.save();
      }
    }

    // Zapisz Payment record
    const invoice = subscription.latest_invoice;
    const paymentIntent = invoice?.payment_intent;
    
    await Payment.create({
      purpose: 'subscription',
      subscriptionUser: req.user._id,
      subscriptionPlanKey: plan.key,
      amount: finalPriceProd,
      currency: CURRENCY,
      method: 'unknown',
      status: paymentIntent?.status || 'processing',
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId,
      stripeInvoiceId: invoice?.id,
      stripePaymentIntentId: paymentIntent?.id,
      metadata: {
        type: 'subscription',
        planKey: plan.key,
        billingPeriod: billingPeriod,
        userId: String(req.user._id)
      }
    });

    return res.json({
      message: 'Subskrypcja utworzona - wymagana płatność',
      subscriptionId: subscription.id,
      clientSecret: paymentIntent?.client_secret,
      paymentIntentId: paymentIntent?.id,
      planKey: plan.key,
      amount: finalPriceProd / 100,
      status: subscription.status
    });
  } catch (err) {
    console.error('Subscription payment error:', err);
    return res.status(500).json({ message: 'Błąd inicjowania płatności za subskrypcję', error: err.message });
  }
});

// POST /api/subscriptions/cancel - Anulowanie subskrypcji z retention offer
router.post('/cancel', auth, async (req, res) => {
  try {
    const { reason, feedback } = req.body || {};
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Brak aktywnej subskrypcji' });
    
    // Retention offer - 20% zniżki żeby zostać
    const retentionOffer = {
      discount: 20,
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 dni na decyzję
      message: 'Otrzymujesz 20% zniżki jeśli zmienisz zdanie w ciągu 7 dni'
    };
    
    existing.renews = false;
    existing.cancelledAt = new Date();
    existing.cancellationReason = reason || 'not_specified';
    if (feedback) {
      existing.cancellationFeedback = feedback;
    }
    await existing.save();
    
    // Wyślij email z retention offer
    try {
      const User = require('../models/User');
      const SubscriptionPlan = require('../models/SubscriptionPlan');
      const { sendMail } = require('../utils/mailer');
      const user = await User.findById(req.user._id);
      const plan = await SubscriptionPlan.findOne({ key: existing.planKey });
      
      if (user && plan) {
        await sendMail({
          to: user.email,
          subject: '😢 Szkoda, że odchodzisz - specjalna oferta',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #fa709a 0%, #fee140 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0;">😢 Szkoda, że odchodzisz</h1>
              </div>
              <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <p>Cześć ${user.name || ''},</p>
                <p>Rozumiemy Twoją decyzję o anulowaniu subskrypcji <strong>${plan.name}</strong>.</p>
                
                <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
                  <p style="margin: 0; font-size: 18px; font-weight: bold; color: #92400e;">
                    🎁 Specjalna oferta: 20% zniżki jeśli zmienisz zdanie!
                  </p>
                  <p style="margin: 10px 0 0 0; color: #78350f;">
                    Oferta ważna przez 7 dni. Twoja subskrypcja będzie działać do końca okresu rozliczeniowego.
                  </p>
                </div>
                
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${process.env.FRONTEND_URL || ''}/account/subscriptions?retention=true&discount=20" 
                     style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                    Przywróć subskrypcję z 20% zniżką
                  </a>
                </div>
                
                <p style="color: #666; font-size: 14px; margin-top: 30px;">
                  Pozdrawiamy,<br/>
                  <strong>Zespół Helpfli</strong>
                </p>
              </div>
            </div>
          `
        });
      }
    } catch (emailError) {
      console.error('Error sending retention offer email:', emailError);
    }
    
    res.json({ 
      message: 'Subskrypcja anulowana',
      subscription: existing,
      retentionOffer: retentionOffer
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ message: 'Błąd anulowania subskrypcji' });
  }
});

// POST /api/subscriptions/pause - Wstrzymanie subskrypcji (1-3 miesiące)
router.post('/pause', auth, async (req, res) => {
  try {
    const { months = 1 } = req.body || {}; // 1-3 miesiące
    if (months < 1 || months > 3) {
      return res.status(400).json({ message: 'Można wstrzymać na 1-3 miesiące' });
    }
    
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Brak aktywnej subskrypcji' });
    
    const pauseUntil = new Date(existing.validUntil);
    pauseUntil.setMonth(pauseUntil.getMonth() + months);
    
    existing.pausedUntil = pauseUntil;
    existing.renews = false; // Nie odnawia się podczas pauzy
    await existing.save();
    
    res.json({ 
      message: `Subskrypcja wstrzymana do ${pauseUntil.toLocaleDateString('pl-PL')}`,
      pausedUntil: pauseUntil
    });
  } catch (error) {
    console.error('Pause subscription error:', error);
    res.status(500).json({ message: 'Błąd wstrzymywania subskrypcji' });
  }
});

// POST /api/subscriptions/upgrade - Upgrade planu (natychmiastowy)
router.post('/upgrade', auth, async (req, res) => {
  try {
    const { newPlanKey } = req.body || {};
    const newPlan = await SubscriptionPlan.findOne({ key: newPlanKey, active: true });
    if (!newPlan) return res.status(404).json({ message: 'Plan nie istnieje' });
    
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Brak aktywnej subskrypcji' });
    
    const oldPlan = await SubscriptionPlan.findOne({ key: existing.planKey });
    if (!oldPlan) return res.status(404).json({ message: 'Stary plan nie istnieje' });
    
    // Sprawdź czy to upgrade (wyższa cena)
    const isUpgrade = (newPlan.priceMonthly || 0) > (oldPlan.priceMonthly || 0);
    if (!isUpgrade) {
      return res.status(400).json({ message: 'Użyj /downgrade dla niższych planów' });
    }
    
    // Jeśli ma Stripe Subscription - użyj Stripe API z prorated billing
    if (existing.stripeSubscriptionId && stripe) {
      try {
        // Oblicz finalną cenę z zniżkami
        const basePrice = newPlan.priceMonthly || 0;
        const maxDiscount = Math.max(
          existing.earlyAdopterDiscount || 0,
          existing.loyaltyDiscount || 0
        );
        const finalPrice = Math.round(basePrice * (1 - maxDiscount / 100) * 100);
        
        // Utwórz nowy Price w Stripe
        const priceData = {
          unit_amount: finalPrice,
          currency: CURRENCY.toLowerCase(),
          recurring: {
            interval: 'month',
            interval_count: 1
          },
          product_data: {
            name: `${newPlan.name} - Miesięczna`,
            description: newPlan.perks?.join(', ') || ''
          },
          metadata: {
            planKey: newPlan.key
          }
        };
        
        const stripePrice = await stripe.prices.create(priceData);
        
        // Update subscription w Stripe z prorated billing
        const stripeSub = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
        
        const updatedSub = await stripe.subscriptions.update(existing.stripeSubscriptionId, {
          items: [{
            id: stripeSub.items.data[0].id,
            price: stripePrice.id
          }],
          proration_behavior: 'create_prorations', // Prorated billing - zapłać różnicę proporcjonalnie
          metadata: {
            ...stripeSub.metadata,
            planKey: newPlan.key
          }
        });
        
        // Aktualizuj lokalną subskrypcję
        existing.planKey = newPlanKey;
        existing.freeExpressLeft = newPlan.freeExpressPerMonth || 0;
        existing.stripePriceId = stripePrice.id;
        existing.validUntil = new Date(updatedSub.current_period_end * 1000);
        await existing.save();
        
        return res.json({
          message: 'Plan zaktualizowany',
          subscription: existing,
          prorated: true,
          nextInvoice: updatedSub.latest_invoice
        });
      } catch (stripeError) {
        console.error('Stripe upgrade error:', stripeError);
        return res.status(500).json({ message: 'Błąd upgrade w Stripe', error: stripeError.message });
      }
    }
    
    // Fallback - bez Stripe Subscription (stary system)
    const now = new Date();
    const daysRemaining = Math.ceil((existing.validUntil - now) / (1000 * 60 * 60 * 24));
    const daysInPeriod = Math.ceil((existing.validUntil - existing.startedAt) / (1000 * 60 * 60 * 24));
    
    const oldPlanPrice = oldPlan.priceMonthly || 0;
    const newPlanPrice = newPlan.priceMonthly || 0;
    
    const refundAmount = Math.round((oldPlanPrice * (daysRemaining / daysInPeriod)) * 100);
    const chargeAmount = Math.round((newPlanPrice * (daysRemaining / daysInPeriod)) * 100);
    const amountToPay = Math.max(0, chargeAmount - refundAmount);
    
    // W trybie development - natychmiastowy upgrade
    if (process.env.NODE_ENV === 'development') {
      existing.planKey = newPlanKey;
      existing.freeExpressLeft = newPlan.freeExpressPerMonth || 0;
      await existing.save();
      
      return res.json({
        message: 'Plan zaktualizowany',
        subscription: existing,
        proratedAmount: amountToPay / 100,
        refundAmount: refundAmount / 100,
        chargeAmount: chargeAmount / 100
      });
    }
    
    // Produkcja - wymagaj płatności różnicy (PaymentIntent fallback)
    if (amountToPay > 0) {
      const intent = await stripe.paymentIntents.create({
        amount: amountToPay,
        currency: 'pln',
        payment_method_types: ['card', 'p24'],
        description: `Helpfli Upgrade: ${oldPlan.name} → ${newPlan.name}`,
        metadata: {
          type: 'subscription_upgrade',
          userId: String(req.user._id),
          oldPlanKey: existing.planKey,
          newPlanKey: newPlanKey,
          proratedAmount: String(amountToPay)
        }
      });
      
      return res.json({
        requiresPayment: true,
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        amount: amountToPay,
        proratedAmount: amountToPay / 100,
        refundAmount: refundAmount / 100,
        chargeAmount: chargeAmount / 100
      });
    }
    
    // Upgrade za darmo
    existing.planKey = newPlanKey;
    existing.freeExpressLeft = newPlan.freeExpressPerMonth || 0;
    await existing.save();
    
    res.json({
      message: 'Plan zaktualizowany',
      subscription: existing
    });
    
  } catch (error) {
    console.error('Upgrade subscription error:', error);
    res.status(500).json({ message: 'Błąd upgrade subskrypcji' });
  }
});

// POST /api/subscriptions/downgrade - Downgrade planu (na koniec okresu lub natychmiastowy dla Stripe)
router.post('/downgrade', auth, async (req, res) => {
  try {
    const { newPlanKey, immediate = false } = req.body || {};
    const newPlan = await SubscriptionPlan.findOne({ key: newPlanKey, active: true });
    if (!newPlan) return res.status(404).json({ message: 'Plan nie istnieje' });
    
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Brak aktywnej subskrypcji' });
    
    const oldPlan = await SubscriptionPlan.findOne({ key: existing.planKey });
    if (!oldPlan) return res.status(404).json({ message: 'Stary plan nie istnieje' });
    
    // Sprawdź czy to downgrade (niższa cena)
    const isDowngrade = (newPlan.priceMonthly || 0) < (oldPlan.priceMonthly || 0);
    if (!isDowngrade) {
      return res.status(400).json({ message: 'Użyj /upgrade dla wyższych planów' });
    }
    
    // Jeśli ma Stripe Subscription - użyj Stripe API
    if (existing.stripeSubscriptionId && stripe) {
      try {
        // Oblicz nową cenę
        const basePrice = newPlan.priceMonthly || 0;
        const maxDiscount = Math.max(
          existing.earlyAdopterDiscount || 0,
          existing.loyaltyDiscount || 0
        );
        const finalPrice = Math.round(basePrice * (1 - maxDiscount / 100) * 100);
        
        // Utwórz nowy Price w Stripe
        const priceData = {
          unit_amount: finalPrice,
          currency: CURRENCY.toLowerCase(),
          recurring: {
            interval: 'month',
            interval_count: 1
          },
          product_data: {
            name: `${newPlan.name} - Miesięczna`,
            description: newPlan.perks?.join(', ') || ''
          },
          metadata: {
            planKey: newPlan.key
          }
        };
        
        const stripePrice = await stripe.prices.create(priceData);
        
        // Update subscription w Stripe
        const stripeSub = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
        
        if (immediate) {
          // Natychmiastowy downgrade - prorated billing
          await stripe.subscriptions.update(existing.stripeSubscriptionId, {
            items: [{
              id: stripeSub.items.data[0].id,
              price: stripePrice.id
            }],
            proration_behavior: 'create_prorations',
            metadata: {
              ...stripeSub.metadata,
              planKey: newPlan.key
            }
          });
          
          existing.planKey = newPlanKey;
          existing.freeExpressLeft = newPlan.freeExpressPerMonth || 0;
          existing.stripePriceId = stripePrice.id;
          await existing.save();
          
          return res.json({
            message: 'Plan zaktualizowany natychmiast',
            subscription: existing,
            prorated: true
          });
        } else {
          // Downgrade na koniec okresu
          await stripe.subscriptions.update(existing.stripeSubscriptionId, {
            items: [{
              id: stripeSub.items.data[0].id,
              price: stripePrice.id,
              deleted: false
            }],
            proration_behavior: 'none', // Bez proracji - zmiana na koniec okresu
            billing_cycle_anchor: 'unchanged', // Zachowaj obecny billing cycle
            metadata: {
              ...stripeSub.metadata,
              planKey: newPlan.key,
              scheduledDowngrade: 'true'
            }
          });
          
          existing.scheduledDowngrade = {
            newPlanKey: newPlanKey,
            effectiveDate: existing.validUntil
          };
          await existing.save();
          
          return res.json({
            message: `Downgrade zaplanowany na ${existing.validUntil.toLocaleDateString('pl-PL')}`,
            effectiveDate: existing.validUntil,
            currentPlan: oldPlan.name,
            newPlan: newPlan.name
          });
        }
      } catch (stripeError) {
        console.error('Stripe downgrade error:', stripeError);
        return res.status(500).json({ message: 'Błąd downgrade w Stripe', error: stripeError.message });
      }
    }
    
    // Fallback - bez Stripe Subscription
    existing.scheduledDowngrade = {
      newPlanKey: newPlanKey,
      effectiveDate: existing.validUntil
    };
    await existing.save();
    
    res.json({
      message: `Downgrade zaplanowany na ${existing.validUntil.toLocaleDateString('pl-PL')}`,
      effectiveDate: existing.validUntil,
      currentPlan: oldPlan.name,
      newPlan: newPlan.name
    });
    
  } catch (error) {
    console.error('Downgrade subscription error:', error);
    res.status(500).json({ message: 'Błąd downgrade subskrypcji' });
  }
});

// GET /api/subscriptions/billing-portal - Stripe Billing Portal (zarządzanie subskrypcją)
router.get('/billing-portal', auth, async (req, res) => {
  try {
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (!existing || !existing.stripeCustomerId) {
      return res.status(404).json({ message: 'Brak aktywnej subskrypcji Stripe' });
    }
    
    if (!stripe) {
      return res.status(500).json({ message: 'Stripe nie jest skonfigurowany' });
    }
    
    if (!process.env.FRONTEND_URL) {
      console.error('⚠️ FRONTEND_URL not set, cannot send retention email');
      return;
    }
    const frontendUrl = process.env.FRONTEND_URL;
    
    // Utwórz Billing Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: existing.stripeCustomerId,
      return_url: `${frontendUrl}/account/subscriptions`
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error('Billing portal error:', error);
    res.status(500).json({ message: 'Błąd tworzenia sesji billing portal' });
  }
});

// POST /api/subscriptions/update-payment-method - Aktualizacja metody płatności
router.post('/update-payment-method', auth, async (req, res) => {
  try {
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (!existing || !existing.stripeSubscriptionId) {
      return res.status(404).json({ message: 'Brak aktywnej subskrypcji Stripe' });
    }
    
    if (!stripe) {
      return res.status(500).json({ message: 'Stripe nie jest skonfigurowany' });
    }
    
    const subscription = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
    const customerId = subscription.customer;
    
    // Utwórz Setup Intent dla aktualizacji metody płatności
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card', 'p24'],
      metadata: {
        userId: String(req.user._id),
        subscriptionId: existing.stripeSubscriptionId
      }
    });
    
    res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id
    });
  } catch (error) {
    console.error('Update payment method error:', error);
    res.status(500).json({ message: 'Błąd aktualizacji metody płatności' });
  }
});

// POST /api/subscriptions/start-trial - rozpoczęcie 7-dniowego trialu PRO
router.post('/start-trial', auth, async (req, res) => {
  try {
    const { planKey } = req.body || {};
    
    // Tylko PRO plany mogą mieć trial
    const allowedTrials = ['CLIENT_PRO', 'PROV_PRO'];
    if (!allowedTrials.includes(planKey)) {
      return res.status(400).json({ error: 'Trial dostępny tylko dla planów PRO' });
    }
    
    // Sprawdź czy użytkownik już miał trial
    const existing = await UserSubscription.findOne({ user: req.user._id });
    if (existing && existing.trialConverted) {
      return res.status(400).json({ error: 'Trial został już wykorzystany' });
    }
    
    // Sprawdź czy użytkownik ma już aktywną subskrypcję
    if (existing && existing.validUntil > new Date() && !existing.isTrial) {
      return res.status(400).json({ error: 'Masz już aktywną subskrypcję' });
    }
    
    const plan = await SubscriptionPlan.findOne({ key: planKey, active: true });
    if (!plan) return res.status(404).json({ error: 'Plan nie istnieje' });
    
    const now = new Date();
    const trialEndsAt = new Date(now);
    trialEndsAt.setDate(trialEndsAt.getDate() + 7); // 7 dni trialu
    
    if (existing) {
      // Aktualizuj istniejącą subskrypcję
      existing.planKey = planKey;
      existing.startedAt = now;
      existing.validUntil = trialEndsAt;
      existing.renews = false; // Trial nie odnawia się automatycznie
      existing.isTrial = true;
      existing.trialStartedAt = now;
      existing.trialEndsAt = trialEndsAt;
      existing.trialConverted = false;
      existing.freeExpressLeft = plan.freeExpressPerMonth || 0;
      await existing.save();
      
      return res.json({ 
        message: 'Trial PRO rozpoczęty! Ciesz się 7 dniami za darmo',
        subscription: existing,
        trialEndsAt: trialEndsAt.toISOString()
      });
    }
    
    // Utwórz nową subskrypcję trial
    const created = await UserSubscription.create({
      user: req.user._id,
      planKey: planKey,
      startedAt: now,
      validUntil: trialEndsAt,
      renews: false,
      isTrial: true,
      trialStartedAt: now,
      trialEndsAt: trialEndsAt,
      trialConverted: false,
      freeExpressLeft: plan.freeExpressPerMonth || 0
    });
    
    res.json({ 
      message: 'Trial PRO rozpoczęty! Ciesz się 7 dniami za darmo',
      subscription: created,
      trialEndsAt: trialEndsAt.toISOString()
    });
  } catch (error) {
    console.error('Error starting trial:', error);
    res.status(500).json({ error: 'Błąd rozpoczęcia trialu' });
  }
});

router.get('/me', auth, async (req, res) => {
  // Wyłącz cache dla tego endpointu
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  const sub = await UserSubscription.findOne({
    user: req.user._id,
    validUntil: { $gt: new Date() } // Tylko aktywne subskrypcje
  });
  res.json(sub || null);
});

module.exports = router;

// --- Seed plans (optional helper) ---
// POST /api/subscriptions/seed
router.post('/seed', async (_req, res) => {
	const data = [
		// Klienci
		{
			key: 'CLIENT_FREE',
			name: 'FREE (klient)',
			priceMonthly: 0,
			priceYearly: 0,
			perks: ['Podstawowy dostęp', '50 zapytań AI/mies.', 'AI Camera Assistant', 'Pilne zlecenia bezpłatne (bez limitu)'],
			feeDiscountPercent: 0,
			platformFeePercent: 15, // Wyższe platform fee dla FREE (zachęta do upgrade)
			freeExpressPerMonth: 0,
			zeroCommission: false,
		},
		{
			key: 'CLIENT_STD',
			name: 'STANDARD (klient)',
			priceMonthly: 19,
			priceYearly: 182, // 19 * 12 * 0.8 = 182.4 (20% zniżki)
			perks: ['AI nielimit', 'AI Camera Assistant (streaming, AR)', 'Pilne zlecenia bezpłatne (bez limitu)', '-10% na wyróżnionych', 'Niższe platform fee (8%)'],
			feeDiscountPercent: 10,
			platformFeePercent: 8, // Niższe platform fee dla STANDARD
			freeExpressPerMonth: 0,
			zeroCommission: false,
		},
		{
			key: 'CLIENT_PRO',
			name: 'PRO (klient)',
			priceMonthly: 49,
			priceYearly: 470, // 49 * 12 * 0.8 = 470.4 (20% zniżki)
			perks: ['AI nielimit', 'AI Camera Assistant (wszystkie funkcje)', 'Pilne zlecenia bezpłatne (bez limitu)', 'Podbicie ofert bezpłatne (bez limitu)', 'Priorytet do top wykonawców', 'Brak platform fee (0%)'],
			feeDiscountPercent: 15,
			platformFeePercent: 0, // Brak platform fee dla PRO
			freeExpressPerMonth: 0,
			zeroCommission: false,
		},
		// Usługodawcy
		{
			key: 'PROV_FREE',
			name: 'FREE (usługodawca)',
			priceMonthly: 0,
			priceYearly: 0,
			perks: ['Odpowiedzi: 10/mies.', 'Profil podstawowy'],
			platformFeePercent: 15, // Wyższe platform fee dla FREE
			providerOffersLimit: 10,
			providerTier: 'basic',
		},
		{
			key: 'PROV_STD',
			name: 'STANDARD (usługodawca)',
			priceMonthly: 49,
			priceYearly: 470, // 49 * 12 * 0.8 = 470.4 (20% zniżki)
			perks: ['Odpowiedzi: 50/mies.', 'Profil rozszerzony', 'Statystyki', 'AI Chat', 'Niższe platform fee (8%)'],
			platformFeePercent: 8,
			providerOffersLimit: 50,
			providerTier: 'standard',
		},
		{
			key: 'PROV_STD_PLUS',
			name: 'STANDARD+ (usługodawca)',
			priceMonthly: 79,
			priceYearly: 758, // 79 * 12 * 0.8 = 758.4 (20% zniżki)
			perks: ['Odpowiedzi: 100/mies.', 'Profil rozszerzony', 'Statystyki zaawansowane', 'AI Chat nielimitowane', 'Priorytet w wynikach (średni)', 'Platform fee: 7%'],
			platformFeePercent: 7,
			providerOffersLimit: 100,
			providerTier: 'standard',
		},
		{
			key: 'PROV_PRO',
			name: 'PRO (usługodawca)',
			priceMonthly: 99,
			priceYearly: 950, // 99 * 12 * 0.8 = 950.4 (20% zniżki)
			perks: ['Odpowiedzi: nielimitowane', 'Priorytet w wynikach', 'Zaawansowane statystyki', 'Badge Helpfli PRO', 'Raporty PDF', 'Brak platform fee (0%)'],
			platformFeePercent: 0,
			providerOffersLimit: 999999,
			providerTier: 'pro',
		},
		// Pakiety firmowe B2B - podobne do planów providerów, ale z większymi limitami i funkcjami B2B
		{
			key: 'BUSINESS_FREE',
			name: 'BUSINESS FREE',
			priceMonthly: 0,
			priceYearly: 0,
			perks: [
				'Odpowiedzi: 20/mies. (wspólna pula dla zespołu)',
				'Asystent AI: 100 zapytań/mies. (wspólna pula)',
				'Pilne zlecenia bezpłatne',
				'Zarządzanie zespołem (do 3 użytkowników)',
				'Portfel firmowy i faktury',
				'Automatyzacja workflow',
				'Role i uprawnienia',
				'Audit log',
				'Analityka zespołu',
				'Platform fee: 15%'
			],
			platformFeePercent: 15,
			providerOffersLimit: 20, // Większe niż PROV_FREE (10) - wspólna pula dla zespołu
			providerTier: 'basic',
			maxUsers: 3,
			businessFeatures: ['team_management', 'wallet', 'invoices', 'workflow', 'roles', 'audit_log', 'analytics']
		},
		{
			key: 'BUSINESS_STANDARD',
			name: 'BUSINESS STANDARD',
			priceMonthly: 149,
			priceYearly: 1430, // 149 * 12 * 0.8 = 1430.4 (20% zniżki) - droższe niż PROV_STD (49)
			perks: [
				'Odpowiedzi: 200/mies. (wspólna pula dla zespołu)',
				'Asystent AI: 1000 zapytań/mies. (wspólna pula)',
				'Pilne zlecenia bezpłatne',
				'Wszystkie funkcje z FREE',
				'Zaawansowane statystyki i analityka',
				'Priorytet w wynikach wyszukiwania',
				'Analityka wydajności zespołu',
				'Raporty i eksport danych',
				'Platform fee: 8%',
				'Do 10 użytkowników w zespole'
			],
			platformFeePercent: 8,
			providerOffersLimit: 200, // Większe niż PROV_STD (50) - wspólna pula dla zespołu
			providerTier: 'standard',
			maxUsers: 10,
			businessFeatures: ['team_management', 'wallet', 'invoices', 'workflow', 'roles', 'audit_log', 'analytics', 'advanced_stats', 'priority_ranking', 'team_performance', 'reports_export']
		},
		{
			key: 'BUSINESS_PRO',
			name: 'BUSINESS PRO',
			priceMonthly: 399,
			priceYearly: 3830, // 399 * 12 * 0.8 = 3830.4 (20% zniżki) - droższe niż PROV_PRO (149)
			perks: [
				'Odpowiedzi: nielimitowane (wspólna pula dla zespołu)',
				'Asystent AI: nielimitowane (wspólna pula)',
				'Pilne zlecenia bezpłatne',
				'Podbicie ofert bezpłatne',
				'Wszystkie funkcje z STANDARD',
				'Pełna analityka i raporty',
				'API access dla integracji',
				'White-label opcje',
				'Dedicated support 24/7',
				'Custom integrations',
				'Platform fee: 5%',
				'Do 20 użytkowników w zespole'
			],
			platformFeePercent: 5,
			providerOffersLimit: 999999, // Nielimitowane odpowiedzi
			providerTier: 'pro',
			maxUsers: 20,
			businessFeatures: ['team_management', 'wallet', 'invoices', 'workflow', 'roles', 'audit_log', 'analytics', 'advanced_stats', 'priority_ranking', 'team_performance', 'reports_export', 'api_access', 'white_label', 'custom_integrations', 'dedicated_support']
		},
	];
	await SubscriptionPlan.deleteMany({});
	const created = await SubscriptionPlan.insertMany(data);
	res.json({ ok: true, count: created.length });
});



