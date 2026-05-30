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

/** Cofnij korzyści PRO na koncie providera (np. po wygaśnięciu founding PRO). */
async function resetProviderToFreeTier(userId) {
  const user = await User.findById(userId);
  if (!user || user.role !== 'provider') return user;

  const freePlan = await SubscriptionPlan.findOne({ key: 'PROV_FREE', active: true }).lean();
  user.monthlyOffersLimit = freePlan?.providerOffersLimit ?? 10;
  user.providerTier = 'basic';
  user.providerLevel = 'basic';
  user.level = user.level === 'pro' ? 'standard' : user.level;
  user.isTopProvider = false;
  user.hasHelpfliGuarantee = false;
  if (Array.isArray(user.badges)) {
    user.badges = user.badges.filter((b) => b !== 'pro');
  }
  if (user.promo) {
    user.promo.rankBoostPoints = 0;
    user.promo.rankBoostUntil = null;
    user.promo.highlightUntil = null;
    user.promo.topBadgeUntil = null;
    user.promo.aiTopTagUntil = null;
  }
  await user.save();
  return user;
}

/**
 * Pakiet PRO na czas programu Pierwszy wykonawca (60 dni).
 */
async function grantFoundingProSubscription(userId, expiresAt) {
  if (!userId || !expiresAt) return null;

  const foundingExpires = new Date(expiresAt);
  if (foundingExpires <= new Date()) return null;

  const user = await User.findById(userId);
  if (!user || user.role !== 'provider') return null;

  let sub = await UserSubscription.findOne({ user: userId });
  const now = new Date();

  // Płatny PRO ze Stripe — nie nadpisuj; founding daje tylko 0% prowizji obok
  if (sub?.stripeSubscriptionId && sub.renews && sub.planKey === 'PROV_PRO') {
    return sub;
  }

  if (sub) {
    if (sub.stripeSubscriptionId && sub.renews && sub.planKey !== 'PROV_PRO' && !sub.foundingProPreviousPlanKey) {
      sub.foundingProPreviousPlanKey = sub.planKey;
    }
    sub.planKey = 'PROV_PRO';
    sub.validUntil = foundingExpires;
    if (!sub.stripeSubscriptionId || !sub.renews) {
      sub.renews = false;
    }
    sub.foundingProGrant = true;
    sub.isTrial = true;
    sub.trialStartedAt = sub.trialStartedAt || now;
    sub.trialEndsAt = foundingExpires;
    await sub.save();
  } else {
    sub = await UserSubscription.create({
      user: userId,
      planKey: 'PROV_PRO',
      startedAt: now,
      validUntil: foundingExpires,
      renews: false,
      isTrial: true,
      trialStartedAt: now,
      trialEndsAt: foundingExpires,
      foundingProGrant: true,
    });
  }

  await syncProviderSubscriptionLimits(userId);
  return sub;
}

/**
 * Po wygaśnięciu programu Pierwszy wykonawca — cofnij PRO przyznany promocyjnie.
 */
async function revokeFoundingProSubscription(userId) {
  const sub = await UserSubscription.findOne({ user: userId });
  if (!sub?.foundingProGrant) return null;

  if (sub.trialConverted && sub.stripeSubscriptionId && sub.renews) {
    sub.foundingProGrant = false;
    sub.foundingProPreviousPlanKey = null;
    await sub.save();
    return sub;
  }

  if (sub.stripeSubscriptionId && sub.renews && sub.foundingProPreviousPlanKey) {
    sub.planKey = sub.foundingProPreviousPlanKey;
    sub.foundingProGrant = false;
    sub.foundingProPreviousPlanKey = null;
    await sub.save();
    await syncProviderSubscriptionLimits(userId);
    return sub;
  }

  const now = new Date();
  sub.planKey = 'PROV_FREE';
  sub.validUntil = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
  sub.foundingProGrant = false;
  sub.foundingProPreviousPlanKey = null;
  sub.isTrial = false;
  sub.trialEndsAt = null;
  sub.renews = false;
  await sub.save();
  await resetProviderToFreeTier(userId);
  return sub;
}

module.exports = {
  findActiveSubscription,
  getProviderOffersLimit,
  isUnlimitedLimit,
  syncProviderSubscriptionLimits,
  grantFoundingProSubscription,
  revokeFoundingProSubscription,
  resetProviderToFreeTier,
  UNLIMITED_THRESHOLD,
};
