// utils/rank.js
const { getFoundingRankBoost } = require('./foundingProvider');

exports.computeScore = (user) => {
  const now = new Date();
  const boostActive = user?.promo?.rankBoostUntil && new Date(user.promo.rankBoostUntil) > now;
  const boost = boostActive ? (user.promo.rankBoostPoints || 0) : 0;
  const foundingBoost = getFoundingRankBoost(user);

  const quality = (user.avgRating || 0) * 20; // 0–5 → 0–100
  const other   = user.qualityScore || 0;     // jeśli masz dodatkowy scoring
  return Math.round(0.7 * quality + 0.3 * other + boost + foundingBoost);
};



























