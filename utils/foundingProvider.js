const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const {
  grantFoundingProSubscription,
  revokeFoundingProSubscription,
} = require('./syncProviderSubscriptionLimits');
const {
  reserveFoundingProviderSlot,
  releaseFoundingProviderSlot,
} = require('./foundingProviderSlots');

const FOUNDING_PROVIDER_LIMIT = 1000;
const FOUNDING_PROVIDER_DAYS = 60;
const FOUNDING_FREE_BOOSTS = 10;
const FOUNDING_COMMISSION_DISCOUNT_PERCENT = 100;
const FOUNDING_PRIORITY_SCORE_BOOST = 20;
const FOUNDING_BADGE = 'founding_provider';

function isFoundingProviderActive(user) {
  if (!user?.foundingProvider) return false;
  const exp = user.foundingProviderExpiresAt;
  if (!exp) return true;
  return new Date(exp) > new Date();
}

function getFoundingRankBoost(user) {
  if (!isFoundingProviderActive(user)) return 0;
  const boost = Number(user.priorityScoreBoost);
  return Number.isFinite(boost) && boost > 0 ? boost : FOUNDING_PRIORITY_SCORE_BOOST;
}

function getFoundingCommissionDiscountPercent(user) {
  if (!isFoundingProviderActive(user)) return 0;
  const pct = Number(user.commissionDiscountPercent);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : FOUNDING_COMMISSION_DISCOUNT_PERCENT;
}

/** Zastosuj zniżkę prowizji founding providera na już obliczoną opłatę platformy. */
function applyFoundingCommissionToFee(platformFee, providerUser) {
  if (!platformFee || platformFee <= 0) return platformFee;
  const discountPct = getFoundingCommissionDiscountPercent(providerUser);
  if (discountPct <= 0) return platformFee;
  return Math.max(0, platformFee * (1 - discountPct / 100));
}

async function countActiveFoundingProviders() {
  const now = new Date();
  return User.countDocuments({
    foundingProvider: true,
    $or: [
      { foundingProviderExpiresAt: { $gt: now } },
      { foundingProviderExpiresAt: null },
    ],
  });
}

async function getFoundingProviderStatus() {
  const used = await countActiveFoundingProviders();
  const limit = FOUNDING_PROVIDER_LIMIT;
  const remaining = Math.max(0, limit - used);
  return {
    limit,
    used,
    remaining,
    enabled: true,
  };
}

function ensureFoundingBadgeOnUser(user) {
  if (!user.badges) user.badges = [];
  if (!user.badges.includes(FOUNDING_BADGE)) {
    user.badges.push(FOUNDING_BADGE);
  }
}

function removeFoundingBadgeIfExpired(user) {
  if (!user?.badges?.length) return;
  if (isFoundingProviderActive(user)) return;
  user.badges = user.badges.filter((b) => b !== FOUNDING_BADGE);
  user.foundingProvider = false;
}

