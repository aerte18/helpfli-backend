const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const UserSubscription = require('../models/UserSubscription');
const Coupon = require('../models/Coupon');
const Event = require('../models/Event');
const Offer = require('../models/Offer');
const TelemetryService = require('../services/TelemetryService');
const AIAnalytics = require('../models/AIAnalytics');

function dateOnly(d) { return dayjs(d).format('YYYY-MM-DD'); }

function computeConversionRates(funnelRows) {
  const m = {};
  for (const r of funnelRows || []) {
    if (r && r._id) m[String(r._id)] = r.count || 0;
  }
  const pv = m.page_view || 0;
  const search = m.search || 0;
  const prv = m.provider_view || 0;
  const qreq = m.quote_request || 0;
  const ofs = m.order_form_success || 0;
  return {
    counts: m,
    rates: {
      searchPerPageView: pv ? Number((search / pv).toFixed(4)) : null,
      providerViewPerSearch: search ? Number((prv / search).toFixed(4)) : null,
      quotePerProviderView: prv ? Number((qreq / prv).toFixed(4)) : null,
      orderSuccessPerPageView: pv ? Number((ofs / pv).toFixed(4)) : null
    }
  };
}

function pctDelta(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

// GET /api/admin/analytics/summary?from=2025-08-01&to=2025-09-03
router.get('/summary', authMiddleware, requireRole('admin'), async (req, res) => {
  const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
  const to = req.query.to ? dayjs(req.query.to) : dayjs();
  const start = from.startOf('day').toDate();
  const end = to.endOf('day').toDate();
  const periodDays = Math.max(1, to.diff(from, 'day') + 1);
  const prevTo = from.subtract(1, 'day').endOf('day');
  const prevFrom = prevTo.subtract(periodDays - 1, 'day').startOf('day');
  const prevStart = prevFrom.toDate();
  const prevEnd = prevTo.toDate();

  const [ordersAll, ordersPaid, revenueAgg, providersCount, providersVerified, clientsCount] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: start, $lte: end } }),
    Order.countDocuments({ createdAt: { $gte: start, $lte: end }, paidInSystem: true, paymentStatus: 'succeeded' }),
    Order.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, paidInSystem: true, paymentStatus: 'succeeded' } },
      { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
    ]),
    User.countDocuments({ role: 'provider' }),
    User.countDocuments({ role: 'provider', 'kyc.status': 'verified' }),
    User.countDocuments({ role: 'client' }),
  ]);

  const revenue = (revenueAgg[0]?.sum || 0);

  const [prevOrdersAll, prevOrdersPaid, prevRevenueAgg] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: prevStart, $lte: prevEnd } }),
    Order.countDocuments({ createdAt: { $gte: prevStart, $lte: prevEnd }, paidInSystem: true, paymentStatus: 'succeeded' }),
    Order.aggregate([
      { $match: { createdAt: { $gte: prevStart, $lte: prevEnd }, paidInSystem: true, paymentStatus: 'succeeded' } },
      { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
    ])
  ]);
  const prevRevenue = (prevRevenueAgg[0]?.sum || 0);
  const prevAvgOrder = prevOrdersPaid ? Math.round(prevRevenue / prevOrdersPaid) : 0;

  const daily = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $project: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        paid: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] },
        rev: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] },
    }},
    { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
    { $sort: { _id: 1 } }
  ]);

  const topServices = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: '$service', count: { $sum: 1 },
                paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]);

  const heatRaw = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end }, locationLat: { $ne: null }, locationLon: { $ne: null } } },
    { $project: {
      latg: { $round: ['$locationLat', 2] },
      long: { $round: ['$locationLon', 2] }
    }},
    { $group: { _id: { lat: '$latg', lon: '$long' }, count: { $sum: 1 } } },
    { $project: { _id: 0, lat: '$_id.lat', lon: '$_id.lon', count: 1 } },
    { $sort: { count: -1 } },
    { $limit: 500 }
  ]);

  res.json({
    range: { from: dateOnly(start), to: dateOnly(end) },
    compareRange: { from: dateOnly(prevStart), to: dateOnly(prevEnd) },
    kpi: {
      orders: ordersAll,
      ordersPaid,
      paidShare: ordersAll ? (ordersPaid / ordersAll) : 0,
      revenue,
      avgOrder: (ordersPaid ? Math.round(revenue / ordersPaid) : 0),
      providersCount, providersVerified, clientsCount
    },
    compare: {
      orders: { prev: prevOrdersAll, deltaPct: pctDelta(ordersAll, prevOrdersAll) },
      ordersPaid: { prev: prevOrdersPaid, deltaPct: pctDelta(ordersPaid, prevOrdersPaid) },
      revenue: { prev: prevRevenue, deltaPct: pctDelta(revenue, prevRevenue) },
      avgOrder: { prev: prevAvgOrder, deltaPct: pctDelta((ordersPaid ? Math.round(revenue / ordersPaid) : 0), prevAvgOrder) }
    },
    daily,
    topServices,
    heatmap: heatRaw
  });
});

