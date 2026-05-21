const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');

const UNLIMITED_THRESHOLD = 999999;

/**
 * Aktywna subskrypcja (w tym trial PRO) lub grace period.
 */
async function findActiveSubscription(userId) {
  const now = new Date();
  return UserSubscription.findOne({
    user: userId,
    $or: [{ validUntil: { $gt: now } }, { gracePeriodUntil: { $gt: now } }],
  }).sort({ validUntil: -1 });
}

/**
 * Limit ofert dla providera — z planu subskrypcji, nie ze starego pola User.
 */
async function getProviderOffersLimit(userId, userDoc = null) {
  const sub = await findActiveSubscription(userId);
  if (sub) {
    const plan = await SubscriptionPlan.findOne({ key: sub.planKey, active: true }).lean();
    if (plan && typeof plan.providerOffersLimit === 'number') {
      return plan.providerOffersLimit;
    }
  }
  const u = userDoc || (await User.findById(userId).select('monthlyOffersLimit').lean());
  return u?.monthlyOffersLimit ?? 10;
}

function isUnlimitedLimit(limit) {
  return limit >= UNLIMITED_THRESHOLD;
}

/**
 * Zapisuje limity i korzyści PRO na User na podstawie aktywnej subskrypcji / trialu.
 */
async function syncProviderSubscriptionLimits(userId) {
  if (!userId) return null;

  const subscription = await findActiveSubscription(userId);
  const user = await User.findById(userId);
  if (!user || user.role !== 'provider') return user;

  if (!subscription) {
    return user;
  }

  const plan = await SubscriptionPlan.findOne({ key: subscription.planKey, active: true });
  if (!plan) return user;

  if (typeof plan.providerOffersLimit === 'number') {
    user.monthlyOffersLimit = plan.providerOffersLimit;
  }
  if (plan.providerTier) {
    user.providerTier = plan.providerTier;
  }

  const isProProviderPlan = plan.key === 'PROV_PRO' || plan.providerTier === 'pro';

  if (isProProviderPlan) {
    const validUntil = subscription.validUntil;
    user.promo = user.promo || {};
    user.promo.highlightUntil = validUntil;
    user.promo.topBadgeUntil = validUntil;
    user.promo.aiTopTagUntil = validUntil;
    user.promo.rankBoostPoints = 100;
    user.promo.rankBoostUntil = validUntil;

    if (!user.badges?.includes('pro')) {
      user.badges = user.badges || [];
      user.badges.push('pro');
    }
    user.level = 'pro';
    user.providerLevel = 'pro';
    user.isTopProvider = true;
    user.hasHelpfliGuarantee = true;
  }

  await user.save();
  return user;
}

module.exports = {
  findActiveSubscription,
  getProviderOffersLimit,
  isUnlimitedLimit,
  syncProviderSubscriptionLimits,
  UNLIMITED_THRESHOLD,
};
