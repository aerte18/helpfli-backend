const SubscriptionPlan = require('../models/SubscriptionPlan');
const UserSubscription = require('../models/UserSubscription');

async function resetMonthlyExpress() {
  const now = new Date();
  const activeSubs = await UserSubscription.find({ validUntil: { $gt: now } });
  const plans = await SubscriptionPlan.find({});
  const planMap = new Map(plans.map(p => [p.key, p]));

  for (const sub of activeSubs) {
    const plan = planMap.get(sub.planKey);
    if (!plan) continue;
    
    // Reset Fast-Track
    const targetExpress = plan.freeExpressPerMonth || 0;
    if (sub.freeExpressLeft !== targetExpress) {
      sub.freeExpressLeft = targetExpress;
    }
    
    // Reset boostów (co miesiąc)
    const targetBoosts = plan.freeBoostsPerMonth || 0;
    const resetDate = sub.freeOrderBoostsResetDate;
    const needsReset = !resetDate || 
      resetDate.getMonth() !== now.getMonth() || 
      resetDate.getFullYear() !== now.getFullYear();
    
    if (needsReset && targetBoosts > 0) {
      sub.freeOrderBoostsLimit = targetBoosts;
      sub.freeOrderBoostsLeft = targetBoosts;
      sub.freeOrderBoostsResetDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    await sub.save();
  }
}

// Aktualizuj loyaltyMonths dla wszystkich aktywnych subskrypcji
async function updateLoyaltyMonths() {
  const now = new Date();
  const activeSubs = await UserSubscription.find({ validUntil: { $gt: now } });

  for (const sub of activeSubs) {
    const monthsDiff = Math.floor((now - sub.startedAt) / (1000 * 60 * 60 * 24 * 30));
    
    // Oblicz zniżkę lojalnościową
    let loyaltyDiscount = 0;
    if (monthsDiff >= 24) {
      loyaltyDiscount = 15;
    } else if (monthsDiff >= 12) {
      loyaltyDiscount = 10;
    } else if (monthsDiff >= 6) {
      loyaltyDiscount = 5;
    }

    // Aktualizuj tylko jeśli się zmieniło
    if (sub.loyaltyMonths !== monthsDiff || sub.loyaltyDiscount !== loyaltyDiscount) {
      sub.loyaltyMonths = monthsDiff;
      sub.loyaltyDiscount = loyaltyDiscount;
      await sub.save();
    }
  }
}

// Grace period i automatyczny downgrade wygasłych subskrypcji
async function handleExpiredSubscriptions() {
  const now = new Date();
  const SubscriptionPlan = require('../models/SubscriptionPlan');
  
  // Znajdź subskrypcje które wygasły więcej niż 7 dni temu (koniec grace period)
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const expiredSubs = await UserSubscription.find({
    validUntil: { $lt: sevenDaysAgo },
    planKey: { $ne: 'CLIENT_FREE' }, // Nie downgrade'uj już FREE
    'gracePeriodUntil': null // Jeszcze nie przetworzone
  });
  
  for (const sub of expiredSubs) {
    // Ustaw grace period (jeśli jeszcze nie ustawiony)
    if (!sub.gracePeriodUntil) {
      const graceUntil = new Date(sub.validUntil);
      graceUntil.setDate(graceUntil.getDate() + 7);
      sub.gracePeriodUntil = graceUntil;
      await sub.save();
      continue;
    }
    
    // Jeśli grace period minął - downgrade do FREE
    if (sub.gracePeriodUntil < now) {
      const freePlan = await SubscriptionPlan.findOne({ key: sub.user.role === 'provider' ? 'PROV_FREE' : 'CLIENT_FREE' });
      if (freePlan) {
        sub.planKey = freePlan.key;
        sub.freeExpressLeft = 0;
        sub.gracePeriodUntil = null;
        await sub.save();
      }
    }
  }
  
  // Obsłuż scheduled downgrades
  const subsWithDowngrade = await UserSubscription.find({
    'scheduledDowngrade.effectiveDate': { $lte: now },
    'scheduledDowngrade.newPlanKey': { $exists: true, $ne: null }
  });
  
  for (const sub of subsWithDowngrade) {
    const newPlan = await SubscriptionPlan.findOne({ key: sub.scheduledDowngrade.newPlanKey });
    if (newPlan) {
      sub.planKey = newPlan.key;
      sub.freeExpressLeft = newPlan.freeExpressPerMonth || 0;
      sub.scheduledDowngrade = null;
      await sub.save();
    }
  }
}

module.exports = { resetMonthlyExpress, updateLoyaltyMonths, handleExpiredSubscriptions };







