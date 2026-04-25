const cron = require('node-cron');
const Company = require('../models/Company');
const Order = require('../models/Order');
const Offer = require('../models/Offer');
const Notification = require('../models/Notification');
const UserSubscription = require('../models/UserSubscription');
const TelemetryService = require('../services/TelemetryService');
const logger = require('../utils/logger');
const { isCompanyProPlan } = require('../utils/companyPro');
const { isOfferQualifiedByPolicy, sanitizeFollowupMessage, normalizeThresholdHours } = require('../utils/companyProOps');

let isRunning = false;
const cronHealth = {
  scheduledSpec: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastStatus: 'never',
  lastError: null,
  lastStats: null
};

function getMemberIds(company) {
  return [
    ...(company.owner ? [String(company.owner)] : []),
    ...((company.managers || []).map((m) => String(m))),
    ...((company.providers || []).map((p) => String(p)))
  ];
}

async function isCompanyEligibleForPro(company) {
  const hasCompanyPremium = Boolean(
    company?.subscription?.isActive &&
    ['premium', 'pro'].includes(String(company?.subscription?.plan || '').toLowerCase())
  );
  if (hasCompanyPremium) return true;

  const businessSub = await UserSubscription.findOne({
    companyId: company._id,
    validUntil: { $gt: new Date() }
  }).select('planKey isBusinessPlan').lean();

  return Boolean(businessSub && businessSub.isBusinessPlan && isCompanyProPlan(businessSub.planKey));
}

