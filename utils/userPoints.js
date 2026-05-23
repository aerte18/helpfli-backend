const User = require('../models/User');
const PointTransaction = require('../models/PointTransaction');
const pricingCfg = require('../config/pricing');

const POINT_REASON_LABELS = {
  welcome_first_order: 'Bonus powitalny',
  referral_signup: 'Polecenie — rejestracja',
  referral_signup_client: 'Polecenie — rejestracja (klient)',
  referral_signup_provider: 'Polecenie — rejestracja (wykonawca)',
  referral_client_first_order_referrer: 'Polecenie — pierwsze zlecenie (Ty)',
  referral_client_first_order_referred: 'Polecenie — pierwsze zlecenie',
  redeem: 'Wykorzystanie punktów',
  manual_redeem: 'Wykorzystanie punktów',
  order_completed: 'Punkty za zlecenie',
};

function formatPointReason(reason) {
  if (!reason) return 'Punkty';
  return POINT_REASON_LABELS[reason] || reason.replace(/_/g, ' ');
}

function pointsRedeemValuePln() {
  return pricingCfg.points?.redeemValue || 0.1;
}

function pointsToPln(points) {
  return Math.round(Number(points) * pointsRedeemValuePln() * 100) / 100;
}

/**
 * Jednolity ledger: loyaltyPoints + lustro w PointTransaction (gamifikacja / historia API).
 */
async function grantUserPoints(userId, delta, reason) {
  const n = Number(delta);
  if (!userId || !Number.isFinite(n) || n === 0) return null;

  const user = await User.findById(userId);
  if (!user) return null;

  user.loyaltyPoints = (user.loyaltyPoints || 0) + n;
  user.loyaltyHistory = user.loyaltyHistory || [];
  user.loyaltyHistory.push({ delta: n, reason, ts: new Date() });
  await user.save();

  const balanceAfter = user.loyaltyPoints;
  await PointTransaction.create({
    user: userId,
    delta: n,
    reason,
    balanceAfter,
  });

  return { points: n, balance: balanceAfter, pln: pointsToPln(balanceAfter) };
}

/** Synchronizuj legacy saldo PointTransaction → loyaltyPoints (jednorazowo przy odczycie). */
async function syncLegacyPointsBalance(userId) {
  const user = await User.findById(userId).select('loyaltyPoints');
  if (!user) return 0;

  const lastTx = await PointTransaction.findOne({ user: userId }).sort({ createdAt: -1 });
  const ptBal = lastTx?.balanceAfter ?? 0;
  const loyaltyBal = user.loyaltyPoints || 0;

  if (ptBal > loyaltyBal) {
    user.loyaltyPoints = ptBal;
    await user.save();
    return ptBal;
  }
  return loyaltyBal;
}

async function getUnifiedPointsBalance(userId) {
  await syncLegacyPointsBalance(userId);
  const user = await User.findById(userId).select('loyaltyPoints');
  return user?.loyaltyPoints || 0;
}

module.exports = {
  POINT_REASON_LABELS,
  formatPointReason,
  pointsRedeemValuePln,
  pointsToPln,
  grantUserPoints,
  syncLegacyPointsBalance,
  getUnifiedPointsBalance,
};
