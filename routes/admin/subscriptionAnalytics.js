const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const UserSubscription = require('../../models/UserSubscription');
const SubscriptionPlan = require('../../models/SubscriptionPlan');
const Payment = require('../../models/Payment');
const User = require('../../models/User');

// Middleware do sprawdzania czy użytkownik jest adminem
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Brak uprawnień administratora' });
  }
  next();
};

// GET /api/admin/analytics/subscriptions/mrr - Monthly Recurring Revenue
router.get('/mrr', auth, requireAdmin, async (req, res) => {
  try {
    const { month } = req.query || {}; // Format: 'YYYY-MM'
    const now = new Date();
    const targetMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);
    
    // Pobierz wszystkie aktywne subskrypcje w tym miesiącu
    const activeSubs = await UserSubscription.find({
      validUntil: { $gte: startDate, $lte: endDate },
      renews: true
    }).populate('user', 'role');
    
    const plans = await SubscriptionPlan.find({});
    const planMap = new Map(plans.map(p => [p.key, p]));
    
    let totalMRR = 0;
    const mrrByPlan = {};
    const mrrByRole = { client: 0, provider: 0 };
    
    for (const sub of activeSubs) {
      const plan = planMap.get(sub.planKey);
      if (!plan) continue;
      
      const monthlyPrice = plan.priceMonthly || 0;
      totalMRR += monthlyPrice;
      
      mrrByPlan[sub.planKey] = (mrrByPlan[sub.planKey] || 0) + monthlyPrice;
      
      if (sub.user?.role === 'client') {
        mrrByRole.client += monthlyPrice;
      } else if (sub.user?.role === 'provider') {
        mrrByRole.provider += monthlyPrice;
      }
    }
    
    res.json({
      month: targetMonth,
      mrr: totalMRR,
      mrrByPlan,
      mrrByRole,
      activeSubscriptions: activeSubs.length
    });
  } catch (error) {
    console.error('Error calculating MRR:', error);
    res.status(500).json({ message: 'Błąd obliczania MRR' });
  }
});

// GET /api/admin/analytics/subscriptions/churn - Churn rate
router.get('/churn', auth, requireAdmin, async (req, res) => {
  try {
    const { month } = req.query || {}; // Format: 'YYYY-MM'
    const now = new Date();
    const targetMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);
    
    // Subskrypcje które wygasły w tym miesiącu
    const expiredSubs = await UserSubscription.find({
      validUntil: { $gte: startDate, $lte: endDate },
      renews: false,
      cancelledAt: { $exists: true }
    });
    
    // Aktywne subskrypcje na początku miesiąca
    const activeAtStart = await UserSubscription.countDocuments({
      validUntil: { $gte: startDate },
      startedAt: { $lt: startDate }
    });
    
    // Nowe subskrypcje w tym miesiącu
    const newSubs = await UserSubscription.countDocuments({
      startedAt: { $gte: startDate, $lte: endDate }
    });
    
    const churnRate = activeAtStart > 0 
      ? (expiredSubs.length / activeAtStart) * 100 
      : 0;
    
    res.json({
      month: targetMonth,
      churnRate: churnRate.toFixed(2),
      cancelledSubscriptions: expiredSubs.length,
      activeAtStart,
      newSubscriptions: newSubs,
      netGrowth: newSubs - expiredSubs.length
    });
  } catch (error) {
    console.error('Error calculating churn rate:', error);
    res.status(500).json({ message: 'Błąd obliczania churn rate' });
  }
});