async function runCompanyProAutoFollowupOnce() {
  if (isRunning) {
    logger.warn('[CRON][COMPANY_PRO] Previous auto-followup run still in progress, skipping.');
    return { skipped: true, reason: 'already_running' };
  }

  isRunning = true;
  const startedAt = Date.now();
  cronHealth.lastRunStartedAt = new Date(startedAt);
  cronHealth.lastStatus = 'running';
  cronHealth.lastError = null;
  const stats = {
    companiesScanned: 0,
    companiesEligible: 0,
    ordersScanned: 0,
    ordersBreached: 0,
    ordersTriggered: 0,
    notificationsSent: 0
  };

  try {
    const maxCompanies = Math.max(1, Math.min(200, Number(process.env.COMPANY_PRO_AUTOFOLLOWUP_MAX_COMPANIES || 50)));
    const maxOrdersPerCompany = Math.max(1, Math.min(100, Number(process.env.COMPANY_PRO_AUTOFOLLOWUP_MAX_ORDERS_PER_COMPANY || 20)));
    const lookbackDays = Math.max(1, Math.min(30, Number(process.env.COMPANY_PRO_AUTOFOLLOWUP_LOOKBACK_DAYS || 7)));
    const orderStatuses = ['open', 'collecting_offers', 'matched', 'quote'];
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const lookbackDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const companies = await Company.find({
      isActive: true,
      status: 'active',
      'procurementPolicy.autoFollowupEnabled': true
    })
      .select('_id owner managers providers procurementPolicy subscription')
      .limit(maxCompanies)
      .lean();

    stats.companiesScanned = companies.length;

    for (const company of companies) {
      const isEligible = await isCompanyEligibleForPro(company);
      if (!isEligible) continue;
      stats.companiesEligible += 1;

      const policy = company.procurementPolicy || {};
      const memberIds = getMemberIds(company);
      if (!memberIds.length) continue;

      const maxAutoPerDay = Math.max(1, Math.min(20, Number(policy.maxAutoFollowupsPerDay || 3)));
      const sentToday = await Notification.countDocuments({
        type: 'system_announcement',
        'metadata.followupType': 'company_order_followup',
        'metadata.companyId': String(company._id),
        createdAt: { $gte: dayStart }
      });
      let dailySlotsLeft = Math.max(0, maxAutoPerDay - sentToday);
      if (dailySlotsLeft <= 0) continue;

      const orders = await Order.find({
        client: { $in: memberIds },
        status: { $in: orderStatuses },
        createdAt: { $gte: lookbackDate }
      })
        .select('_id createdAt')
        .sort({ createdAt: -1 })
        .limit(maxOrdersPerCompany)
        .lean();

      stats.ordersScanned += orders.length;

      for (const order of orders) {
        if (dailySlotsLeft <= 0) break;

        const offers = await Offer.find({ orderId: order._id, status: 'sent' })
          .populate('providerId', 'rating ratingAvg vatInvoice')
          .select('_id providerId createdAt amount price hasGuarantee notes message aiQuality')
          .lean();

        const firstOfferThresholdHours = normalizeThresholdHours(policy.slaFirstOfferHours, 8);
        const qualifiedThresholdHours = normalizeThresholdHours(policy.slaThresholdHours, 24);
        const elapsedHours = Math.max(0, (Date.now() - new Date(order.createdAt).getTime()) / 36e5);
        const qualifiedOffers = offers.filter((o) => isOfferQualifiedByPolicy(o, policy));

        const firstOfferBreached = offers.length === 0 && elapsedHours >= firstOfferThresholdHours;
        const qualifiedOfferBreached = qualifiedOffers.length === 0 && elapsedHours >= qualifiedThresholdHours;
        const breached = firstOfferBreached || qualifiedOfferBreached;
        const breachType = qualifiedOfferBreached ? 'qualified_offer' : (firstOfferBreached ? 'first_offer' : null);
        if (!breached) continue;
        stats.ordersBreached += 1;

        const followupMessage = sanitizeFollowupMessage(
          'Dzień dobry, automatyczne przypomnienie: prosimy o aktualizację oferty i potwierdzenie dostępności terminu.'
        );
        const minGapMs = 12 * 60 * 60 * 1000;
        let sentForOrder = 0;
        const now = new Date();

        for (const offer of offers) {
          if (dailySlotsLeft <= 0) break;
          const providerId = offer?.providerId?._id || offer?.providerId;
          if (!providerId) continue;

          const existingRecent = await Notification.findOne({
            user: providerId,
            type: 'system_announcement',
            'metadata.followupType': 'company_order_followup',
            'metadata.orderId': String(order._id),
            createdAt: { $gte: new Date(now.getTime() - minGapMs) }
          }).lean();
          if (existingRecent) continue;

          await Notification.create({
            user: providerId,
            type: 'system_announcement',
            title: 'Auto follow-up od firmy',
            message: followupMessage,
            link: `/orders/${order._id}`,
            metadata: {
              followupType: 'company_order_followup',
              auto: true,
              source: 'cron',
              breachType,
              companyId: String(company._id),
              orderId: String(order._id),
              offerId: String(offer._id),
              sentAt: now
            }
          });

          sentForOrder += 1;
          dailySlotsLeft -= 1;
          stats.notificationsSent += 1;
        }

        if (sentForOrder > 0) {
          stats.ordersTriggered += 1;
          await TelemetryService.track('company_ai_auto_followup_sent', {
            properties: {
              companyId: String(company._id),
              orderId: String(order._id),
              notificationsSent: sentForOrder,
              offersConsidered: offers.length,
              breachType,
              triggeredBy: 'cron'
            },
            metadata: { source: 'company_pro_auto_followup_cron' }
          });
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    await TelemetryService.track('company_ai_auto_followup_cron_run', {
      properties: { ...stats, elapsedMs },
      metadata: { source: 'company_pro_auto_followup_cron' }
    });

    cronHealth.lastRunFinishedAt = new Date();
    cronHealth.lastStatus = 'ok';
    cronHealth.lastStats = { ...stats, elapsedMs };
    logger.info('[CRON][COMPANY_PRO] Auto-followup run completed', { ...stats, elapsedMs });
    return { success: true, ...stats, elapsedMs };
  } catch (error) {
    cronHealth.lastRunFinishedAt = new Date();
    cronHealth.lastStatus = 'error';
    cronHealth.lastError = error.message;
    cronHealth.lastStats = { ...stats };
    logger.error('[CRON][COMPANY_PRO] Auto-followup run failed', error);
    return { success: false, error: error.message, ...stats };
  } finally {
    isRunning = false;
  }
}

function scheduleCompanyProAutoFollowupCron() {
  const spec = process.env.COMPANY_PRO_AUTOFOLLOWUP_CRON || '*/30 * * * *';
  cronHealth.scheduledSpec = spec;
  cron.schedule(spec, async () => {
    await runCompanyProAutoFollowupOnce();
  }, { timezone: 'Europe/Warsaw' });

  logger.info(`[CRON][COMPANY_PRO] Auto-followup scheduled: ${spec}`);
}

function getCompanyProAutoFollowupCronHealth() {
  return {
    ...cronHealth,
    isRunning
  };
}

module.exports = {
  runCompanyProAutoFollowupOnce,
  scheduleCompanyProAutoFollowupCron,
  getCompanyProAutoFollowupCronHealth
};
