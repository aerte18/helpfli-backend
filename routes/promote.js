?const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const { authMiddleware } = require('../middleware/authMiddleware');
const { requireKycVerified } = require('../middleware/kyc');

const PromotionPlan = require('../models/promotionPlan');
const PromotionPurchase = require('../models/promotionPurchase');
const Payment = require('../models/Payment');
const User = require('../models/User');

const CURRENCY = process.env.CURRENCY || 'pln';

// GET /api/promote/plans – lista pakietów
router.get('/plans', async (req, res) => {
  try {
    const plans = await PromotionPlan.find({}).sort({ price: 1 });
    res.json({ items: plans });
  } catch (e) {
    console.error('Get plans error:', e);
    res.status(500).json({ message: 'Błąd pobierania planów' });
  }
});

// GET /api/promote/me/status – aktywne badge + punkty
router.get('/me/status', authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select('rankingPoints badges role kyc');
    const now = new Date();
    const status = {
      highlightActive: me?.badges?.highlightUntil && me.badges.highlightUntil > now,
      topActive: me?.badges?.topUntil && me.badges.topUntil > now,
      aiActive: me?.badges?.aiRecommendedUntil && me.badges.aiRecommendedUntil > now,
      rankingPoints: me?.rankingPoints || 0,
      badges: me?.badges || {},
      kyc: me?.kyc || {},
    };
    res.json(status);
  } catch (e) {
    console.error('Get status error:', e);
    res.status(500).json({ message: 'Błąd pobierania statusu' });
  }
});

// POST /api/promote/create-intent – zakup/odnowienie planu
// body: { planId, couponCode?, requestInvoice? }
router.post('/create-intent', authMiddleware, requireKycVerified, async (req, res) => {
  try {
    const { planId, couponCode, requestInvoice = false } = req.body || {};
    const provider = await User.findById(req.user._id);
    if (provider.role !== 'provider') return res.status(403).json({ message: 'Tylko wykonawca' });

    const plan = await PromotionPlan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan nie istnieje' });

    let amount = plan.price;
    let appliedCouponId = null;

    // Opcjonalny kupon Helpfli (nie Stripe promotion codes)
    if (couponCode) {
      try {
        const Coupon = require('../models/Coupon');
        const now = new Date();
        const c = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });
        const okDate = c && (!c.validFrom || c.validFrom <= now) && (!c.validTo || c.validTo >= now);
        const okUses = c && (!c.maxUses || c.used < c.maxUses);
        const okProd = c && (!c.products?.length || c.products.includes(plan.code) || c.products.includes(plan.code.toLowerCase()));

        if (c && okDate && okUses && okProd) {
          if (c.type === 'percent') amount = Math.max(0, Math.round(amount * (100 - c.value) / 100));
          if (c.type === 'amount')  amount = Math.max(0, amount - c.value);
          appliedCouponId = c._id;
        }
      } catch (e) {
        console.error('PROMO_COUPON_ERROR:', e);
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: CURRENCY,
      payment_method_types: ['card','p24','blik'],
      description: `Helpfli Promo: ${plan.name}`,
      metadata: {
        type: 'promotion',
        planId: String(plan._id),
        providerId: String(provider._id),
        amount: String(amount),
        appliedCouponId: appliedCouponId ? String(appliedCouponId) : '',
      },
      statement_descriptor: 'HELPFLI PROMO',
    });

    // Wstępny zapis zakupu + płatności (pending)
    const purchase = await PromotionPurchase.create({
      provider: provider._id,
      plan: plan._id,
      stripePaymentIntentId: intent.id,
      status: 'pending',
      amount,
      currency: CURRENCY,
    });

    const payment = await Payment.create({
      purpose: 'promotion',
      promotionPlan: plan._id,
      promotionPurchase: purchase._id,
      provider: provider._id,
      client: provider._id, // sam dla siebie (płatnikiem jest provider)
      providerName: provider.name,
      clientName: provider.name,
      stripePaymentIntentId: intent.id,
      amount,
      currency: CURRENCY,
      method: 'unknown',
      status: intent.status,
      platformFeePercent: 0, // brak prowizji platformy przy prostym wariancie
      platformFeeAmount: 0,
      metadata: intent.metadata,
    });

    res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id, purchaseId: purchase._id });
  } catch (e) {
    console.error('Create intent error:', e);
    res.status(500).json({ message: 'Błąd tworzenia płatności' });
  }
});

// GET /api/promote/me/purchases – historia
router.get('/me/purchases', authMiddleware, async (req, res) => {
  try {
    const items = await PromotionPurchase.find({ provider: req.user._id })
      .populate('plan')
      .sort({ createdAt: -1 });
    res.json({ items });
  } catch (e) {
    console.error('Get purchases error:', e);
    res.status(500).json({ message: 'Błąd pobierania historii' });
  }
});

module.exports = router;