// GET /api/admin/analytics/ai-insights?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/ai-insights', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const aiMatch = { createdAt: { $gte: start, $lte: end } };
    const orderMatch = { createdAt: { $gte: start, $lte: end } };
    const eventMatch = { createdAt: { $gte: start, $lte: end } };

    const [
      aiSummaryAgg,
      agentBreakdown,
      nextSteps,
      detectedServices,
      ordersFromAi,
      ordersWithAiBrief,
      safetyAlerts,
      avgBriefQualityAgg,
      qualityLevels,
      aiOrdersByService,
      dailyAiRequests,
      dailyAiOrders,
      topErrors,
      startPromptSearches,
      providerDiscovery,
      aiProviderViews,
      aiProviderOrderCtas,
      aiProcessAgg,
      aiOfferStatsAgg,
      aiOfferQualitySummaryAgg,
      aiOfferQualityBuckets,
      aiMessagePreflightBlocked,
      aiMessagePreflightOverride,
      aiMessagePreflightByMode,
      aiOfferFormPreflightBlocked,
      aiOfferFormPreflightOverride,
      aiOfferFormSubmitStatsAgg,
      aiOfferFormSubmitDailyAgg
    ] = await Promise.all([
      AIAnalytics.aggregate([
        { $match: aiMatch },
        {
          $group: {
            _id: null,
            requests: { $sum: 1 },
            successful: { $sum: { $cond: ['$success', 1, 0] } },
            failed: { $sum: { $cond: ['$success', 0, 1] } },
            avgResponseTime: { $avg: '$responseTime' },
            uniqueSessions: { $addToSet: '$sessionId' },
            avgConfidence: { $avg: '$quality.confidence' }
          }
        },
        {
          $project: {
            _id: 0,
            requests: 1,
            successful: 1,
            failed: 1,
            avgResponseTime: { $round: ['$avgResponseTime', 0] },
            uniqueSessions: { $size: '$uniqueSessions' },
            avgConfidence: { $round: ['$avgConfidence', 3] }
          }
        }
      ]),
      AIAnalytics.aggregate([
        { $match: aiMatch },
        { $group: { _id: '$agent', count: { $sum: 1 }, avgMs: { $avg: '$responseTime' }, failures: { $sum: { $cond: ['$success', 0, 1] } } } },
        { $sort: { count: -1 } }
      ]),
      AIAnalytics.aggregate([
        { $match: aiMatch },
        { $group: { _id: '$metadata.nextStep', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 12 }
      ]),
      AIAnalytics.aggregate([
        { $match: aiMatch },
        { $group: { _id: '$metadata.detectedService', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 12 }
      ]),
      Order.countDocuments({ ...orderMatch, source: 'ai' }),
      Order.countDocuments({ ...orderMatch, 'aiBrief.title': { $exists: true, $ne: '' } }),
      Order.countDocuments({ ...orderMatch, 'aiBrief.safety.flag': true }),
      Order.aggregate([
        { $match: { ...orderMatch, 'aiBrief.quality.percent': { $exists: true } } },
        { $group: { _id: null, avg: { $avg: '$aiBrief.quality.percent' }, count: { $sum: 1 } } },
        { $project: { _id: 0, avg: { $round: ['$avg', 0] }, count: 1 } }
      ]),
      Order.aggregate([
        { $match: { ...orderMatch, 'aiBrief.quality.level': { $exists: true, $ne: '' } } },
        { $group: { _id: '$aiBrief.quality.level', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Order.aggregate([
        { $match: { ...orderMatch, source: 'ai' } },
        { $group: { _id: '$service', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      AIAnalytics.aggregate([
        { $match: aiMatch },
        { $project: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, success: '$success' } },
        { $group: { _id: '$date', requests: { $sum: 1 }, failed: { $sum: { $cond: ['$success', 0, 1] } } } },
        { $sort: { _id: 1 } }
      ]),
      Order.aggregate([
        { $match: { ...orderMatch, source: 'ai' } },
        { $project: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } } },
        { $group: { _id: '$date', orders: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      AIAnalytics.aggregate([
        { $match: { ...aiMatch, success: false } },
        { $group: { _id: { type: '$errorType', error: '$error' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Event.aggregate([
        {
          $match: {
            ...eventMatch,
            type: 'search',
            'properties.filters.source': { $in: ['concierge_start_prompt', 'provider_ai_start_prompt'] }
          }
        },
        {
          $group: {
            _id: {
              source: '$properties.filters.source',
              query: '$properties.query'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),
      Event.aggregate([
        {
          $match: {
            ...eventMatch,
            type: 'category_selected',
            'properties.categoryId': /^ai-/
          }
        },
        { $group: { _id: '$properties.categoryName', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 12 }
      ]),
      Event.countDocuments({ ...eventMatch, type: 'provider_view', 'properties.viewType': 'ai_recommendation' }),
      Event.countDocuments({ ...eventMatch, type: 'provider_contact', 'properties.contactType': 'ai_create_order_cta' }),
      Order.aggregate([
        { $match: { ...orderMatch, source: 'ai' } },
        {
          $lookup: {
            from: 'offers',
            localField: '_id',
            foreignField: 'orderId',
            as: 'offerDocs'
          }
        },
        {
          $project: {
            hasOffer: { $gt: [{ $size: '$offerDocs' }, 0] },
            offerCount: { $size: '$offerDocs' },
            accepted: {
              $or: [
                { $ne: ['$acceptedOfferId', null] },
                { $in: ['$status', ['accepted', 'funded', 'in_progress', 'completed', 'released', 'rated']] }
              ]
            },
            completed: { $in: ['$status', ['completed', 'released', 'rated']] },
            hasBrief: {
              $or: [
                { $ne: ['$aiBrief.title', ''] },
                { $gt: [{ $size: { $ifNull: ['$aiBrief.bullets', []] } }, 0] }
              ]
            },
            hasContextSnapshot: {
              $or: [
                { $ne: ['$aiBrief.contextSnapshot.handoffNote', ''] },
                { $gt: [{ $size: { $ifNull: ['$aiBrief.contextSnapshot.extractedFacts', []] } }, 0] }
              ]
            },
            hasSafety: { $eq: ['$aiBrief.safety.flag', true] }
          }
        },
        {
          $group: {
            _id: null,
            aiOrders: { $sum: 1 },
            aiOrdersWithOffers: { $sum: { $cond: ['$hasOffer', 1, 0] } },
            aiOrdersAccepted: { $sum: { $cond: ['$accepted', 1, 0] } },
            aiOrdersCompleted: { $sum: { $cond: ['$completed', 1, 0] } },
            aiOrdersWithBrief: { $sum: { $cond: ['$hasBrief', 1, 0] } },
            aiOrdersWithContext: { $sum: { $cond: ['$hasContextSnapshot', 1, 0] } },
            aiOrdersWithSafety: { $sum: { $cond: ['$hasSafety', 1, 0] } },
            avgOffersPerAiOrder: { $avg: '$offerCount' }
          }
        },
        {
          $project: {
            _id: 0,
            aiOrders: 1,
            aiOrdersWithOffers: 1,
            aiOrdersAccepted: 1,
            aiOrdersCompleted: 1,
            aiOrdersWithBrief: 1,
            aiOrdersWithContext: 1,
            aiOrdersWithSafety: 1,
            avgOffersPerAiOrder: { $round: ['$avgOffersPerAiOrder', 2] }
          }
        }
      ]),
      Offer.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end } } },
        {
          $lookup: {
            from: 'orders',
            localField: 'orderId',
            foreignField: '_id',
            as: 'order'
          }
        },
        { $unwind: '$order' },
        { $match: { 'order.source': 'ai' } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            avgAmount: { $avg: { $ifNull: ['$amount', '$price'] } }
          }
        },
        { $sort: { count: -1 } }
      ]),
      Offer.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end }, 'aiQuality.percent': { $gt: 0 } } },
        {
          $group: {
            _id: null,
            measuredOffers: { $sum: 1 },
            avgQuality: { $avg: '$aiQuality.percent' },
            highQualityOffers: { $sum: { $cond: [{ $gte: ['$aiQuality.percent', 80] }, 1, 0] } },
            sentWithWarnings: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ['$aiQuality.warnings', []] } }, 0] },
                  1,
                  0
                ]
              }
            },
            acceptedMeasuredOffers: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
            lowQualityOverrideSends: { $sum: { $cond: ['$aiQuality.lowQualityOverride', 1, 0] } }
          }
        },
        {
          $project: {
            _id: 0,
            measuredOffers: 1,
            avgQuality: { $round: ['$avgQuality', 0] },
            highQualityOffers: 1,
            sentWithWarnings: 1,
            acceptedMeasuredOffers: 1,
            lowQualityOverrideSends: 1
          }
        }
      ]),
      Offer.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end }, 'aiQuality.percent': { $gt: 0 } } },
        {
          $project: {
            status: 1,
            amount: { $ifNull: ['$amount', '$price'] },
            bucket: {
              $switch: {
                branches: [
                  { case: { $gte: ['$aiQuality.percent', 85] }, then: '85-100 pro' },
                  { case: { $gte: ['$aiQuality.percent', 70] }, then: '70-84 dobre' },
                  { case: { $gte: ['$aiQuality.percent', 55] }, then: '55-69 do poprawy' }
                ],
                default: '0-54 slabe'
              }
            }
          }
        },
        {
          $group: {
            _id: '$bucket',
            count: { $sum: 1 },
            accepted: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
            avgAmount: { $avg: '$amount' }
          }
        },
        { $sort: { _id: -1 } }
      ]),
      Event.countDocuments({ ...eventMatch, type: 'provider_ai_message_preflight_blocked' }),
      Event.countDocuments({ ...eventMatch, type: 'provider_ai_message_preflight_override' }),
      Event.aggregate([
        {
          $match: {
            ...eventMatch,
            type: { $in: ['provider_ai_message_preflight_blocked', 'provider_ai_message_preflight_override', 'provider_ai_message_sent'] }
          }
        },
        {
          $group: {
            _id: {
              mode: { $ifNull: ['$properties.mode', 'unknown'] },
              type: '$type'
            },
            count: { $sum: 1 }
          }
        }
      ]),
      Event.countDocuments({ ...eventMatch, type: 'offer_form_preflight_blocked' }),
      Event.countDocuments({ ...eventMatch, type: 'offer_form_preflight_override' }),
      Event.aggregate([
        { $match: { ...eventMatch, type: 'offer_form_submit' } },
        {
          $group: {
            _id: null,
            sent: { $sum: 1 },
            sentWithOverride: {
              $sum: {
                $cond: [{ $eq: ['$properties.sentWithOverride', true] }, 1, 0]
              }
            },
            avgScore: { $avg: '$properties.score' },
            avgScoreWithOverride: {
              $avg: {
                $cond: [
                  { $eq: ['$properties.sentWithOverride', true] },
                  '$properties.score',
                  null
                ]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            sent: 1,
            sentWithOverride: 1,
            avgScore: { $round: ['$avgScore', 0] },
            avgScoreWithOverride: { $round: ['$avgScoreWithOverride', 0] }
          }
        }
      ]),
      Event.aggregate([
        { $match: { ...eventMatch, type: 'offer_form_submit' } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            sent: { $sum: 1 },
            sentWithOverride: {
              $sum: {
                $cond: [{ $eq: ['$properties.sentWithOverride', true] }, 1, 0]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            date: '$_id',
            sent: 1,
            sentWithOverride: 1
          }
        },
        { $sort: { date: 1 } }
      ])
    ]);

    const aiSummary = aiSummaryAgg[0] || {
      requests: 0,
      successful: 0,
      failed: 0,
      avgResponseTime: 0,
      uniqueSessions: 0,
      avgConfidence: null
    };
    const avgBriefQuality = avgBriefQualityAgg[0] || { avg: 0, count: 0 };
    const aiProcess = aiProcessAgg[0] || {
      aiOrders: 0,
      aiOrdersWithOffers: 0,
      aiOrdersAccepted: 0,
      aiOrdersCompleted: 0,
      aiOrdersWithBrief: 0,
      aiOrdersWithContext: 0,
      aiOrdersWithSafety: 0,
      avgOffersPerAiOrder: 0
    };
    const rate = (part, total) => total ? Number((part / total).toFixed(4)) : null;
    const aiOfferQualitySummary = aiOfferQualitySummaryAgg[0] || {
      measuredOffers: 0,
      avgQuality: 0,
      highQualityOffers: 0,
      sentWithWarnings: 0,
      acceptedMeasuredOffers: 0,
      lowQualityOverrideSends: 0
    };
    const aiOfferFormSubmitStats = aiOfferFormSubmitStatsAgg[0] || {
      sent: 0,
      sentWithOverride: 0,
      avgScore: null,
      avgScoreWithOverride: null
    };
    const preflightModeMap = {};
    for (const row of aiMessagePreflightByMode || []) {
      const mode = row?._id?.mode || 'unknown';
      const type = row?._id?.type || '';
      const count = Number(row?.count || 0);
      if (!preflightModeMap[mode]) {
        preflightModeMap[mode] = { mode, blocked: 0, override: 0, sent: 0 };
      }
      if (type === 'provider_ai_message_preflight_blocked') preflightModeMap[mode].blocked += count;
      if (type === 'provider_ai_message_preflight_override') preflightModeMap[mode].override += count;
      if (type === 'provider_ai_message_sent') preflightModeMap[mode].sent += count;
    }
    const preflightByMode = Object.values(preflightModeMap)
      .map((row) => ({
        ...row,
        overrideRate: rate(row.override, row.blocked),
        blockRatePerSent: rate(row.blocked, row.sent)
      }))
      .sort((a, b) => (b.blocked || 0) - (a.blocked || 0));

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      kpi: {
        requests: aiSummary.requests,
        uniqueSessions: aiSummary.uniqueSessions,
        successRate: aiSummary.requests ? Number((aiSummary.successful / aiSummary.requests).toFixed(4)) : null,
        failureRate: aiSummary.requests ? Number((aiSummary.failed / aiSummary.requests).toFixed(4)) : null,
        avgResponseTime: aiSummary.avgResponseTime,
        avgConfidence: aiSummary.avgConfidence,
        ordersFromAi,
        ordersWithAiBrief,
        aiOrderShare: ordersFromAi ? Number((ordersWithAiBrief / ordersFromAi).toFixed(4)) : null,
        safetyAlerts,
        avgBriefQuality: avgBriefQuality.avg,
        briefsMeasured: avgBriefQuality.count
      },
      agentBreakdown: agentBreakdown.map((row) => ({
        agent: row._id || 'unknown',
        count: row.count,
        avgMs: Math.round(row.avgMs || 0),
        failures: row.failures || 0,
        failureRate: row.count ? Number(((row.failures || 0) / row.count).toFixed(4)) : 0
      })),
      nextSteps: nextSteps.filter((row) => row._id).map((row) => ({ nextStep: row._id, count: row.count })),
      detectedServices: detectedServices.filter((row) => row._id).map((row) => ({ service: row._id, count: row.count })),
      qualityLevels: qualityLevels.map((row) => ({ level: row._id || 'unknown', count: row.count })),
      aiOrdersByService: aiOrdersByService.map((row) => ({ service: row._id || 'unknown', count: row.count })),
      dailyAiRequests,
      dailyAiOrders,
      process: {
        ...aiProcess,
        aiSessionToOrderRate: rate(ordersFromAi, aiSummary.uniqueSessions),
        aiOrderOfferRate: rate(aiProcess.aiOrdersWithOffers, aiProcess.aiOrders),
        aiOrderAcceptedRate: rate(aiProcess.aiOrdersAccepted, aiProcess.aiOrders),
        aiOrderCompletedRate: rate(aiProcess.aiOrdersCompleted, aiProcess.aiOrders),
        aiBriefCoverageRate: rate(aiProcess.aiOrdersWithBrief, aiProcess.aiOrders),
        aiContextCoverageRate: rate(aiProcess.aiOrdersWithContext, aiProcess.aiOrders),
        funnel: [
          { step: 'Sesje AI', count: aiSummary.uniqueSessions },
          { step: 'Zlecenia z AI', count: ordersFromAi },
          { step: 'AI z ofertami', count: aiProcess.aiOrdersWithOffers },
          { step: 'AI zaakceptowane', count: aiProcess.aiOrdersAccepted },
          { step: 'AI ukończone', count: aiProcess.aiOrdersCompleted }
        ],
        offerStatuses: aiOfferStatsAgg.map((row) => ({
          status: row._id || 'unknown',
          count: row.count,
          avgAmount: row.avgAmount != null ? Math.round(row.avgAmount) : null
        })),
        offerQuality: {
          ...aiOfferQualitySummary,
          highQualityRate: rate(aiOfferQualitySummary.highQualityOffers, aiOfferQualitySummary.measuredOffers),
          warningSendRate: rate(aiOfferQualitySummary.sentWithWarnings, aiOfferQualitySummary.measuredOffers),
          acceptedMeasuredRate: rate(aiOfferQualitySummary.acceptedMeasuredOffers, aiOfferQualitySummary.measuredOffers),
          buckets: aiOfferQualityBuckets.map((row) => ({
            bucket: row._id || 'unknown',
            count: row.count,
            accepted: row.accepted || 0,
            acceptanceRate: rate(row.accepted || 0, row.count),
            avgAmount: row.avgAmount != null ? Math.round(row.avgAmount) : null
          }))
        },
        messagePreflight: {
          blocked: aiMessagePreflightBlocked,
          override: aiMessagePreflightOverride,
          overrideRate: rate(aiMessagePreflightOverride, aiMessagePreflightBlocked),
          byMode: preflightByMode
        },
        offerFormPreflight: {
          blocked: aiOfferFormPreflightBlocked,
          override: aiOfferFormPreflightOverride,
          overrideRate: rate(aiOfferFormPreflightOverride, aiOfferFormPreflightBlocked),
          sent: aiOfferFormSubmitStats.sent,
          sentWithOverride: aiOfferFormSubmitStats.sentWithOverride,
          submitOverrideRate: rate(aiOfferFormSubmitStats.sentWithOverride, aiOfferFormSubmitStats.sent),
          avgSubmitScore: aiOfferFormSubmitStats.avgScore,
          avgSubmitScoreWithOverride: aiOfferFormSubmitStats.avgScoreWithOverride,
          daily: (aiOfferFormSubmitDailyAgg || []).map((row) => ({
            date: row.date,
            sent: Number(row.sent || 0),
            sentWithOverride: Number(row.sentWithOverride || 0),
            overrideRate: rate(Number(row.sentWithOverride || 0), Number(row.sent || 0))
          }))
        }
      },
      topErrors: topErrors.map((row) => ({
        type: row._id?.type || 'other',
        error: row._id?.error || '',
        count: row.count
      })),
      promptAnalytics: {
        startPrompts: startPromptSearches.map((row) => ({
          source: row._id?.source || 'unknown',
          query: row._id?.query || '',
          count: row.count
        })),
        providerDiscovery: providerDiscovery.map((row) => ({
          service: row._id || 'unknown',
          count: row.count
        })),
        aiProviderViews,
        aiProviderOrderCtas
      }
    });
  } catch (error) {
    console.error('AI_INSIGHTS_ERROR:', error);
    res.status(500).json({ message: 'Błąd analityki AI' });
  }
});

