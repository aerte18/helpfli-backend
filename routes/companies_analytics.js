// Raporty i analityka dla firm (Multi-tenant)
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const dayjs = require('dayjs');
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Rating = require('../models/Rating');
const Offer = require('../models/Offer');

// Middleware sprawdzające dostęp do firmy
const requireCompanyAccess = async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const user = await User.findById(req.user._id);
    
    if (!companyId) {
      return res.status(400).json({ message: 'ID firmy jest wymagane' });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    // Sprawdź dostęp
    if (user.role === 'admin' || company.canAccess(user._id)) {
      req.company = company;
      req.companyAccess = {
        canManage: company.canManage(user._id),
        canView: true
      };
      return next();
    }

    return res.status(403).json({ message: 'Brak uprawnień do tej firmy' });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// GET /api/companies/:companyId/analytics/summary - Podsumowanie statystyk firmy
router.get('/:companyId/analytics/summary', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const company = req.company;
    
    // Pobierz wszystkich providerów firmy
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];

    // 1. Statystyki zleceń
    const ordersStats = await Order.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amountTotal' },
        avgAmount: { $avg: '$amountTotal' }
      }}
    ]);

    // 2. Przychody
    const revenueStats = await Payment.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        status: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$purpose',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }}
    ]);

    // 3. Oceny
    const ratingsStats = await Rating.aggregate([
      { $match: {
        to: { $in: companyProviders },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: null,
        avgRating: { $avg: '$rating' },
        count: { $sum: 1 }
      }}
    ]);

    // 4. Oferty
    const offersStats = await Offer.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }}
    ]);

    // 5. Najlepsi wykonawcy (według zakończonych zleceń)
    const topProviders = await Order.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        status: { $in: ['completed', 'closed'] },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$provider',
        completedOrders: { $sum: 1 },
        totalRevenue: { $sum: '$amountTotal' }
      }},
      { $sort: { completedOrders: -1 } },
      { $limit: 10 },
      { $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'providerData'
      }},
      { $unwind: '$providerData' },
      { $project: {
        providerId: '$_id',
        providerName: '$providerData.name',
        completedOrders: 1,
        totalRevenue: 1
      }}
    ]);

    // 6. Najpopularniejsze usługi
    const topServices = await Order.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$service',
        count: { $sum: 1 },
        totalRevenue: { $sum: '$amountTotal' }
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      company: {
        _id: company._id,
        name: company.name,
        teamSize: company.teamSize
      },
      orders: {
        byStatus: ordersStats,
        total: ordersStats.reduce((sum, s) => sum + s.count, 0),
        totalRevenue: ordersStats.reduce((sum, s) => sum + s.totalAmount, 0)
      },
      revenue: {
        byPurpose: revenueStats,
        total: revenueStats.reduce((sum, r) => sum + r.total, 0)
      },
      ratings: ratingsStats[0] || { avgRating: 0, count: 0 },
      offers: {
        byStatus: offersStats,
        total: offersStats.reduce((sum, o) => sum + o.count, 0)
      },
      topProviders,
      topServices
    });
  } catch (error) {
    console.error('COMPANY_ANALYTICS_SUMMARY_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk firmy' });
  }
});

// GET /api/companies/:companyId/analytics/team-performance - Wydajność zespołu
router.get('/:companyId/analytics/team-performance', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();

    const company = req.company;
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];

    // Wydajność każdego wykonawcy
    const teamPerformance = await Order.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        createdAt: { $gte: start, $lte: end }
      }},
      { $group: {
        _id: '$provider',
        totalOrders: { $sum: 1 },
        completedOrders: { $sum: { $cond: [{ $in: ['$status', ['completed', 'closed']] }, 1, 0] } },
        totalRevenue: { $sum: '$amountTotal' },
        avgResponseTime: { $avg: '$responseTime' } // jeśli jest pole
      }},
      { $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'providerData'
      }},
      { $unwind: '$providerData' },
      { $lookup: {
        from: 'ratings',
        localField: '_id',
        foreignField: 'to',
        as: 'ratings'
      }},
      { $project: {
        providerId: '$_id',
        providerName: '$providerData.name',
        providerEmail: '$providerData.email',
        roleInCompany: '$providerData.roleInCompany',
        totalOrders: 1,
        completedOrders: 1,
        completionRate: { $cond: [{ $gt: ['$totalOrders', 0] }, { $divide: ['$completedOrders', '$totalOrders'] }, 0] },
        totalRevenue: 1,
        avgRating: { $avg: '$ratings.rating' },
        ratingCount: { $size: '$ratings' }
      }},
      { $sort: { totalRevenue: -1 } }
    ]);

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      teamPerformance
    });
  } catch (error) {
    console.error('COMPANY_TEAM_PERFORMANCE_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania wydajności zespołu' });
  }
});

