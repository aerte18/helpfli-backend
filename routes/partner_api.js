// Publiczne API dla partnerów
const express = require('express');
const router = express.Router();
const { partnerAuth, requirePartnerPermission } = require('../middleware/partnerAuth');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Rating = require('../models/Rating');

// Wszystkie endpointy wymagają autoryzacji partnera
router.use(partnerAuth);

// GET /api/partner/health - Health check dla partnerów
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    partner: {
      name: req.partner.name,
      permissions: req.partner.permissions
    },
    timestamp: new Date().toISOString()
  });
});

// GET /api/partner/orders - Lista zleceń (z uprawnieniami)
router.get('/orders', requirePartnerPermission('readOrders'), async (req, res) => {
  try {
    const { status, from, to, limit = 50, offset = 0 } = req.query;
    
    const query = {};
    if (status) query.status = status;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    const orders = await Order.find(query)
      .populate('client', 'name email')
      .populate('provider', 'name email')
      .select('-__v')
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .sort({ createdAt: -1 })
      .lean();

    const total = await Order.countDocuments(query);

    res.json({
      orders,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: total > parseInt(offset) + parseInt(limit)
      }
    });
  } catch (error) {
    console.error('PARTNER_ORDERS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania zleceń' });
  }
});

// GET /api/partner/orders/:orderId - Szczegóły zlecenia
router.get('/orders/:orderId', requirePartnerPermission('readOrders'), async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const order = await Order.findById(orderId)
      .populate('client', 'name email phone')
      .populate('provider', 'name email phone')
      .lean();

    if (!order) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Zlecenie nie znalezione' });
    }

    res.json({ order });
  } catch (error) {
    console.error('PARTNER_ORDER_DETAILS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania zlecenia' });
  }
});

// GET /api/partner/providers - Lista wykonawców
router.get('/providers', requirePartnerPermission('readProviders'), async (req, res) => {
  try {
    const { verified, tier, limit = 50, offset = 0 } = req.query;
    
    const query = { role: 'provider' };
    if (verified === 'true') query.verified = true;
    if (tier) query.providerTier = tier;

    const providers = await User.find(query)
      .select('name email avatar ratingAvg ratingCount providerTier verified location')
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await User.countDocuments(query);

    res.json({
      providers,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: total > parseInt(offset) + parseInt(limit)
      }
    });
  } catch (error) {
    console.error('PARTNER_PROVIDERS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania wykonawców' });
  }
});

// GET /api/partner/providers/:providerId - Szczegóły wykonawcy
router.get('/providers/:providerId', requirePartnerPermission('readProviders'), async (req, res) => {
  try {
    const { providerId } = req.params;
    
    const provider = await User.findById(providerId)
      .select('-password -emailVerificationToken')
      .lean();

    if (!provider || provider.role !== 'provider') {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Wykonawca nie znaleziony' });
    }

    // Dodaj statystyki
    const stats = {
      totalOrders: await Order.countDocuments({ provider: providerId }),
      completedOrders: await Order.countDocuments({ provider: providerId, status: { $in: ['completed', 'closed'] } }),
      totalRevenue: await Payment.aggregate([
        { $match: { provider: providerId, status: 'succeeded' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).then(r => r[0]?.total || 0),
      avgRating: provider.ratingAvg || 0,
      ratingCount: provider.ratingCount || 0
    };

    res.json({ provider, stats });
  } catch (error) {
    console.error('PARTNER_PROVIDER_DETAILS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania wykonawcy' });
  }
});

// GET /api/partner/analytics - Podstawowe analytics (jeśli ma uprawnienia)
router.get('/analytics', requirePartnerPermission('readAnalytics'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const start = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = to ? new Date(to) : new Date();

    const [totalOrders, totalProviders, totalRevenue] = await Promise.all([
      Order.countDocuments({ createdAt: { $gte: start, $lte: end } }),
      User.countDocuments({ role: 'provider' }),
      Payment.aggregate([
        { $match: { status: 'succeeded', createdAt: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    res.json({
      range: { from: start.toISOString(), to: end.toISOString() },
      summary: {
        totalOrders,
        totalProviders,
        totalRevenue: totalRevenue[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('PARTNER_ANALYTICS_ERROR:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Błąd pobierania analytics' });
  }
});

// GET /api/partner/stats - Statystyki użycia API
router.get('/stats', (req, res) => {
  res.json({
    partner: {
      name: req.partner.name,
      status: req.partner.status
    },
    usage: {
      totalRequests: req.partner.stats.totalRequests,
      requestsToday: req.partner.stats.requestsToday,
      requestsThisHour: req.partner.stats.requestsThisHour,
      lastRequestAt: req.partner.stats.lastRequestAt
    },
    limits: {
      perMinute: req.partner.rateLimit.requestsPerMinute,
      perHour: req.partner.rateLimit.requestsPerHour,
      perDay: req.partner.rateLimit.requestsPerDay
    }
  });
});

module.exports = router;