// GET /api/admin/analytics/pro-conversion - analiza konwersji do PRO
router.get('/pro-conversion', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    // 1. Konwersja z FREE → STANDARD → PRO dla providerów
    const providerSubscriptions = await UserSubscription.find({
      planKey: { $in: ['PROV_FREE', 'PROV_STD', 'PROV_PRO'] },
      createdAt: { $gte: start, $lte: end }
    })
      .populate('user', 'role')
      .sort({ createdAt: 1 })
      .lean();

    // 2. Konwersja z FREE → STANDARD → PRO dla klientów
    const clientSubscriptions = await UserSubscription.find({
      planKey: { $in: ['CLIENT_FREE', 'CLIENT_STD', 'CLIENT_PRO'] },
      createdAt: { $gte: start, $lte: end }
    })
      .populate('user', 'role')
      .sort({ createdAt: 1 })
      .lean();

    // 3. Liczba użytkowników w każdym planie (aktualnie aktywni)
    const activeSubscriptions = await UserSubscription.find({
      validUntil: { $gt: new Date() }
    }).lean();

    const providersByPlan = { FREE: 0, STANDARD: 0, PRO: 0 };
    const clientsByPlan = { FREE: 0, STANDARD: 0, PRO: 0 };

    activeSubscriptions.forEach(sub => {
      if (sub.planKey.startsWith('PROV_')) {
        if (sub.planKey === 'PROV_FREE') providersByPlan.FREE++;
        else if (sub.planKey === 'PROV_STD') providersByPlan.STANDARD++;
        else if (sub.planKey === 'PROV_PRO') providersByPlan.PRO++;
      } else if (sub.planKey.startsWith('CLIENT_')) {
        if (sub.planKey === 'CLIENT_FREE') clientsByPlan.FREE++;
        else if (sub.planKey === 'CLIENT_STD') clientsByPlan.STANDARD++;
        else if (sub.planKey === 'CLIENT_PRO') clientsByPlan.PRO++;
      }
    });

    // 4. Konwersje w czasie (dziennie)
    const dailyConversions = await UserSubscription.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end }, planKey: { $regex: /PRO$/ } } },
      { $project: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        isProvider: { $cond: [{ $regexMatch: { input: '$planKey', regex: /^PROV_/ } }, true, false] },
        planKey: 1
      }},
      { $group: {
        _id: { date: '$date', isProvider: '$isProvider' },
        count: { $sum: 1 },
        plans: { $push: '$planKey' }
      }},
      { $sort: { '_id.date': 1 } }
    ]);

    // 5. Źródła konwersji (z jakiego planu przeszli do PRO)
    const conversionSources = await UserSubscription.aggregate([
      { $match: { planKey: { $regex: /PRO$/ }, createdAt: { $gte: start, $lte: end } } },
      { $lookup: {
        from: 'usersubscriptions',
        let: { userId: '$user', createdAt: '$createdAt' },
        pipeline: [
          { $match: {
            $expr: {
              $and: [
                { $eq: ['$user', '$$userId'] },
                { $lt: ['$createdAt', '$$createdAt'] }
              ]
            }
          }},
          { $sort: { createdAt: -1 } },
          { $limit: 1 }
        ],
        as: 'previousSubscription'
      }},
      { $project: {
        currentPlan: '$planKey',
        previousPlan: { $ifNull: [{ $arrayElemAt: ['$previousSubscription.planKey', 0] }, 'NEW'] },
        isProvider: { $cond: [{ $regexMatch: { input: '$planKey', regex: /^PROV_/ } }, true, false] }
      }},
      { $group: {
        _id: { from: '$previousPlan', to: '$currentPlan', isProvider: '$isProvider' },
        count: { $sum: 1 }
      }}
    ]);

    // 6. Churn rate (anulowane subskrypcje)
    const cancelledSubscriptions = await UserSubscription.countDocuments({
      renews: false,
      updatedAt: { $gte: start, $lte: end }
    });

    const totalActive = activeSubscriptions.length;
    const churnRate = totalActive > 0 ? (cancelledSubscriptions / totalActive) * 100 : 0;

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      activeDistribution: {
        providers: providersByPlan,
        clients: clientsByPlan
      },
      conversions: {
        providers: providerSubscriptions.filter(s => s.planKey === 'PROV_PRO').length,
        clients: clientSubscriptions.filter(s => s.planKey === 'CLIENT_PRO').length,
        total: providerSubscriptions.filter(s => s.planKey === 'PROV_PRO').length + 
               clientSubscriptions.filter(s => s.planKey === 'CLIENT_PRO').length
      },
      dailyConversions,
      conversionSources,
      churn: {
        cancelled: cancelledSubscriptions,
        rate: Math.round(churnRate * 100) / 100
      },
      summary: {
        totalActive: totalActive,
        totalProviders: providersByPlan.FREE + providersByPlan.STANDARD + providersByPlan.PRO,
        totalClients: clientsByPlan.FREE + clientsByPlan.STANDARD + clientsByPlan.PRO,
        proProviders: providersByPlan.PRO,
        proClients: clientsByPlan.PRO
      }
    });
  } catch (error) {
    console.error('PRO_CONVERSION_ERROR:', error);
    res.status(500).json({ message: 'Błąd analizy konwersji PRO' });
  }
});

