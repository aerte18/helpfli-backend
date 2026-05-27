const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const UsageAnalytics = require('../models/UsageAnalytics');
const { consumeGuestQuery, checkGuestQuery, REGISTERED_FREE_HINT } = require('./guestAiTrial');

const CLIENT_FREE_MONTHLY = Math.max(1, parseInt(process.env.CLIENT_FREE_AI_MONTHLY_LIMIT || '50', 10));

function isClientRole(role) {
  return role === 'client' || role === 'user';
}

async function enforceClientAiAccess(req, { consume = true, sessionId = null } = {}) {
  if (req.guest?.id) {
    return consume
      ? consumeGuestQuery(req.guest.id, req.ip, sessionId)
      : checkGuestQuery(req.guest.id, req.ip);
  }

  if (!req.user) {
    return {
      allowed: false,
      status: 401,
      body: {
        code: 'AUTH_REQUIRED',
        message: 'Zaloguj się lub kontynuuj jako gość (nagłówek X-Guest-Id).',
        requiresAuth: true,
      },
    };
  }

  const role = req.user.role;
  if (!isClientRole(role)) {
    return { allowed: true, usage: { mode: 'authenticated', role } };
  }

  const userId = req.user._id || req.user.id;
  const subscription = await UserSubscription.findOne({
    user: userId,
    validUntil: { $gt: new Date() },
  }).lean();

  const packageType = subscription?.planKey || 'CLIENT_FREE';
  const isFree = packageType === 'CLIENT_FREE';
  const isBusinessPlan = subscription?.isBusinessPlan || false;
  const useCompanyPool = subscription?.useCompanyResourcePool || false;

  if (isBusinessPlan && useCompanyPool) {
    const user = await User.findById(userId).populate('company').select('company role');
    if (user?.company) {
      const { canUseCompanyResource, consumeCompanyResource } = require('./resourcePool');
      const check = await canUseCompanyResource(userId, 'aiQueries', 1);
      if (!check.allowed) {
        return {
          allowed: false,
          status: 403,
          body: {
            message: check.reason,
            requiresPayment: false,
            upgradeRequired: true,
            upgradePlan: 'BUSINESS_PRO',
          },
        };
      }
      if (consume) {
        await consumeCompanyResource(userId, 'aiQueries', 1);
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        await UsageAnalytics.incrementUsage(userId, monthKey, 'aiQueries', 1, false).catch(() => {});
      }
      return { allowed: true, usage: { mode: 'company_pool' } };
    }
  }

  if (!isFree) {
    if (consume) {
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await UsageAnalytics.incrementUsage(userId, monthKey, 'aiQueries', 1, false).catch(() => {});
    }
    return {
      allowed: true,
      usage: { mode: 'subscription', planKey: packageType, limit: Infinity },
    };
  }

  const currentMonth = new Date();
  currentMonth.setDate(1);
  currentMonth.setHours(0, 0, 0, 0);

  const aiUsage = await User.findOne({ _id: userId }).select('aiConciergeUsage').lean();
  const monthlyUsage =
    aiUsage?.aiConciergeUsage?.filter((u) => new Date(u.date) >= currentMonth) || [];

  if (consume) {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await UsageAnalytics.incrementUsage(userId, monthKey, 'aiQueries', 1, false).catch(() => {});
  }

  if (monthlyUsage.length >= CLIENT_FREE_MONTHLY) {
    const { payPerUse } = req.body || {};
    if (payPerUse === true) {
      if (consume) {
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        await UsageAnalytics.incrementUsage(userId, monthKey, 'aiQueries', 1, true).catch(() => {});
      }
      return { allowed: true, usage: { mode: 'pay_per_use' }, payPerUse: true };
    }
    return {
      allowed: false,
      status: 403,
      body: {
        message: `Przekroczono limit ${CLIENT_FREE_MONTHLY} zapytań do AI Concierge miesięcznie. Ulepsz pakiet lub zapłać za dodatkowe zapytania.`,
        limit: CLIENT_FREE_MONTHLY,
        used: monthlyUsage.length,
        planKey: packageType,
        payPerUseAvailable: true,
        payPerUsePrice: 0.5,
        upsell: {
          recommendedPlanKey: 'CLIENT_STD',
          title: 'STANDARD – nielimitowane AI Concierge',
          description: 'Kontynuuj rozmowę z AI bez limitów i szybciej znajduj najlepszych wykonawców.',
        },
      },
    };
  }

  return {
    allowed: true,
    usage: {
      mode: 'client_free',
      limit: CLIENT_FREE_MONTHLY,
      used: monthlyUsage.length + (consume ? 1 : 0),
      remaining: Math.max(0, CLIENT_FREE_MONTHLY - monthlyUsage.length - (consume ? 1 : 0)),
      registeredFreeLimit: REGISTERED_FREE_HINT,
    },
  };
}

module.exports = {
  CLIENT_FREE_MONTHLY,
  enforceClientAiAccess,
};
