const NotificationService = require('../services/NotificationService');
const pricingCfg = require('../config/pricing');
const logger = require('./logger');

function plnToLoyaltyPoints(pln) {
  const value = pricingCfg.points?.redeemValue || 0.1;
  return Math.round(Number(pln) / value);
}

let _service;
function getService() {
  if (!_service) _service = new NotificationService();
  return _service;
}

async function notifyWelcomeCredit(userId, amountPln) {
  try {
    const points = plnToLoyaltyPoints(amountPln);
    await getService().sendNotification('welcome_credit', [userId], {
      amountPln,
      points,
      linkPath: '/account/wallet',
    });
  } catch (e) {
    logger.error('[growth] notifyWelcomeCredit:', e?.message || e);
  }
}

async function notifyReferralCredit(userId, amountPln, role = 'client') {
  try {
    const points = plnToLoyaltyPoints(amountPln);
    await getService().sendNotification('referral_reward', [userId], {
      amountPln,
      points,
      role,
      linkPath: '/account?tab=referrals',
    });
  } catch (e) {
    logger.error('[growth] notifyReferralCredit:', e?.message || e);
  }
}

async function notifyProviderReferralReward(userId, proDays, freeBoosts) {
  try {
    await getService().sendNotification('referral_reward', [userId], {
      role: 'provider',
      proDays,
      freeBoosts,
      linkPath: '/account?tab=referrals',
    });
  } catch (e) {
    logger.error('[growth] notifyProviderReferralReward:', e?.message || e);
  }
}

module.exports = {
  notifyWelcomeCredit,
  notifyReferralCredit,
  notifyProviderReferralReward,
};