// GET /api/companies/:companyId/analytics/revenue-report - Raport przychodów
router.get('/:companyId/analytics/revenue-report', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const from = req.query.from ? dayjs(req.query.from) : dayjs().subtract(30, 'day');
    const to = req.query.to ? dayjs(req.query.to) : dayjs();
    const start = from.startOf('day').toDate();
    const end = to.endOf('day').toDate();
    const groupBy = req.query.groupBy || 'day'; // day, week, month

    const company = req.company;
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];

    let dateFormat = '%Y-%m-%d';
    if (groupBy === 'week') dateFormat = '%Y-W%V';
    if (groupBy === 'month') dateFormat = '%Y-%m';

    const revenueReport = await Payment.aggregate([
      { $match: {
        provider: { $in: companyProviders },
        status: 'succeeded',
        createdAt: { $gte: start, $lte: end }
      }},
      { $project: {
        date: { $dateToString: { format: dateFormat, date: '$createdAt' } },
        amount: 1,
        purpose: 1,
        provider: 1
      }},
      { $group: {
        _id: { date: '$date', purpose: '$purpose' },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }},
      { $sort: { '_id.date': 1 } }
    ]);

    res.json({
      range: { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
      groupBy,
      revenueReport
    });
  } catch (error) {
    console.error('COMPANY_REVENUE_REPORT_ERROR:', error);
    res.status(500).json({ message: 'Błąd pobierania raportu przychodów' });
  }
});

// GET /api/companies/:companyId/analytics/export - Eksport danych (CSV/JSON)
router.get('/:companyId/analytics/export', authMiddleware, requireCompanyAccess, async (req, res) => {
  try {
    const { companyId } = req.params;
    const format = req.query.format || 'json'; // json, csv
    const dataset = req.query.dataset || 'summary'; // summary, orders, revenue, team

    const company = req.company;
    const companyProviders = [
      company.owner,
      ...company.managers,
      ...company.providers
    ];

    let data = {};

    if (dataset === 'orders') {
      const orders = await Order.find({
        provider: { $in: companyProviders }
      })
        .populate('client', 'name email')
        .populate('provider', 'name email')
        .lean();
      
      data = orders.map(o => ({
        orderId: o._id,
        service: o.service,
        client: o.client?.name || '',
        provider: o.provider?.name || '',
        amount: o.amountTotal / 100,
        status: o.status,
        createdAt: o.createdAt
      }));
    } else if (dataset === 'revenue') {
      const payments = await Payment.find({
        provider: { $in: companyProviders },
        status: 'succeeded'
      })
        .populate('provider', 'name email')
        .lean();
      
      data = payments.map(p => ({
        paymentId: p._id,
        provider: p.provider?.name || '',
        purpose: p.purpose,
        amount: p.amount / 100,
        currency: p.currency,
        createdAt: p.createdAt
      }));
    } else {
      // summary - użyj endpointu summary
      // (uproszczone, w produkcji można użyć istniejącego endpointu)
      data = { message: 'Use /summary endpoint for summary data' };
    }

    if (format === 'csv') {
      // Konwersja do CSV (uproszczone)
      const csv = convertToCSV(data);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="company_${companyId}_${dataset}_${Date.now()}.csv"`);
      return res.send(csv);
    }

    res.json({ data });
  } catch (error) {
    console.error('COMPANY_EXPORT_ERROR:', error);
    res.status(500).json({ message: 'Błąd eksportu danych' });
  }
});

// Helper do konwersji do CSV
function convertToCSV(data) {
  if (!Array.isArray(data) || data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(header => {
    const value = row[header];
    return typeof value === 'string' && value.includes(',') ? `"${value}"` : value;
  }).join(','));
  
  return [headers.join(','), ...rows].join('\n');
}

module.exports = router;













