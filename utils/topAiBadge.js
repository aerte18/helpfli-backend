const User = require("../models/User");
const Order = require("../models/Order");
const Rating = require("../models/Rating");

const TOP_AI_RULES = {
  minRating: 4.7,
  minRatingCount: 20,
  maxResponseTimeMin: 20,
  minAcceptanceRate: 0.40, // 40%
  minOnTimeRate: 0.90,     // 90%
};

async function getStats(providerId) {
  // rating
  const rAgg = await Rating.aggregate([
    { $match: { to: providerId } },
    { $group: { _id: "$to", avg: { $avg: "$rating" }, cnt: { $sum: 1 } } }
  ]);
  const ratingAvg = rAgg?.[0]?.avg || 0;
  const ratingCount = rAgg?.[0]?.cnt || 0;

  // acceptance rate (przybliżenie)
  const accepted = await Order.countDocuments({ provider: providerId, status: { $in: ["accepted","in_progress","completed","done","closed"] } });
  const received = Math.max(accepted + 5, 15); // heurystyka (dopóki nie liczysz realnych zaproszeń)
  const acceptanceRate = received ? (accepted / received) : 0;

  // on-time rate
  const completed = await Order.countDocuments({ provider: providerId, status: { $in: ["completed","done","closed"] } });
  const onTime = await Order.countDocuments({ provider: providerId, status: { $in: ["completed","done","closed"] }, deliveredOnTime: true }).catch(()=>0);
  const onTimeRate = completed ? (onTime / completed) : 0;

  // response time
  const user = await User.findById(providerId).lean();
  const responseTimeMin = user?.meta?.responseTimeMin ?? 30;

  return { ratingAvg, ratingCount, acceptanceRate, onTimeRate, responseTimeMin };
}

async function recomputeTopAiBadge(providerId) {
  const stats = await getStats(providerId);
  const meets =
    stats.ratingAvg >= TOP_AI_RULES.minRating &&
    stats.ratingCount >= TOP_AI_RULES.minRatingCount &&
    stats.responseTimeMin <= TOP_AI_RULES.maxResponseTimeMin &&
    stats.acceptanceRate >= TOP_AI_RULES.minAcceptanceRate &&
    stats.onTimeRate >= TOP_AI_RULES.minOnTimeRate;

  const user = await User.findById(providerId);
  if (!user) return { updated:false, stats, hasBadge:false };

  const hasBadge = Array.isArray(user.badges) && user.badges.includes("top_ai");
  if (meets && !hasBadge) {
    user.badges = Array.from(new Set([...(user.badges || []), "top_ai"]));
    await user.save();
    return { updated: true, stats, hasBadge: true };
  } else if (!meets && hasBadge) {
    // (opcjonalnie) zdejmuj badge, jeśli spada jakość
    user.badges = (user.badges || []).filter(b => b !== "top_ai");
    await user.save();
    return { updated: true, stats, hasBadge: false };
  } else {
    return { updated:false, stats, hasBadge };
  }
}

module.exports = { TOP_AI_RULES, recomputeTopAiBadge };
