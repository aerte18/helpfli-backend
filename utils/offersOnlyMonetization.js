const pricing = require('../config/offersOnlyPricing');
const { getServiceMetaBySlug, normalizeSlug } = require('./serviceMeta');

async function resolveOfferSlotCost({ order, serviceSlug, providerPlanKey } = {}) {
  if (!order || order.orderMode !== 'offers_only') {
    return { slots: 1, tier: 'quick', reason: 'standard_order' };
  }

  const slug = normalizeSlug(serviceSlug || order.service);
  const meta = await getServiceMetaBySlug(slug);
  const tier = meta?.tier || 'quick';

  let slots = 1;
  if (tier === 'large') slots = 2;

  const slugLower = slug.toLowerCase();
  const isExtraLarge = pricing.extraLargeSlugPatterns.some((p) => slugLower.includes(p));
  if (isExtraLarge) slots = 3;

  const maxBudget = Number(meta?.base_price_max) || 0;
  if (maxBudget >= 400000) slots = Math.max(slots, 3);
  else if (maxBudget >= 150000) slots = Math.max(slots, 2);

  if (pricing.providerReducedSlotPlans.includes(providerPlanKey)) {
    slots = Math.min(slots, 1);
  }

  return { slots, tier, meta, reason: isExtraLarge ? 'extra_large_project' : tier };
}

function clientHasFreeContactUnlock(planKey) {
  return pricing.clientFreeContactUnlockPlans.includes(planKey);
}

function getContactUnlockFeePln(planKey) {
  if (clientHasFreeContactUnlock(planKey)) return 0;
  return pricing.contactUnlockFeePln;
}

function isContactUnlocked(order) {
  if (!order || order.orderMode !== 'offers_only') return true;
  if (order.contactUnlockedAt) return true;
  const st = order.contactUnlockStatus;
  return st === 'succeeded' || st === 'waived';
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 3) {
    return `*** *** ${digits.slice(-3)}`;
  }
  return '***';
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const [user, domain] = email.split('@');
  if (!domain) return '***@***';
  const u = user.length <= 2 ? '*' : `${user[0]}***`;
  return `${u}@${domain}`;
}

/**
 * Ukrywa dane kontaktowe do czasu opłaty (lub PRO klienta).
 */
function applyContactMasking(order, { viewerId, isOwner, isAssignedProvider } = {}) {
  if (!order || order.orderMode !== 'offers_only') return order;
  if (isContactUnlocked(order)) {
    order.contactLocked = false;
    order.contactUnlockFeePln = getContactUnlockFeePln(null);
    return order;
  }

  order.contactLocked = true;
  order.contactUnlockRequired = true;
  order.contactUnlockFeePln = pricing.contactUnlockFeePln;

  const maskUser = (u) => {
    if (!u || typeof u !== 'object') return u;
    return {
      ...u,
      phone: maskPhone(u.phone),
      email: maskEmail(u.email),
      phoneLocked: true,
      emailLocked: true,
    };
  };

  if (order.client) order.client = maskUser(order.client);
  if (order.provider) order.provider = maskUser(order.provider);

  if (Array.isArray(order.offers)) {
    order.offers = order.offers.map((o) => ({
      ...o,
      providerId: o.providerId && typeof o.providerId === 'object'
        ? maskUser(o.providerId)
        : o.providerId,
    }));
  }

  return order;
}

module.exports = {
  resolveOfferSlotCost,
  clientHasFreeContactUnlock,
  getContactUnlockFeePln,
  isContactUnlocked,
  applyContactMasking,
  maskPhone,
  maskEmail,
  pricing,
};