module.exports = router;
// const { Parser } = require('json2csv');

// GET /api/admin/analytics/export?dataset=orders|daily|top-services&from=YYYY-MM-DD&to=YYYY-MM-DD
// router.get('/export', authMiddleware, requireRole('admin'), async (req, res) => {
//   try {
//     const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
//     const to   = req.query.to   ? dayjs(req.query.to)   : dayjs();
//     const start = from.startOf('day').toDate();
//     const end   = to.endOf('day').toDate();
//     const ds = (req.query.dataset || 'daily').toLowerCase();

//     let rows = [];
//     if (ds === 'orders') {
//       const orders = await Order.find({ createdAt: { $gte: start, $lte: end } })
//         .select('createdAt service amountTotal currency paidInSystem paymentStatus city location locationLat locationLon source')
//         .lean();

//       rows = orders.map(o => ({
//         date: dayjs(o.createdAt).format('YYYY-MM-DD HH:mm'),
//         service: o.service || '',
//         amount_pln: (o.amountTotal || 0) / 100,
//         currency: o.currency || 'pln',
//         paidInSystem: !!o.paidInSystem,
//         paymentStatus: o.paymentStatus,
//         city: o.city || '',
//         lat: o.locationLat ?? '',
//         lon: o.locationLon ?? '',
//         source: o.source || 'manual'
//         }));
//     } else if (ds === 'top-services') {
//       const top = await Order.aggregate([
//         { $match: { createdAt: { $gte: start, $lte: end } } },
//         { $group: { _id: '$service',
//           count: { $sum: 1 },
//           paidCount: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
//           revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } }
//         }},
//         { $sort: { count: -1 } }
//       ]);
//       rows = top.map(t => ({
//         service: String(t._id || ''),
//         orders: t.count,
//         paidOrders: t.paidCount,
//         revenue_pln: Math.round((t.revenue || 0)) / 100
//       }));
//     } else { // 'daily' (domyślnie)
//       const daily = await Order.aggregate([
//         { $match: { createdAt: { $gte: start, $lte: end } } },
//         { $group: { _id: '$date', orders: { $sum: 1 }, paid: { $sum: '$paid' }, revenue: { $sum: '$rev' } } },
//         { $sort: { _id: 1 } }
//       ]);
//       rows = daily.map(d => ({
//         date: d._id,
//         orders: d.orders,
//         paidOrders: t.paid,
//         revenue_pln: Math.round((t.revenue || 0)) / 100
//       }));
//     }

