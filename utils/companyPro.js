const User = require('../models/User');
const Company = require('../models/Company');
const UserSubscription = require('../models/UserSubscription');

function isCompanyProPlan(planKey = '') {
  const key = String(planKey || '').toUpperCase();
  return key.includes('BIZ_PRO') || key.includes('COMPANY_PRO') || key.includes('BUSINESS_PRO') || key.includes('PRO');
}

function normalizeProcurementPolicy(policy = {}) {
  const minRating = Number(policy.minRating);
  const maxBudget = Number(policy.maxBudget);
  const slaFirstOfferHours = Number(policy.slaFirstOfferHours);
  const slaThresholdHours = Number(policy.slaThresholdHours);
  const maxAutoFollowupsPerDay = Number(policy.maxAutoFollowupsPerDay);
  return {
    minRating: Number.isFinite(minRating) && minRating >= 0 && minRating <= 5 ? minRating : null,
    maxBudget: Number.isFinite(maxBudget) && maxBudget > 0 ? Math.round(maxBudget) : null,
    requiresWarranty: Boolean(policy.requiresWarranty),
    requiresInvoice: Boolean(policy.requiresInvoice),
    formalTone: policy.formalTone !== false,
    slaFirstOfferHours: Number.isFinite(slaFirstOfferHours) ? Math.min(168, Math.max(1, Math.round(slaFirstOfferHours))) : 8,
    slaThresholdHours: Number.isFinite(slaThresholdHours) ? Math.min(168, Math.max(1, Math.round(slaThresholdHours))) : 24,
    autoFollowupEnabled: Boolean(policy.autoFollowupEnabled),
    maxAutoFollowupsPerDay: Number.isFinite(maxAutoFollowupsPerDay) ? Math.min(20, Math.max(1, Math.round(maxAutoFollowupsPerDay))) : 3
  };
}

async function getCompanyProContext(userId) {
  const user = await User.findById(userId).select('role roleInCompany company').lean();
  if (!user?.company) return { eligible: false, reason: 'no_company' };

  const [company, subscription] = await Promise.all([
    Company.findById(user.company).select('subscription procurementPolicy status').lean(),
    UserSubscription.findOne({
      user: userId,
      validUntil: { $gt: new Date() }
    }).select('planKey isBusinessPlan companyId validUntil').lean()
  ]);
  if (!company || company.status === 'suspended' || company.status === 'rejected') {
    return { eligible: false, reason: 'company_inactive' };
  }

  const hasCompanyPremium = company?.subscription?.isActive && ['premium', 'pro'].includes(String(company?.subscription?.plan || '').toLowerCase());
  const hasBusinessProSub = Boolean(subscription && (subscription.isBusinessPlan || String(subscription.companyId || '') === String(user.company)) && isCompanyProPlan(subscription.planKey));
  const eligible = Boolean(hasCompanyPremium || hasBusinessProSub);

  return {
    eligible,
    companyId: String(user.company),
    reason: eligible ? 'ok' : 'missing_pro_plan',
    procurementPolicy: normalizeProcurementPolicy(company?.procurementPolicy || {}),
    source: hasBusinessProSub ? 'user_subscription' : (hasCompanyPremium ? 'company_subscription' : 'none')
  };
}

module.exports = {
  isCompanyProPlan,
  normalizeProcurementPolicy,
  getCompanyProContext
};