// GET /api/admin/analytics/subscriptions/cohort - Cohort analysis
router.get('/cohort', auth, requireAdmin, async (req, res) => {
  try {
    const cohorts = [];
    const now = new Date();
    
    // Analizuj ostatnie 12 miesięcy
    for (let i = 11; i >= 0; i--) {
      const cohortDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const cohortKey = `${cohortDate.getFullYear()}-${String(cohortDate.getMonth() + 1).padStart(2, '0')}`;
      
      // Użytkownicy którzy rozpoczęli subskrypcję w tym miesiącu
      const cohortStart = new Date(cohortDate.getFullYear(), cohortDate.getMonth(), 1);
      const cohortEnd = new Date(cohortDate.getFullYear(), cohortDate.getMonth() + 1, 0, 23, 59, 59, 999);
      
      const cohortUsers = await UserSubscription.find({
        startedAt: { $gte: cohortStart, $lte: cohortEnd }
      }).select('user planKey startedAt');
      
      const cohortSize = cohortUsers.length;
      
      // Sprawdź retention po 1, 3, 6 miesiącach
      const retention1Month = await UserSubscription.countDocuments({
        user: { $in: cohortUsers.map(u => u.user) },
        validUntil: { $gte: new Date(cohortDate.getFullYear(), cohortDate.getMonth() + 1, 1) }
      });
      
      const retention3Months = await UserSubscription.countDocuments({
        user: { $in: cohortUsers.map(u => u.user) },
        validUntil: { $gte: new Date(cohortDate.getFullYear(), cohortDate.getMonth() + 3, 1) }
      });
      
      const retention6Months = await UserSubscription.countDocuments({
        user: { $in: cohortUsers.map(u => u.user) },
        validUntil: { $gte: new Date(cohortDate.getFullYear(), cohortDate.getMonth() + 6, 1) }
      });
      
      cohorts.push({
        cohort: cohortKey,
        size: cohortSize,
        retention: {
          '1month': cohortSize > 0 ? ((retention1Month / cohortSize) * 100).toFixed(2) : 0,
          '3months': cohortSize > 0 ? ((retention3Months / cohortSize) * 100).toFixed(2) : 0,
          '6months': cohortSize > 0 ? ((retention6Months / cohortSize) * 100).toFixed(2) : 0
        }
      });
    }
    
    res.json({ cohorts });
  } catch (error) {
    console.error('Error calculating cohort analysis:', error);
    res.status(500).json({ message: 'Błąd obliczania cohort analysis' });
  }
});

// GET /api/admin/analytics/subscriptions/arpu - Average Revenue Per User
router.get('/arpu', auth, requireAdmin, async (req, res) => {
  try {
    const { month } = req.query || {};
    const now = new Date();
    const targetMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);
    
    // Pobierz wszystkie płatności za subskrypcje w tym miesiącu
    const payments = await Payment.find({
      purpose: 'subscription',
      createdAt: { $gte: startDate, $lte: endDate },
      status: 'succeeded'
    });
    
    const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const uniqueUsers = new Set(payments.map(p => String(p.subscriptionUser))).size;
    
    const arpu = uniqueUsers > 0 ? totalRevenue / uniqueUsers / 100 : 0; // w zł
    
    res.json({
      month: targetMonth,
      arpu: arpu.toFixed(2),
      totalRevenue: totalRevenue / 100,
      activeUsers: uniqueUsers,
      totalPayments: payments.length
    });
  } catch (error) {
    console.error('Error calculating ARPU:', error);
    res.status(500).json({ message: 'Błąd obliczania ARPU' });
  }
});

// GET /api/admin/analytics/subscriptions/forecast - Revenue forecast
router.get('/forecast', auth, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const activeSubs = await UserSubscription.find({
      validUntil: { $gt: now },
      renews: true
    });
    
    const plans = await SubscriptionPlan.find({});
    const planMap = new Map(plans.map(p => [p.key, p]));
    
    // Oblicz MRR na podstawie aktywnych subskrypcji
    let currentMRR = 0;
    for (const sub of activeSubs) {
      const plan = planMap.get(sub.planKey);
      if (plan) {
        currentMRR += plan.priceMonthly || 0;
      }
    }
    
    // Prognoza na podstawie trendu (uproszczona)
    const forecast = {
      currentMRR: currentMRR,
      nextMonth: currentMRR * 0.95, // Zakładamy 5% churn
      next3Months: currentMRR * 0.90,
      next6Months: currentMRR * 0.85,
      nextYear: currentMRR * 0.75
    };
    
    res.json(forecast);
  } catch (error) {
    console.error('Error calculating forecast:', error);
    res.status(500).json({ message: 'Błąd obliczania prognozy' });
  }
});

module.exports = router;







