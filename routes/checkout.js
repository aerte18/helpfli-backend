const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const PromoCode = require('../models/PromoCode');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const UserSubscription = require('../models/UserSubscription');
const User = require('../models/User');
const Order = require('../models/Order');
const { calcTotal } = require('../utils/priceCalculator');
const pricingCfg = require('../config/pricing');

async function loadSubscriptionFor(userId) {
  const sub = await UserSubscription.findOne({ user: userId });
  if (!sub) return null;
  const plan = await SubscriptionPlan.findOne({ key: sub.planKey, active: true });
  if (!plan) return null;
  return { 
    ...plan.toObject(), 
    freeExpressLeft: sub.freeExpressLeft, 
    platformFeePercent: plan.platformFeePercent || 10, // Użyj platformFeePercent z planu
    _subDoc: sub 
  };
}

router.post('/preview', auth, async (req, res) => {
  try {
    const { baseAmount, extras, promoCode, pointsToUse = 0 } = req.body || {};
    const user = await User.findById(req.user._id);
    const subscription = await loadSubscriptionFor(req.user._id);
    const promo = promoCode ? await PromoCode.findOne({ code: String(promoCode).toUpperCase(), active: true }) : null;
    
    // Pobierz tier użytkownika
    const { updateUserTier, TIER_BENEFITS } = require('../utils/gamification');
    const tierUpdate = await updateUserTier(req.user._id);
    const updatedUser = await User.findById(req.user._id).select('gamification');
    const currentTier = updatedUser.gamification?.tier || 'bronze';
    const userTier = TIER_BENEFITS[currentTier];

    const totals = calcTotal({ baseAmount, extras, subscription, promo, pointsToUse, userPoints: user.loyaltyPoints || 0, userTier });
    return res.json({ currency: pricingCfg.currency, baseAmount, ...totals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Błąd kalkulacji' });
  }
});

router.post('/finalize', auth, async (req, res) => {
  try {
    const { orderId, baseAmount, extras, promoCode, pointsToUse = 0 } = req.body || {};
    const user = await User.findById(req.user._id);
    const subscription = await loadSubscriptionFor(req.user._id);
    const promo = promoCode ? await PromoCode.findOne({ code: String(promoCode).toUpperCase(), active: true }) : null;
    
    // Pobierz zlecenie żeby sprawdzić Fast-Track
    const order = await Order.findById(orderId);
    const isFastTrack = order?.priority === 'priority' && order?.priorityFee === 0;
    
    // Jeśli Fast-Track i użytkownik ma freeExpressLeft, ustaw extras.express na true dla calcTotal
    if (isFastTrack && subscription && subscription.freeExpressLeft > 0) {
      if (!extras) extras = {};
      extras.express = true;
    }
    
    // Pobierz tier użytkownika
    const { updateUserTier, TIER_BENEFITS } = require('../utils/gamification');
    const tierUpdate = await updateUserTier(req.user._id);
    const updatedUser = await User.findById(req.user._id).select('gamification');
    const currentTier = updatedUser.gamification?.tier || 'bronze';
    const userTier = TIER_BENEFITS[currentTier];

    const totals = calcTotal({ baseAmount, extras, subscription, promo, pointsToUse, userPoints: user.loyaltyPoints || 0, userTier });

    // free express consumption - sprawdź zarówno extras?.express jak i order.priority (Fast-Track)
    let freeExpressConsumed = false;
    const isBusinessPlan = subscription?.isBusinessPlan || false;
    const useCompanyPool = subscription?.useCompanyResourcePool || false;
    
    // Sprawdź najpierw resource pool firmy (jeśli użytkownik należy do firmy i ma business plan)
    if (isBusinessPlan && useCompanyPool && (extras?.express || isFastTrack)) {
      const User = require('../models/User');
      const user = await User.findById(req.user._id).populate('company');
      if (user && user.company) {
        const { consumeCompanyResource } = require('../utils/resourcePool');
        const result = await consumeCompanyResource(req.user._id, 'fastTrack', 1);
        if (result.success) {
          freeExpressConsumed = true;
          
          // Zapisz użycie darmowego Fast-Track z puli firmowej w UsageAnalytics
          try {
            const UsageAnalytics = require('../models/UsageAnalytics');
            const now = new Date();
            const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            await UsageAnalytics.incrementUsage(req.user._id, monthKey, 'fastTrackFree', 1, false);
          } catch (analyticsError) {
            console.error('Error saving fast track usage analytics:', analyticsError);
          }
        }
      }
    }
    
    // Jeśli nie użyto z puli firmowej, sprawdź indywidualne limity
    if (!freeExpressConsumed && (extras?.express || isFastTrack) && subscription && subscription.freeExpressLeft > 0) {
      subscription._subDoc.freeExpressLeft -= 1;
      await subscription._subDoc.save();
      freeExpressConsumed = true;
      
      // Zapisz użycie darmowego Fast-Track w UsageAnalytics
      try {
        const UsageAnalytics = require('../models/UsageAnalytics');
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        await UsageAnalytics.incrementUsage(req.user._id, monthKey, 'fastTrackFree', 1, false);
      } catch (analyticsError) {
        console.error('Error saving fast track usage analytics:', analyticsError);
      }
    }

    // points use
    if (totals.pointsUsed > 0) {
      user.loyaltyPoints = Math.max(0, (user.loyaltyPoints || 0) - totals.pointsUsed);
      user.loyaltyHistory.push({ delta: -totals.pointsUsed, reason: 'redeem' });
      await user.save();
    }

    // earn points
    const earned = Math.floor(totals.total * pricingCfg.points.earnRate);
    if (earned > 0) {
      user.loyaltyPoints += earned;
      user.loyaltyHistory.push({ delta: earned, reason: 'order_completed' });
      await user.save();
    }

    if (promo) {
      promo.redemptions = (promo.redemptions || 0) + 1;
      await promo.save();
    }

    // order już został pobrany wcześniej
    if (order) {
      // Ustaw amountTotal na kwotę którą płaci klient (po zniżkach)
      // Provider otrzyma pełną kwotę (baseAmount + extrasCost - platformFee)
      // Platforma pokrywa zniżkę z punktów jako koszt marketingowy
      order.amountTotal = totals.total;
      
      order.pricing = {
        baseAmount,
        extras: { express: !!extras?.express, guarantee: !!extras?.guarantee, premiumProvider: !!extras?.premiumProvider },
        extrasCost: totals.extrasCost,
        platformFee: totals.platformFee, // PlatformFee obliczane od baseAmount (przed zniżkami z punktów)
        discountPromo: totals.discountPromo,
        discountTier: totals.discountTier || 0,
        discountPoints: totals.discountPoints, // Zniżka pokrywana przez platformę
        total: totals.total, // Kwota którą płaci klient
        originalTotal: totals.originalTotal, // Kwota przed zniżką z punktów (dla rozliczeń)
        currency: pricingCfg.currency,
        appliedPromoCode: promo?.code,
        pointsUsed: totals.pointsUsed
      };
      await order.save();
    }

    res.json({ message: 'Płatność rozliczona (mock)', totals, freeExpressConsumed, earnedPoints: earned });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Błąd finalizacji' });
  }
});

module.exports = router;






