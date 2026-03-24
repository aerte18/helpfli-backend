const express = require('express');
const router = express.Router();
const ProSubscription = require('../models/proSubscription');
const User = require('../models/User');

// DEV-ONLY mock webhook to simulate Stripe events without signature
router.post('/webhooks/stripe/mock', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ message: 'Not allowed in production' });
  }

  try {
    const event = req.body; // expect plain JSON { type, data: { object: {...} } }
    console.log('[MOCK STRIPE] incoming event:', JSON.stringify(event));
    if (!event || !event.type) return res.status(400).json({ message: 'Invalid mock payload' });

    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {};

      if (session.metadata?.type === 'pro') {
        const userId = session.metadata.userId;
        const tier = session.metadata.tier || 'PRO_MONTHLY';
        const subId = session.subscription || 'mock_sub_123';
        const update = {
          status: 'active',
          stripeSubscriptionId: subId,
          currentPeriodEnd: new Date(Date.now() + 30*24*3600*1000),
          tier
        };
        let doc;
        try {
          // First try to find existing subscription
          const existing = await ProSubscription.findOne({ user: userId });
          if (existing) {
            doc = await ProSubscription.findByIdAndUpdate(existing._id, update, { new: true });
          } else {
            doc = await ProSubscription.create({ user: userId, ...update });
          }
        } catch (e) {
          console.log('[MOCK STRIPE] upsert failed, creating directly:', e?.message);
          try {
            doc = await ProSubscription.create({ user: userId, tier, status: 'active', stripeSubscriptionId: subId, currentPeriodEnd: new Date(Date.now() + 30*24*3600*1000) });
          } catch (e2) {
            console.log('[MOCK STRIPE] direct create failed:', e2?.message);
          }
        }
        console.log('[MOCK STRIPE] pro sub updated:', doc?._id);
        try {
          // Use direct save approach to avoid MongoDB field creation error
          const user = await User.findById(userId);
          if (user && !user.badges.includes('pro')) {
            user.badges.push('pro');
            await user.save();
            console.log('[MOCK STRIPE] user badges updated via save:', user.badges);
          }
        } catch (userError) {
          console.log('[MOCK STRIPE] user update failed:', userError?.message);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[MOCK STRIPE] error:', e);
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;