//     const parser = new Parser();
//     const csv = parser.parse(rows);
//     const fname = `helpfli_${(req.query.dataset||'daily')}_${from.format('YYYYMMDD')}_${to.format('YYYYMMDD')}.csv`;

//     res.setHeader('Content-Type', 'text/csv; charset=utf-8');
//     res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
//     res.send(csv);
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({ message: 'Błąd eksportu CSV' });
//   }
// });

// GET /api/admin/analytics/segment?dim=city|service&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=20&sort=revenue|orders
router.get('/segment', authMiddleware, requireRole('admin'), async (req, res) => {
  const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
  const to   = req.query.to   ? dayjs(req.query.to)   : dayjs();
  const start = from.startOf('day').toDate();
  const end   = to.endOf('day').toDate();
  const dim = (req.query.dim || 'city').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 200);
  const sortKey = (req.query.sort || 'revenue').toLowerCase();

  const groupKey = (dim === 'service') ? '$service' : '$city';

  const pipe = [
    { $match: { createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: groupKey,
                orders: { $sum: 1 },
                paidOrders: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, 1, 0] } },
                revenue: { $sum: { $cond: [{ $and: ['$paidInSystem', { $eq: ['$paymentStatus','succeeded'] }] }, '$amountTotal', 0] } } } },
    { $project: { segment: '$_id', _id: 0, orders: 1, paidOrders: 1, revenue: 1,
                  paidShare: { $cond: [{ $gt: ['$orders', 0] }, { $divide: ['$paidOrders', '$orders'] }, 0 ] } } },
    { $sort: { [sortKey]: -1 } },
    { $limit: limit }
  ];

  const rows = await Order.aggregate(pipe);
  res.json({ dim, from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD'), items: rows });
});

