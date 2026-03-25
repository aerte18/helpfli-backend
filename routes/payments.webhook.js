const router = require('express').Router();
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const Promotion = require('../models/promotion');
const ProSubscription = require('../models/proSubscription');
const User = require('../models/User');

// Uwaga: to używa express.raw() w server.js
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        
        // Obsługa promowania
        if (session.metadata?.type === 'promotion') {
          await activatePromotion(session);
        }
        
        // Obsługa PRO
        if (session.metadata?.type === 'pro') {
          const userId = session.metadata.userId;
          const tier = session.metadata.tier;
          const subId = session.subscription;
          await ProSubscription.findOneAndUpdate(
            { user: userId },
            { status: 'active', stripeSubscriptionId: subId, currentPeriodEnd: new Date(session.expires_at*1000) },
            { new: true }
          );
          await User.findByIdAndUpdate(userId, { $set: { 'badges.pro': true } });
        }
        
        // Obsługa płatności za zlecenia
        if (session.metadata?.type === 'order') {
          const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
          if (payment && session.payment_status === 'paid') {
            payment.status = 'paid';
            await payment.save();

            const order = await Order.findById(payment.order);
            if (order) {
              order.payment = {
                status: 'paid',
                method: session.payment_method_types?.[0] || 'card',
                intentId: session.payment_intent || null,
                protected: true, // Gwarancja Helpfli aktywna tylko dla płatności systemowych
              };
              order.status = order.status === 'awaiting_payment' ? 'paid' : order.status;
              await order.save();
            }
          }
        }
        break;
      }
      
      case 'charge.refunded': {
        const charge = event.data.object;
        const payment = await Payment.findOne({ stripePaymentIntentId: charge.payment_intent });
        if (payment) {
          payment.status = 'refunded';
          await payment.save();
          const order = await Order.findById(payment.order);
          if (order && order.payment) {
            order.payment.status = 'refunded';
            order.payment.protected = false; // po zwrocie ochrona wygasa
            await order.save();
          }
        }
        break;
      }
      
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await ProSubscription.findOneAndUpdate({ stripeSubscriptionId: sub.id }, { status: 'canceled' });
        if (sub.metadata?.userId) {
          await User.findByIdAndUpdate(sub.metadata.userId, { $set: { 'badges.pro': false } });
        }
        break;
      }
      
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).end();
  }
});

// Funkcja aktywacji promowania
async function activatePromotion(session) {
  const PLAN_CFG = {
    PROMO_24H: { days: 1, points: 20 },
    TOP_7:    { days: 7, points: 40 },
    TOP_14:   { days: 14, points: 60 },
    TOP_31:   { days: 31, points: 100 },
  };
  
  const rec = await Promotion.findOne({ stripeCheckoutSessionId: session.id });
  if (!rec) return;
  
  const cfg = PLAN_CFG[rec.plan];
  if (!cfg) return;
  
  const now = new Date();
  const to = new Date(now.getTime() + cfg.days*24*60*60*1000);
  
  rec.status = 'active';
  rec.activeFrom = now;
  rec.activeTo = to;
  rec.pointsGranted = cfg.points;
  await rec.save();

  const user = await User.findById(rec.user);
  if (user) {
    user.rankingPoints = (user.rankingPoints || 0) + cfg.points;
    user.badges = user.badges || {};
    // badge TOP na czas trwania
    user.badges.topUntil = to;
    await user.save();
  }
}

module.exports = router;
