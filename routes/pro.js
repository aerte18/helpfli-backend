const router = require('express').Router();
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const ProSubscription = require('../models/proSubscription');

const TIER_CFG = {
  PRO_MONTHLY: { priceId: process.env.STRIPE_PRICE_PRO_MONTHLY },
  PRO_YEARLY:  { priceId: process.env.STRIPE_PRICE_PRO_YEARLY },
};

router.post('/checkout', auth, async (req, res) => {
  try {
    const { tier } = req.body;
    const cfg = TIER_CFG[tier];
    if (!cfg) return res.status(400).json({ message: 'Zły tier' });

    if (!stripe) {
      // Mock mode - return mock checkout URL
      try {
        await ProSubscription.create({ 
          user: req.user._id, 
          tier, 
          status: 'incomplete' 
        });
        
        return res.json({ 
          url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/pro-success?tier=${tier}&session=mock_session_123`,
          mock: true
        });
      } catch (error) {
        console.error('PRO checkout mock error:', error);
        return res.status(500).json({ message: 'Błąd podczas tworzenia subskrypcji PRO (mock)' });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card','p24'],
      line_items: [{ price: cfg.priceId, quantity: 1 }],
      success_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/pro-success?tier=${tier}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/pro-cancel?tier=${tier}`,
      metadata: { userId: String(req.user._id), type: 'pro', tier },
    });
    
    await ProSubscription.create({ 
      user: req.user._id, 
      tier, 
      status: 'incomplete' 
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error('PRO checkout error:', error);
    console.error('PRO checkout error stack:', error.stack);
    res.status(500).json({ message: 'Błąd podczas tworzenia subskrypcji PRO' });
  }
});

// Pobierz status subskrypcji użytkownika
router.get('/my', auth, async (req, res) => {
  try {
    const subscription = await ProSubscription.findOne({ 
      user: req.user._id, 
      status: { $in: ['active', 'past_due'] }
    });
    
    res.json(subscription || null);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania subskrypcji' });
  }
});

// DEV: prosty debug bieżącej subskrypcji (admin lub dev only)
router.get('/debug', auth, async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ message: 'Not allowed in production' });
  const doc = await ProSubscription.findOne({ user: req.user._id }).lean();
  res.json(doc || null);
});

module.exports = router;