// GET /api/admin/analytics/monetization-summary
// Prosty panel: subskrypcje, promocje, kupony
router.get('/monetization-summary', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const now = dayjs();
    const from = req.query.from ? dayjs(req.query.from) : now.startOf('month');
    const to = req.query.to ? dayjs(req.query.to) : now;
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const [
      activeSubCount,
      proProvidersCount,
      paymentsSubs,
      paymentsPromo,
      coupons,
      subsByPlan
    ] = await Promise.all([
      UserSubscription.countDocuments({ validUntil: { $gt: new Date() } }),
      UserSubscription.countDocuments({ validUntil: { $gt: new Date() }, planKey: 'PROV_PRO' }),
      Payment.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end }, purpose: 'subscription', status: 'succeeded' } },
        { $group: { _id: null, sum: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Payment.aggregate([
        { $match: { createdAt: { $gte: start, $lte: end }, purpose: 'promotion', status: 'succeeded' } },
        { $group: { _id: null, sum: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Coupon.aggregate([
        { $group: { _id: null, total: { $sum: '$maxUses' }, used: { $sum: '$used' }, active: { $sum: { $cond: ['$active', 1, 0] } } } }
      ]),
      UserSubscription.aggregate([
        { $match: { validUntil: { $gt: new Date() } } },
        { $group: { _id: '$planKey', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    const subsAgg = paymentsSubs[0] || { sum: 0, count: 0 };
    const promoAgg = paymentsPromo[0] || { sum: 0, count: 0 };
    const couponAgg = coupons[0] || { total: 0, used: 0, active: 0 };

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      subscriptions: {
        activeCount: activeSubCount,
        proProvidersCount,
        mrrPLN: Math.round(subsAgg.sum / 100),
        paymentsCount: subsAgg.count,
        byPlan: subsByPlan.map(r => ({ planKey: r._id, count: r.count }))
      },
      promotions: {
        revenuePLN: Math.round(promoAgg.sum / 100),
        paymentsCount: promoAgg.count
      },
      coupons: {
        totalIssued: couponAgg.total,
        used: couponAgg.used,
        activeCount: couponAgg.active,
        usageRate: couponAgg.total ? (couponAgg.used / couponAgg.total) : 0
      }
    });
  } catch (e) {
    console.error('Monetization summary error:', e);
    res.status(500).json({ message: 'Błąd pobierania metryk monetyzacji' });
  }
});

// GET /api/admin/analytics/dashboard - dane do panelu głównego admina
router.get('/dashboard', authMiddleware, requireRole('admin'), async (_req, res) => {
  try {
    const now = dayjs();
    const monthStart = now.startOf('month').toDate();
    const days30Start = now.subtract(30, 'day').startOf('day').toDate();
    const nowDate = now.toDate();

    const [
      usersAccepted,
      newUsersMonth,
      gmvAgg,
      avgAgg,
      recentUsersRaw,
      recentOrdersRaw,
      topProblemTagsRaw,
      topProblemDisputesRaw,
      topCitiesRaw
    ] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' }, emailVerified: true, isActive: true }),
      User.countDocuments({ role: { $ne: 'admin' }, createdAt: { $gte: monthStart, $lte: nowDate } }),
      Order.aggregate([
        { $match: { createdAt: { $gte: days30Start, $lte: nowDate }, paidInSystem: true, paymentStatus: 'succeeded' } },
        { $group: { _id: null, sum: { $sum: '$amountTotal' } } }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: days30Start, $lte: nowDate }, paidInSystem: true, paymentStatus: 'succeeded' } },
        { $group: { _id: null, avg: { $avg: '$amountTotal' } } }
      ]),
      User.find({ role: { $ne: 'admin' } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('name email phone emailVerified createdAt')
        .lean(),
      Order.find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('client', 'name')
        .populate('provider', 'name')
        .select('service amountTotal status paymentStatus createdAt')
        .lean(),
      Order.aggregate([
        { $match: { createdAt: { $gte: days30Start, $lte: nowDate }, aiTags: { $exists: true, $ne: [] } } },
        { $unwind: '$aiTags' },
        { $match: { aiTags: { $nin: [null, ''] } } },
        { $group: { _id: '$aiTags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: days30Start, $lte: nowDate }, disputeReason: { $nin: [null, ''] } } },
        { $group: { _id: '$disputeReason', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: days30Start, $lte: nowDate }, city: { $nin: [null, ''] } } },
        { $group: { _id: '$city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ])
    ]);

    const mergedProblems = new Map();
    for (const item of topProblemTagsRaw) {
      const key = String(item._id || '').trim();
      if (!key) continue;
      const prev = mergedProblems.get(key) || { aiCount: 0, disputeCount: 0 };
      prev.aiCount += item.count || 0;
      mergedProblems.set(key, prev);
    }
    for (const item of topProblemDisputesRaw) {
      const key = String(item._id || '').trim();
      if (!key) continue;
      const prev = mergedProblems.get(key) || { aiCount: 0, disputeCount: 0 };
      prev.disputeCount += item.count || 0;
      mergedProblems.set(key, prev);
    }

    const topProblems = [...mergedProblems.entries()]
      .map(([name, counts]) => ({
        name,
        aiCount: counts.aiCount || 0,
        disputeCount: counts.disputeCount || 0,
        count: (counts.aiCount || 0) + (counts.disputeCount || 0)
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const gmv30d = gmvAgg[0]?.sum || 0;
    const avgPrice = Math.round(avgAgg[0]?.avg || 0);

    const recentUsers = recentUsersRaw.map((u) => ({
      name: u.name || '—',
      email: u.email || '—',
      phone: u.phone || '—',
      status: u.emailVerified ? 'Zaakceptowany' : 'Oczekuje'
    }));

    const recentOrders = recentOrdersRaw.map((o) => ({
      id: String(o._id),
      user: o.client?.name || '—',
      provider: o.provider?.name || '—',
      amountPLN: Math.round((o.amountTotal || 0) / 100)
    }));

    const marketOverview = topCitiesRaw.map((c) => ({
      city: String(c._id || '—'),
      count: c.count || 0
    }));

    res.json({
      kpi: {
        usersAccepted,
        newUsersMonth,
        gmv30d,
        avgPrice
      },
      recentUsers,
      recentOrders,
      topProblems,
      marketOverview
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    res.status(500).json({ message: 'Błąd pobierania dashboardu admina' });
  }
});

// GET /api/admin/analytics/product-insights — ruch, wyszukiwania, „zero wyników”, tarcie w formularzach (telemetria Event)
router.get('/product-insights', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const [
      pageViewsTotal,
      searchEventsTotal,
      distinctSessions,
      topPaths,
      dailyPageViews,
      topSearches,
      zeroResultSearches,
      lowResultSearches,
      topReferrers,
      orderAbandonByStep,
      disputes
    ] = await Promise.all([
      Event.countDocuments({ type: 'page_view', createdAt: { $gte: start, $lte: end } }),
      Event.countDocuments({ type: 'search', createdAt: { $gte: start, $lte: end } }),
      Event.distinct('sessionId', {
        type: 'page_view',
        createdAt: { $gte: start, $lte: end },
        sessionId: { $nin: [null, ''] }
      }).then((ids) => ids.length),
      TelemetryService.getPopularPages(start, end, 30),
      Event.aggregate([
        { $match: { type: 'page_view', createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            views: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Event.aggregate([
        { $match: { type: 'search', createdAt: { $gte: start, $lte: end } } },
        {
          $addFields: {
            q: {
              $trim: {
                input: { $toLower: { $ifNull: ['$properties.query', ''] } }
              }
            }
          }
        },
        { $match: { q: { $ne: '' } } },
        {
          $group: {
            _id: '$q',
            count: { $sum: 1 },
            avgResults: { $avg: { $ifNull: ['$properties.resultCount', 0] } },
            zeroHits: {
              $sum: {
                $cond: [{ $eq: [{ $ifNull: ['$properties.resultCount', 0] }, 0] }, 1, 0]
              }
            }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 40 }
      ]),
      Event.aggregate([
        { $match: { type: 'search', createdAt: { $gte: start, $lte: end } } },
        {
          $match: {
            $expr: { $eq: [{ $ifNull: ['$properties.resultCount', 0] }, 0] }
          }
        },
        {
          $addFields: {
            q: {
              $trim: {
                input: { $toLower: { $ifNull: ['$properties.query', ''] } }
              }
            }
          }
        },
        { $match: { q: { $ne: '' } } },
        { $group: { _id: '$q', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 30 }
      ]),
      Event.aggregate([
        { $match: { type: 'search', createdAt: { $gte: start, $lte: end } } },
        {
          $match: {
            $expr: {
              $and: [
                { $gt: [{ $ifNull: ['$properties.resultCount', 0] }, 0] },
                { $lte: [{ $ifNull: ['$properties.resultCount', 0] }, 3] }
              ]
            }
          }
        },
        {
          $addFields: {
            q: {
              $trim: {
                input: { $toLower: { $ifNull: ['$properties.query', ''] } }
              }
            }
          }
        },
        { $match: { q: { $ne: '' } } },
        { $group: { _id: '$q', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),
      Event.aggregate([
        { $match: { type: 'page_view', createdAt: { $gte: start, $lte: end } } },
        {
          $match: {
            'properties.referrer': { $exists: true, $nin: [null, ''] }
          }
        },
        {
          $group: {
            _id: { $substrCP: ['$properties.referrer', 0, 120] },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),
      Event.aggregate([
        { $match: { type: 'order_form_abandon', createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: { $ifNull: ['$properties.lastStep', '(brak)'] },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 12 }
      ]),
      Event.aggregate([
        { $match: { type: 'dispute_reported', createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: { $ifNull: ['$properties.reason', '(brak)'] },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 12 }
      ])
    ]);

    const [
      funnelByType,
      searchQualityBuckets,
      utmCampaigns,
      retentionAgg,
      clientApiErrors
    ] = await Promise.all([
      Event.aggregate([
        {
          $match: {
            type: { $in: ['page_view', 'search', 'provider_view', 'quote_request', 'order_form_success'] },
            createdAt: { $gte: start, $lte: end }
          }
        },
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ]),
      Event.aggregate([
        { $match: { type: 'search', createdAt: { $gte: start, $lte: end } } },
        {
          $addFields: {
            bucket: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $ifNull: ['$properties.resultCount', 0] }, 0] }, then: '0' },
                  { case: { $lte: [{ $ifNull: ['$properties.resultCount', 0] }, 3] }, then: '1-3' },
                  { case: { $lte: [{ $ifNull: ['$properties.resultCount', 0] }, 10] }, then: '4-10' }
                ],
                default: '11+'
              }
            }
          }
        },
        { $group: { _id: '$bucket', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Event.aggregate([
        {
          $match: {
            type: 'page_view',
            createdAt: { $gte: start, $lte: end },
            'properties.utm.source': { $exists: true, $nin: [null, ''] }
          }
        },
        {
          $group: {
            _id: {
              source: '$properties.utm.source',
              medium: { $ifNull: ['$properties.utm.medium', ''] },
              campaign: { $ifNull: ['$properties.utm.campaign', ''] }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 25 }
      ]),
      Event.aggregate([
        { $match: { type: 'page_view', userId: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: '$userId',
            distinctDays: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }
          }
        },
        { $project: { dayCount: { $size: '$distinctDays' } } },
        {
          $group: {
            _id: null,
            usersWithPv: { $sum: 1 },
            returningUsers: { $sum: { $cond: [{ $gte: ['$dayCount', 2] }, 1, 0] } }
          }
        }
      ]),
      Event.aggregate([
        { $match: { type: 'client_api_error', createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$properties.endpoint', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 15 }
      ])
    ]);

    const conversion = computeConversionRates(funnelByType);
    const ret = retentionAgg[0] || {};
    const usersWithPv = ret.usersWithPv || 0;
    const returningUsers = ret.returningUsers || 0;

    res.json({
      range: { from: dateOnly(start), to: dateOnly(end) },
      traffic: {
        pageViews: pageViewsTotal,
        searchEvents: searchEventsTotal,
        distinctSessionsApprox: distinctSessions
      },
      topPaths,
      dailyPageViews,
      topSearches: topSearches.map((r) => ({
        query: r._id,
        count: r.count,
        avgResults: r.avgResults != null ? Math.round(r.avgResults * 10) / 10 : 0,
        zeroHits: r.zeroHits || 0
      })),
      zeroResultSearches: zeroResultSearches.map((r) => ({ query: r._id, count: r.count })),
      lowResultSearches: lowResultSearches.map((r) => ({ query: r._id, count: r.count })),
      topReferrers: topReferrers.map((r) => ({ referrer: r._id, count: r.count })),
      friction: {
        orderFormAbandonByStep: orderAbandonByStep.map((r) => ({ step: r._id, count: r.count })),
        disputesByReason: disputes.map((r) => ({ reason: r._id, count: r.count }))
      },
      conversion,
      searchQualityBuckets: searchQualityBuckets.map((r) => ({ bucket: r._id, count: r.count })),
      utmTop: utmCampaigns.map((r) => ({
        source: r._id?.source,
        medium: r._id?.medium,
        campaign: r._id?.campaign,
        count: r.count
      })),
      retention: {
        usersWithPageViews: usersWithPv,
        returningUsers,
        returningRate: usersWithPv ? Number((returningUsers / usersWithPv).toFixed(4)) : null
      },
      clientApiErrors: clientApiErrors.map((r) => ({ endpoint: r._id || '—', count: r.count }))
    });
  } catch (error) {
    console.error('Product insights error:', error);
    res.status(500).json({ message: 'Błąd analizy produktu (telemetria)' });
  }
});

// GET /api/admin/analytics/api-health — czasy odpowiedzi i kody HTTP (ApiRequestLog, np. GET /api/search)
router.get('/api-health', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const ApiRequestLog = require('../models/ApiRequestLog');
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(7, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const [summary, statusBreak] = await Promise.all([
      ApiRequestLog.aggregate([
        { $match: { path: '/api/search', createdAt: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            n: { $sum: 1 },
            avgMs: { $avg: '$durationMs' },
            maxMs: { $max: '$durationMs' },
            minMs: { $min: '$durationMs' }
          }
        }
      ]),
      ApiRequestLog.aggregate([
        { $match: { path: '/api/search', createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: '$statusCode', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ])
    ]);

    const s = summary[0] || {};
    res.json({
      range: { from: dateOnly(start), to: dateOnly(end) },
      search: {
        samples: s.n || 0,
        avgMs: s.avgMs != null ? Math.round(s.avgMs) : null,
        maxMs: s.maxMs != null ? Math.round(s.maxMs) : null,
        minMs: s.minMs != null ? Math.round(s.minMs) : null,
        statusCodes: statusBreak.map((x) => ({ status: x._id, count: x.count }))
      }
    });
  } catch (e) {
    console.error('api-health error', e);
    res.status(500).json({ message: 'Błąd metryk API' });
  }
});
