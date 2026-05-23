const User = require('../models/User');
const Order = require('../models/Order');
const Referral = require('../models/Referral');
const UserSubscription = require('../models/UserSubscription');
const pricingCfg = require('../config/pricing');
const logger = require('./logger');

const WELCOME_CREDIT_PLN = 20;
const REFERRAL_CREDIT_PLN = 20;
const PROVIDER_REFERRAL_PRO_DAYS = 30;

function plnToLoyaltyPoints(pln) {
  const value = pricingCfg.points?.redeemValue || 0.1;
  return Math.round(Number(pln) / value);
}

async function grantLoyaltyCredit(userId, pln, reason) {
  const points = plnToLoyaltyPoints(pln);
  if (points <= 0) return null;
  const { grantUserPoints } = require('./userPoints');
  const granted = await grantUserPoints(userId, points, reason);
  if (!granted) return null;
  logger.info(`[growth] +${points} pts (${pln} PLN) user=${userId} reason=${reason}`);
  return { points, pln, balance: granted.balance };
}

async function countClientReleasedOrders(clientId, excludeOrderId = null) {
  const q = {
    client: clientId,
    status: { $in: ['released', 'rated', 'completed'] },
  };
  if (excludeOrderId) q._id = { $ne: excludeOrderId };
  return Order.countDocuments(q);
}

function orderQualifiesForGrowthPayment(order) {
  if (!order) return false;
  if (order.paidInSystem === true) return true;
  if (order.paymentStatus === 'succeeded') return true;
  const ext = order.externalPayment || order.pricing?.externalPayment;
  if (ext?.commissionPaid === true || ext?.status === 'paid') return true;
  return false;
}

/**
 * Bonus powitalny klienta — po pierwszym ukończonym, opłaconym zleceniu (released).
 */
async function tryGrantClientWelcomeCredit(clientId, order = null) {
  const user = await User.findById(clientId);
  if (!user || user.role !== 'client') return null;
  if (!user.firstOrderBonusEligible || user.welcomeCreditUsed) return null;
  if (order && !orderQualifiesForGrowthPayment(order)) return null;

  const amount = Number(user.welcomeCreditAmount) > 0 ? Number(user.welcomeCreditAmount) : WELCOME_CREDIT_PLN;
  const granted = await grantLoyaltyCredit(clientId, amount, 'welcome_first_order');
  if (!granted) return null;

  user.welcomeCreditUsed = true;
  user.firstOrderBonusEligible = false;
  await user.save();
  return { type: 'welcome_credit', amountPln: amount, ...granted };
}

/**
 * Referral: klient → klient — obie strony po pierwszym ukończonym zleceniu zaproszonego.
 */
async function tryGrantClientReferralRewards(referredClientId) {
  const referral = await Referral.findOne({
    referred: referredClientId,
    referredRole: 'client',
    status: { $in: ['pending', 'completed'] },
  });
  if (!referral) return null;
  if (referral.referrerReward?.welcomeCreditGranted) return null;

  const releasedCount = await Order.countDocuments({
    client: referredClientId,
    status: { $in: ['released', 'rated', 'completed'] },
  });
  if (releasedCount < 1) return null;

  const referrerGrant = await grantLoyaltyCredit(
    referral.referrer,
    REFERRAL_CREDIT_PLN,
    'referral_client_first_order_referrer'
  );
  const referredGrant = await grantLoyaltyCredit(
    referredClientId,
    REFERRAL_CREDIT_PLN,
    'referral_client_first_order_referred'
  );

  referral.status = 'rewarded';
  referral.completedAt = referral.completedAt || new Date();
  referral.referrerReward = {
    ...(referral.referrerReward || {}),
    welcomeCreditPln: REFERRAL_CREDIT_PLN,
    welcomeCreditGranted: true,
    givenAt: new Date(),
  };
  referral.referredReward = {
    ...(referral.referredReward || {}),
    welcomeCreditPln: REFERRAL_CREDIT_PLN,
    welcomeCreditGranted: true,
    givenAt: new Date(),
  };
  await referral.save();

  return { type: 'referral_client', referrerGrant, referredGrant };
}

/**
 * Referral: provider → provider — zapraszający: +30 dni PRO lub wyróżnienia po aktywacji profilu.
 */
