const mongoose = require('mongoose');

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ''));
}

function normalizeTopN(value, fallback = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function normalizeThresholdHours(value, fallback = 24) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(168, Math.max(1, Math.round(n)));
}

function sanitizeFollowupMessage(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'Dzień dobry, prosimy o krótką aktualizację oferty i dostępności terminu.';
  }
  return trimmed.slice(0, 400);
}

function isOfferQualifiedByPolicy(offer, policy = {}) {
  const provider = offer?.providerId || {};
  const providerRating = Number(provider.ratingAvg || provider.rating || 0);
  const amount = Number(offer?.amount || offer?.price || 0);
  const hasInvoice = Boolean(provider.vatInvoice);
  const hasWarranty = Boolean(offer?.hasGuarantee) || /gwaranc/i.test(String(offer?.notes || offer?.message || ''));
  const minRating = Number(policy.minRating);
  const maxBudget = Number(policy.maxBudget);
  if (Number.isFinite(minRating) && minRating > 0 && providerRating > 0 && providerRating < minRating) return false;
  if (Number.isFinite(maxBudget) && maxBudget > 0 && amount > 0 && amount > maxBudget) return false;
  if (policy.requiresInvoice && !hasInvoice) return false;
  if (policy.requiresWarranty && !hasWarranty) return false;
  return true;
}

module.exports = {
  isValidObjectId,
  normalizeTopN,
  normalizeThresholdHours,
  sanitizeFollowupMessage,
  isOfferQualifiedByPolicy
};
