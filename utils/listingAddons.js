const pricing = require('../config/offersOnlyPricing');

function clientHasFreeFastTrack(planKey) {
  return pricing.clientFreeFastTrackPlans.includes(planKey);
}

/**
 * @returns {{ totalPln, breakdown: { fastTrack, highlight, verifiedOnly }, items: string[] }}
 */
function calculateListingAddons({ fastTrack, highlight, verifiedProvidersOnly, clientPlanKey }) {
  const breakdown = {
    fastTrack: 0,
    highlight: 0,
    verifiedOnly: 0,
  };
  const items = [];

  if (fastTrack) {
    const fee = clientHasFreeFastTrack(clientPlanKey) ? 0 : pricing.fastTrackFeePln;
    breakdown.fastTrack = fee;
    if (fee > 0) items.push('fast_track');
  }
  if (highlight) {
    breakdown.highlight = pricing.listHighlightFeePln;
    if (breakdown.highlight > 0) items.push('highlight');
  }
  if (verifiedProvidersOnly) {
    breakdown.verifiedOnly = pricing.verifiedProvidersOnlyFeePln;
    if (breakdown.verifiedOnly > 0) items.push('verified_only');
  }

  const totalPln =
    breakdown.fastTrack + breakdown.highlight + breakdown.verifiedOnly;

  return { totalPln, breakdown, items };
}

async function applyListingAddonsToOrder(order, { fastTrack, highlight, verifiedProvidersOnly }) {
  const now = new Date();

  if (fastTrack) {
    order.priority = 'priority';
    order.priorityFee = 0;
    order.priorityDateTime = order.priorityDateTime || now;
  }

  if (highlight) {
    const until = new Date(now.getTime() + pricing.listHighlightHours * 60 * 60 * 1000);
    order.boostedAt = now;
    order.boostedUntil = until;
    order.lastBoostedAt = now;
    order.boostCount = (order.boostCount || 0) + 1;
    order.boostFree = false;
  }

  if (verifiedProvidersOnly) {
    order.verifiedProvidersOnly = true;
  }

  order.listingAddonsStatus = 'succeeded';
  order.listingAddonsPaidAt = now;
  await order.save();
}

function providerMeetsVerifiedFilter(user) {
  if (!user) return false;
  if (user.verified === true) return true;
  if (user.kyc?.status === 'verified') return true;
  if (Array.isArray(user.badges) && user.badges.includes('verified')) return true;
  return false;
}

module.exports = {
  calculateListingAddons,
  applyListingAddonsToOrder,
  clientHasFreeFastTrack,
  providerMeetsVerifiedFilter,
  pricing,
};