async function tryGrantProviderReferralReward(referredProviderId) {
  const referred = await User.findById(referredProviderId);
  if (!referred?.onboardingCompleted) return null;
  const providerRoles = ['provider', 'company_owner', 'company_manager'];
  if (!providerRoles.includes(referred.role)) return null;

  const referral = await Referral.findOne({
    referred: referredProviderId,
    referredRole: { $in: ['provider', 'company_owner'] },
    status: { $in: ['pending', 'completed'] },
  });
  if (!referral) return null;
  if (referral.referrerReward?.providerReferralGranted) return null;

  const referrer = await User.findById(referral.referrer);
  if (!referrer) return null;

  const now = new Date();
  const extendMs = PROVIDER_REFERRAL_PRO_DAYS * 24 * 60 * 60 * 1000;
  let sub = await UserSubscription.findOne({ user: referrer._id });

  if (sub) {
    const baseDate =
      sub.validUntil && new Date(sub.validUntil) > now ? new Date(sub.validUntil) : now;
    sub.validUntil = new Date(baseDate.getTime() + extendMs);
    if (sub.planKey !== 'PROV_PRO') sub.planKey = 'PROV_PRO';
    await sub.save();
  } else {
    sub = await UserSubscription.create({
      user: referrer._id,
      planKey: 'PROV_PRO',
      startedAt: now,
      validUntil: new Date(now.getTime() + extendMs),
      renews: false,
      isTrial: true,
    });
  }

  referrer.freeBoostsRemaining = (referrer.freeBoostsRemaining || 0) + 5;

  referral.status = 'rewarded';
  referral.completedAt = referral.completedAt || new Date();
  referral.referrerReward = {
    ...(referral.referrerReward || {}),
    subscriptionMonths: 1,
    providerReferralGranted: true,
    proDaysAdded: PROVIDER_REFERRAL_PRO_DAYS,
    givenAt: new Date(),
  };
  await referral.save();
  await referrer.save();

  logger.info(`[growth] provider referral reward referrer=${referrer._id} referred=${referredProviderId}`);
  return { type: 'referral_provider', proDaysAdded: PROVIDER_REFERRAL_PRO_DAYS, freeBoostsAdded: 5 };
}

/**
 * Wywołaj po released / pierwszym realnym zakończeniu zlecenia (confirm-receipt, external release).
 */
async function processOrderGrowthRewards(order) {
  if (!order?.client) return { grants: [] };
  const clientId = order.client._id || order.client;
  const grants = [];

  try {
    const priorCount = await countClientReleasedOrders(clientId, order._id);
    const isFirstCompletion = priorCount === 0;

    if (isFirstCompletion && orderQualifiesForGrowthPayment(order)) {
      const welcome = await tryGrantClientWelcomeCredit(clientId, order);
      if (welcome) grants.push(welcome);

      const refClient = await tryGrantClientReferralRewards(clientId);
      if (refClient) grants.push(refClient);
    }
  } catch (e) {
    logger.error('[growth] processOrderGrowthRewards error:', e?.message || e);
  }

  return { grants };
}

/** Zasady nagród referral — do API i dokumentacji frontu. */
const REFERRAL_REWARD_RULES = {
  signup: {
    client: { referrerPoints: 50, referredPoints: 50 },
    provider: { referrerPoints: 100, referredPoints: 50 },
    note: 'Punkty trafiają od razu do portfela (1 pkt = 0,10 zł).',
  },
  clientFirstOrder: {
    creditPlnEach: REFERRAL_CREDIT_PLN,
    descriptionPln: 'Po pierwszym ukończonym zleceniu zaproszonego klienta — obie strony otrzymują kredyt w portfelu punktów.',
  },
  providerActivation: {
    proDays: PROVIDER_REFERRAL_PRO_DAYS,
    extraBoosts: 5,
    description: 'Gdy zaproszony wykonawca ukończy profil (onboarding), zapraszający dostaje +30 dni PRO (lub przedłużenie) oraz 5 darmowych wyróżnień.',
  },
  pointsRedeemValuePln: pricingCfg.points?.redeemValue || 0.1,
};

module.exports = {
  WELCOME_CREDIT_PLN,
  REFERRAL_CREDIT_PLN,
  PROVIDER_REFERRAL_PRO_DAYS,
  REFERRAL_REWARD_RULES,
  plnToLoyaltyPoints,
  grantLoyaltyCredit,
  tryGrantClientWelcomeCredit,
  tryGrantClientReferralRewards,
  tryGrantProviderReferralReward,
  processOrderGrowthRewards,
};