function daysUntil(date) {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function formatBenefitDate(date) {
  if (!date) return null;
  try {
    return new Date(date).toLocaleDateString('pl-PL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return null;
  }
}

/**
 * Jedno źródło prawdy: co użytkownik ma aktywne (founding, subskrypcja, bonus klienta).
 * Zwracane w /api/auth/me i /api/growth/me — front pokazuje „za co nie płacisz i do kiedy”.
 */
function buildGrowthBenefitsSummary(user, subscription = null, foundingProgram = null) {
  if (!user) return { role: null };

  const summary = { role: user.role };

  if (user.role === 'client' || user.isClient) {
    const amount = Number(user.welcomeCreditAmount) > 0 ? Number(user.welcomeCreditAmount) : 20;
    summary.client = {
      welcomeCredit: {
        amountPln: amount,
        eligible: !!user.firstOrderBonusEligible && !user.welcomeCreditUsed,
        used: !!user.welcomeCreditUsed,
        title: 'Bonus powitalny',
        description: user.welcomeCreditUsed
          ? 'Kredyt został dodany do portfela punktów po pierwszym ukończonym zleceniu.'
          : `Po potwierdzeniu odbioru pierwszego opłaconego zlecenia w Helpfli otrzymasz ${amount} zł w portfelu punktów (200 pkt).`,
      },
    };
  }

  if (user.role === 'provider') {
    const foundingActive = isFoundingProviderActive(user);
    const subValid =
      subscription?.validUntil && new Date(subscription.validUntil) > new Date();

    summary.provider = {
      foundingProvider: foundingActive
        ? {
            active: true,
            expiresAt: user.foundingProviderExpiresAt,
            expiresAtLabel: formatBenefitDate(user.foundingProviderExpiresAt),
            daysRemaining: daysUntil(user.foundingProviderExpiresAt),
            activatedAt: user.foundingProviderActivatedAt,
            commissionDiscountPercent: getFoundingCommissionDiscountPercent(user),
            commissionLabel:
              getFoundingCommissionDiscountPercent(user) >= 100
                ? '0% prowizji platformy od zleceń w Helpfli'
                : `${getFoundingCommissionDiscountPercent(user)}% zniżki na prowizję`,
            freeBoostsRemaining: Number(user.freeBoostsRemaining) || 0,
            freeBoostsTotal: FOUNDING_FREE_BOOSTS,
            priorityBoost: getFoundingRankBoost(user),
            includedProPlan: true,
            proPlanLabel:
              'Pakiet PRO (usługodawca) — nielimitowane oferty, badge PRO, priorytet w wynikach (w cenie programu).',
            stacksWithSubscription:
              'Po zakończeniu 60 dni programu pakiet wraca na FREE, chyba że wykupisz PRO lub inny plan. Prowizja 0% i boosty obowiązują tylko w trakcie promocji.',
          }
        : {
            active: false,
            everActivated: !!user.foundingProviderEverActivated,
            canActivate:
              !user.foundingProviderEverActivated &&
              (foundingProgram?.remaining ?? 0) > 0,
            cannotActivateReason: user.foundingProviderEverActivated
              ? 'Program Pierwszego wykonawcy można aktywować tylko raz.'
              : (foundingProgram?.remaining ?? 0) <= 0
                ? 'Wyczerpano limit miejsc w programie.'
                : null,
          },
      subscription: subValid
        ? {
            planKey: subscription.planKey,
            planName: subscription.planName || subscription.planKey,
            validUntil: subscription.validUntil,
            validUntilLabel: formatBenefitDate(subscription.validUntil),
            daysRemaining: daysUntil(subscription.validUntil),
            foundingProGrant: !!subscription.foundingProGrant,
            note: subscription.foundingProGrant
              ? 'Pakiet PRO w ramach programu Pierwszy wykonawca — bez dodatkowej opłaty do końca promocji.'
              : 'Opłata za subskrypcję dotyczy pakietu (limity, widoczność). Nie zastępuje programu Pierwszy wykonawca.',
          }
        : null,
    };
  }

  return summary;
}

/**
 * Prowizja platformy przy akceptacji oferty — uwzględnia CLIENT_PRO i Founding Provider.
 */
function computeOrderPlatformFee({
  baseAmount,
  clientPlanKey = null,
  providerUser = null,
  defaultPercent = 5,
  offersOnly = false,
}) {
  if (offersOnly) {
    return {
      platformFee: 0,
      platformFeePercent: 0,
      foundingDiscountApplied: false,
      platformFeeBeforeDiscount: 0,
      foundingExpiresAt: null,
      feeExplanation: 'Zlecenie tylko z ofertami — bez prowizji w tym kroku.',
    };
  }

  let platformFeePercent = clientPlanKey === 'CLIENT_PRO' ? 0 : defaultPercent;
  let platformFee = Math.round(baseAmount * (platformFeePercent / 100));
  const beforeFounding = platformFee;
  const foundingActive = providerUser && isFoundingProviderActive(providerUser);
  const discountPct = foundingActive ? getFoundingCommissionDiscountPercent(providerUser) : 0;

  if (foundingActive && discountPct >= 100) {
    platformFeePercent = 0;
    platformFee = 0;
  } else if (foundingActive && discountPct > 0) {
    platformFee = Math.round(applyFoundingCommissionToFee(platformFee, providerUser));
    if (platformFee === 0) platformFeePercent = 0;
  }

  let feeExplanation = null;
  if (clientPlanKey === 'CLIENT_PRO') {
    feeExplanation = 'Pakiet PRO klienta — 0% prowizji od tej transakcji.';
  } else if (foundingActive && beforeFounding > 0 && platformFee === 0) {
    feeExplanation = `Pierwszy wykonawca Helpfli — 0% prowizji do ${formatBenefitDate(providerUser.foundingProviderExpiresAt) || 'końca programu'}.`;
  } else if (foundingActive && beforeFounding > platformFee) {
    feeExplanation = `Zniżka programu Pierwszy wykonawca (${discountPct}%) do ${formatBenefitDate(providerUser.foundingProviderExpiresAt) || 'końca programu'}.`;
  }

  return {
    platformFee,
    platformFeePercent,
    foundingDiscountApplied: foundingActive && beforeFounding > platformFee,
    platformFeeBeforeDiscount: beforeFounding,
    foundingExpiresAt: foundingActive ? providerUser.foundingProviderExpiresAt : null,
    feeExplanation,
  };
}

async function activateFoundingProvider(userId) {
  const user = await User.findById(userId);
  if (!user) return { ok: false, code: 'NOT_FOUND', message: 'Użytkownik nie istnieje' };
  if (user.role !== 'provider') {
    return { ok: false, code: 'NOT_PROVIDER', message: 'Status dostępny tylko dla wykonawców' };
  }
  if (isFoundingProviderActive(user)) {
    return { ok: false, code: 'ALREADY_ACTIVE', message: 'Masz już aktywny status Pierwszego wykonawcy' };
  }
  if (user.foundingProviderEverActivated) {
    return {
      ok: false,
      code: 'ALREADY_USED',
      message: 'Program Pierwszego wykonawcy można aktywować tylko raz na konto',
    };
  }

  const status = await getFoundingProviderStatus();
  if (status.remaining <= 0) {
    return { ok: false, code: 'LIMIT_REACHED', message: 'Wyczerpano limit 1000 miejsc w programie Pierwszy wykonawca' };
  }

  const slotReserved = await reserveFoundingProviderSlot(FOUNDING_PROVIDER_LIMIT);
  if (!slotReserved) {
    return { ok: false, code: 'LIMIT_REACHED', message: 'Wyczerpano limit 1000 miejsc w programie Pierwszy wykonawca' };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + FOUNDING_PROVIDER_DAYS * 24 * 60 * 60 * 1000);

  const activated = await User.findOneAndUpdate(
    {
      _id: userId,
      role: 'provider',
      foundingProviderEverActivated: { $ne: true },
      foundingProvider: { $ne: true },
    },
    {
      $set: {
        foundingProvider: true,
        foundingProviderEverActivated: true,
        foundingProviderActivatedAt: now,
        foundingProviderExpiresAt: expiresAt,
        freeBoostsRemaining: FOUNDING_FREE_BOOSTS,
        commissionDiscountPercent: FOUNDING_COMMISSION_DISCOUNT_PERCENT,
        priorityScoreBoost: FOUNDING_PRIORITY_SCORE_BOOST,
        foundingProviderReminders: {
          expiryWarn7SentAt: null,
          expiryWarn3SentAt: null,
          expiryWarn1SentAt: null,
          expiryWarn0SentAt: null,
          expiredNotifiedAt: null,
        },
      },
    },
    { new: true }
  );

  if (!activated) {
    await releaseFoundingProviderSlot();
    return {
      ok: false,
      code: 'ALREADY_USED',
      message: 'Program Pierwszego wykonawcy można aktywować tylko raz na konto',
    };
  }

  ensureFoundingBadgeOnUser(activated);
  await activated.save();

  await grantFoundingProSubscription(userId, expiresAt);

  return {
    ok: true,
    user: {
      foundingProvider: true,
      foundingProviderActivatedAt: activated.foundingProviderActivatedAt,
      foundingProviderExpiresAt: activated.foundingProviderExpiresAt,
      freeBoostsRemaining: activated.freeBoostsRemaining,
      commissionDiscountPercent: activated.commissionDiscountPercent,
      priorityScoreBoost: activated.priorityScoreBoost,
    },
    status: await getFoundingProviderStatus(),
  };
}

/** Wygasłe statusy Founding — czyści badge i flagę (idempotentne). */
async function expireFoundingProvider(user) {
  if (!user?.foundingProvider) return { expired: false };
  if (isFoundingProviderActive(user)) return { expired: false };

  removeFoundingBadgeIfExpired(user);
  user.foundingProvider = false;
  user.commissionDiscountPercent = 0;
  user.priorityScoreBoost = 0;
  await user.save();
  await revokeFoundingProSubscription(user._id);
  return { expired: true };
}

/**
 * Upewnij się, że aktywny founding ma przypisany pakiet PRO (np. po wdrożeniu integracji).
 */
async function ensureFoundingProSubscription(user) {
  if (!user?._id || !isFoundingProviderActive(user)) return null;

  const sub = await UserSubscription.findOne({ user: user._id });
  if (
    sub?.foundingProGrant &&
    sub.planKey === 'PROV_PRO' &&
    sub.validUntil &&
    new Date(sub.validUntil) >= new Date(user.foundingProviderExpiresAt)
  ) {
    return sub;
  }
  if (sub?.stripeSubscriptionId && sub.renews && sub.planKey === 'PROV_PRO') {
    return sub;
  }

  return grantFoundingProSubscription(user._id, user.foundingProviderExpiresAt);
}

/** Cron: wszystkich providerów z wygasłym founding. */
async function expireAllFoundingProviders() {
  const now = new Date();
  const users = await User.find({
    role: 'provider',
    foundingProvider: true,
    foundingProviderExpiresAt: { $lte: now },
  }).select('name email foundingProvider foundingProviderExpiresAt badges foundingProviderReminders');

  let count = 0;
  for (const u of users) {
    const r = await expireFoundingProvider(u);
    if (r.expired) count += 1;
  }
  return { expired: count };
}

/** Pola Payment dla raportów Founding (grosze nominalnej prowizji). */
function buildFoundingPaymentFields(order, platformFeeAmountGrosze = null) {
  if (!order) {
    return { platformFeeNominalAmount: 0, foundingDiscountApplied: false };
  }
  const pricing = order.pricing || {};
  let nominalPln = 0;
  if (
    pricing.platformFeeBeforeDiscount != null &&
    Number.isFinite(Number(pricing.platformFeeBeforeDiscount))
  ) {
    nominalPln = Number(pricing.platformFeeBeforeDiscount);
  } else if (platformFeeAmountGrosze != null && Number.isFinite(Number(platformFeeAmountGrosze))) {
    nominalPln = Number(platformFeeAmountGrosze) / 100;
  } else if (pricing.platformFee != null && Number.isFinite(Number(pricing.platformFee))) {
    nominalPln = Number(pricing.platformFee);
  }
  return {
    platformFeeNominalAmount: Math.round(Math.max(0, nominalPln) * 100),
    foundingDiscountApplied: !!pricing.foundingDiscountApplied,
  };
}

module.exports = {
  buildFoundingPaymentFields,
  FOUNDING_PROVIDER_LIMIT,
  FOUNDING_PROVIDER_DAYS,
  FOUNDING_FREE_BOOSTS,
  FOUNDING_BADGE,
  isFoundingProviderActive,
  getFoundingRankBoost,
  getFoundingCommissionDiscountPercent,
  applyFoundingCommissionToFee,
  getFoundingProviderStatus,
  activateFoundingProvider,
  ensureFoundingProSubscription,
  ensureFoundingBadgeOnUser,
  removeFoundingBadgeIfExpired,
  buildGrowthBenefitsSummary,
  computeOrderPlatformFee,
  formatBenefitDate,
  daysUntil,
  expireFoundingProvider,
  expireAllFoundingProviders,
};
