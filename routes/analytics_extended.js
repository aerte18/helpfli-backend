// Rozszerzone metryki biznesowe dla Helpfli
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const dayjs = require('dayjs');
const User = require('../models/User');
const Order = require('../models/Order');
const UserSubscription = require('../models/UserSubscription');
const Payment = require('../models/Payment');
const Rating = require('../models/Rating');
const Offer = require('../models/Offer');
const VideoSession = require('../models/VideoSession');
const Portfolio = require('../models/Portfolio');
const Referral = require('../models/Referral');

// GET /api/analytics/extended/business-metrics - Rozszerzone metryki biznesowe
router.get('/business-metrics', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    // 1. Revenue metrics
    const revenueMetrics = await Payment.aggregate([
      { $match: { status: 'succeeded', createdAt: { $gte: start, $lte: end } } },
      { $group: {
        _id: '$purpose',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }}
    ]);

    // 2. User growth
    const userGrowth = await User.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $project: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        role: 1
      }},
      { $group: {
        _id: { date: '$date', role: '$role' },
        count: { $sum: 1 }
      }},
      { $sort: { '_id.date': 1 } }
    ]);

    // 3. Order metrics
    const orderMetrics = await Order.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgAmount: { $avg: '$amountTotal' },
        totalAmount: { $sum: '$amountTotal' }
      }}
    ]);

    // 4. Offer metrics
    const offerMetrics = await Offer.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        accepted: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } },
        avgAmount: { $avg: '$amount' }
      }}
    ]);

    // 5. Engagement metrics
    const engagementMetrics = {
      ratings: await Rating.countDocuments({ createdAt: { $gte: start, $lte: end } }),
      portfolioItems: await Portfolio.countDocuments({ createdAt: { $gte: start, $lte: end } }),
      videoSessions: await VideoSession.countDocuments({ createdAt: { $gte: start, $lte: end } }),
      referrals: await Referral.countDocuments({ createdAt: { $gte: start, $lte: end } })
    };

    // 6. Active users (DAU/MAU)
    const dailyActiveUsers = await User.distinct('_id', {
      lastLoginAt: { $gte: dayjs().subtract(1, 'day').toDate() }
    });
    const monthlyActiveUsers = await User.distinct('_id', {
      lastLoginAt: { $gte: dayjs().subtract(30, 'day').toDate() }
    });

    // 7. Retention rate (użytkownicy, którzy wrócili w ciągu 7 dni)
    const newUsers30DaysAgo = await User.countDocuments({
      createdAt: { $gte: dayjs().subtract(30, 'day').startOf('day').toDate(), $lt: dayjs().subtract(29, 'day').startOf('day').toDate() }
    });
    const returningUsers = await User.countDocuments({
      createdAt: { $gte: dayjs().subtract(30, 'day').startOf('day').toDate(), $lt: dayjs().subtract(29, 'day').startOf('day').toDate() },
      lastLoginAt: { $gte: dayjs().subtract(7, 'day').toDate() }
    });
    const retentionRate = newUsers30DaysAgo > 0 ? (returningUsers / newUsers30DaysAgo) * 100 : 0;

    // 8. Average order value (AOV)
    const aovData = await Order.aggregate([
      { $match: { status: { $in: ['completed', 'paid', 'closed'] }, createdAt: { $gte: start, $lte: end } } },
      { $group: {
        _id: null,
        avg: { $avg: '$amountTotal' },
        min: { $min: '$amountTotal' },
        max: { $max: '$amountTotal' }
      }}
    ]);

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      revenue: {
        byPurpose: revenueMetrics,
        total: revenueMetrics.reduce((sum, m) => sum + m.total, 0),
        count: revenueMetrics.reduce((sum, m) => sum + m.count, 0)
      },
      users: {
        growth: userGrowth,
        dailyActive: dailyActiveUsers.length,
        monthlyActive: monthlyActiveUsers.length,
        retentionRate: Math.round(retentionRate * 100) / 100
      },
      orders: {
        byStatus: orderMetrics,
        total: orderMetrics.reduce((sum, m) => sum + m.count, 0)
      },
      offers: offerMetrics[0] || { total: 0, accepted: 0, avgAmount: 0 },
      engagement: engagementMetrics,
      aov: aovData[0] || { avg: 0, min: 0, max: 0 }
    });
  } catch (error) {
    console.error('EXTENDED_BUSINESS_METRICS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania metryk biznesowych' });
  }
});

