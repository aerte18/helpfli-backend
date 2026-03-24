const router = require('express').Router();
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const Promotion = require('../models/promotion');
const User = require('../models/User');

const PLAN_CFG = {
  PROMO_24H: { priceId: process.env.STRIPE_PRICE_PROMO_24H, days: 1, points: 20 },
  TOP_7:    { priceId: process.env.STRIPE_PRICE_PROMO_TOP7, days: 7, points: 40 },
  TOP_14:   { priceId: process.env.STRIPE_PRICE_PROMO_TOP14, days: 14, points: 60 },
  TOP_31:   { priceId: process.env.STRIPE_PRICE_PROMO_TOP31, days: 31, points: 100 },
};

router.post('/checkout', auth, async (req, res) => {
  try {
    const { plan } = req.body;
    const cfg = PLAN_CFG[plan];
    if (!cfg) return res.status(400).json({ message: 'Nieprawidłowy plan' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card','p24'],
      line_items: [{ price: cfg.priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/promo-success?plan=${plan}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/promo-cancel?plan=${plan}`,
      metadata: { userId: String(req.user._id), type: 'promotion', plan },
    });

    await Promotion.create({ 
      user: req.user._id, 
      plan, 
      status: 'pending_payment', 
      stripeCheckoutSessionId: session.id 
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error('Promotion checkout error:', error);
    res.status(500).json({ message: 'Błąd podczas tworzenia promowania' });
  }
});

// Pobierz aktywne promowania użytkownika
router.get('/my', auth, async (req, res) => {
  try {
    const promotions = await Promotion.find({ 
      user: req.user._id, 
      status: 'active',
      activeTo: { $gt: new Date() }
    }).sort({ activeTo: -1 });
    
    res.json(promotions);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania promowań' });
  }
});

module.exports = router;