// GET /api/analytics/extended/pro-conversion-detailed - Szczegółowy tracking konwersji PRO
router.get('/pro-conversion-detailed', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    // 1. Funnel konwersji: FREE → STANDARD → PRO
    const funnel = await UserSubscription.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $project: {
        planKey: 1,
        isProvider: { $cond: [{ $regexMatch: { input: '$planKey', regex: /^PROV_/ } }, true, false] },
        createdAt: 1
      }},
      { $group: {
        _id: { plan: '$planKey', isProvider: '$isProvider' },
        count: { $sum: 1 }
      }}
    ]);

    // 2. Czas do konwersji (średni czas od rejestracji do PRO)
    const conversionTime = await UserSubscription.aggregate([
      { $match: { planKey: { $regex: /PRO$/ }, createdAt: { $gte: start, $lte: end } } },
      { $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userData'
      }},
      { $unwind: '$userData' },
      { $project: {
        daysToConversion: {
          $divide: [
            { $subtract: ['$createdAt', '$userData.createdAt'] },
            1000 * 60 * 60 * 24
          ]
        },
        isProvider: { $cond: [{ $regexMatch: { input: '$planKey', regex: /^PROV_/ } }, true, false] }
      }},
      { $group: {
        _id: '$isProvider',
        avgDays: { $avg: '$daysToConversion' },
        minDays: { $min: '$daysToConversion' },
        maxDays: { $max: '$daysToConversion' }
      }}
    ]);

    // 3. Conversion rate (procent użytkowników, którzy przeszli na PRO)
    const totalUsers = await User.countDocuments({ role: { $in: ['provider', 'client'] } });
    const proUsers = await UserSubscription.countDocuments({
      planKey: { $regex: /PRO$/ },
      validUntil: { $gt: new Date() }
    });
    const conversionRate = totalUsers > 0 ? (proUsers / totalUsers) * 100 : 0;

    // 4. Revenue z PRO (MRR - Monthly Recurring Revenue)
    const mrr = await UserSubscription.aggregate([
      { $match: { planKey: { $regex: /PRO$/ }, validUntil: { $gt: new Date() } } },
      { $lookup: {
        from: 'subscriptionplans',
        localField: 'planKey',
        foreignField: 'key',
        as: 'plan'
      }},
      { $unwind: '$plan' },
      { $group: {
        _id: null,
        mrr: { $sum: '$plan.price' }
      }}
    ]);

    // 5. Churn analysis (anulowane subskrypcje PRO)
    const churnedPro = await UserSubscription.countDocuments({
      planKey: { $regex: /PRO$/ },
      renews: false,
      updatedAt: { $gte: start, $lte: end }
    });

    // 6. Upgrade paths (z jakiego planu przeszli na PRO)
    const upgradePaths = await UserSubscription.aggregate([
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
        as: 'previous'
      }},
      { $project: {
        from: { $ifNull: [{ $arrayElemAt: ['$previous.planKey', 0] }, 'NEW'] },
        to: '$planKey',
        isProvider: { $cond: [{ $regexMatch: { input: '$planKey', regex: /^PROV_/ } }, true, false] }
      }},
      { $group: {
        _id: { from: '$from', isProvider: '$isProvider' },
        count: { $sum: 1 }
      }}
    ]);

    // 7. Lifetime Value (LTV) dla PRO użytkowników
    const ltv = await Payment.aggregate([
      { $match: {
        purpose: 'subscription',
        status: 'succeeded',
        subscriptionPlanKey: { $regex: /PRO$/ },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$subscriptionUser',
        totalPaid: { $sum: '$amount' },
        paymentCount: { $sum: 1 }
      }},
      { $group: {
        _id: null,
        avgLtv: { $avg: '$totalPaid' },
        minLtv: { $min: '$totalPaid' },
        maxLtv: { $max: '$totalPaid' }
      }}
    ]);

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      funnel: funnel,
      conversionTime: conversionTime.map(ct => ({
        isProvider: ct._id,
        avgDays: Math.round(ct.avgDays * 100) / 100,
        minDays: ct.minDays,
        maxDays: ct.maxDays
      })),
      conversionRate: Math.round(conversionRate * 100) / 100,
      mrr: mrr[0]?.mrr || 0,
      churn: {
        count: churnedPro,
        rate: proUsers > 0 ? (churnedPro / proUsers) * 100 : 0
      },
      upgradePaths: upgradePaths,
      ltv: ltv[0] || { avgLtv: 0, minLtv: 0, maxLtv: 0 }
    });
  } catch (error) {
    console.error('PRO_CONVERSION_DETAILED_ERROR:', error);
    res.status(500).json({ message: 'Błąd szczegółowej analizy konwersji PRO' });
  }
});

// GET /api/analytics/extended/performance - Metryki wydajności
router.get('/performance', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    // To można rozszerzyć o rzeczywiste metryki z APM (np. New Relic, DataDog)
    // Na razie zwracamy podstawowe metryki

    const performanceMetrics = {
      api: {
        avgResponseTime: 150, // ms (mock - w produkcji z APM)
        p95ResponseTime: 300,
        p99ResponseTime: 500,
        errorRate: 0.5, // %
        requestsPerMinute: 120
      },
      database: {
        avgQueryTime: 50, // ms
        slowQueries: 2, // > 100ms
        connectionPool: {
          active: 10,
          idle: 5,
          max: 20
        }
      },
      cache: {
        hitRate: 85, // %
        missRate: 15,
        size: 500, // MB
        evictions: 10
      }
    };

    res.json(performanceMetrics);
  } catch (error) {
    console.error('PERFORMANCE_METRICS_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania metryk wydajności' });
  }
});

module.exports = router;

