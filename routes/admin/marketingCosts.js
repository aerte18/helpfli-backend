const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/authMiddleware');
const Payment = require('../../models/Payment');
const Referral = require('../../models/Referral');
const PointTransaction = require('../../models/PointTransaction');
const Order = require('../../models/Order');
const dayjs = require('dayjs');

// Middleware - tylko admin
const requireAdmin = async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Dostęp tylko dla administratorów' });
  }
  next();
};

// GET /api/admin/marketing-costs - Raport kosztów marketingowych
router.get('/marketing-costs', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query || {};
    const periodFrom = from ? dayjs(from).startOf('day') : dayjs().startOf('month');
    const periodTo = to ? dayjs(to).endOf('day') : dayjs().endOf('month');

    const start = periodFrom.toDate();
    const end = periodTo.endOf('day').toDate();

    // 1. Koszty zniżek z punktów
    const paymentsWithPointsDiscount = await Payment.aggregate([
      {
        $match: {
          pointsDiscount: { $gt: 0 },
          createdAt: { $gte: start, $lte: end },
          status: 'succeeded'
        }
      },
      {
        $group: {
          _id: null,
          totalPointsDiscount: { $sum: '$pointsDiscount' },
          count: { $sum: 1 },
          byMonth: {
            $push: {
              month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
              discount: '$pointsDiscount'
            }
          }
        }
      }
    ]);

    // 2. Koszty poleceń (punkty przyznane za polecenia)
    const referralCosts = await Referral.aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lte: end },
          status: { $in: ['completed', 'rewarded'] }
        }
      },
      {
        $group: {
          _id: null,
          totalPointsGiven: { $sum: '$referrerReward.points' },
          totalReferrals: { $sum: 1 },
          clientsReferred: {
            $sum: { $cond: [{ $eq: ['$referredRole', 'client'] }, 1, 0] }
          },
          providersReferred: {
            $sum: { $cond: [{ $eq: ['$referredRole', 'provider'] }, 1, 0] }
          }
        }
      }
    ]);

    // 3. Koszty tier discounts (zniżki z poziomów lojalności)
    const ordersWithTierDiscount = await Order.aggregate([
      {
        $match: {
          'pricing.discountTier': { $gt: 0 },
          createdAt: { $gte: start, $lte: end },
          paymentStatus: 'succeeded'
        }
      },
      {
        $group: {
          _id: null,
          totalTierDiscount: { $sum: '$pricing.discountTier' },
          count: { $sum: 1 }
        }
      }
    ]);

    // 4. Koszty promocji (kody rabatowe)
    const ordersWithPromoDiscount = await Order.aggregate([
      {
        $match: {
          'pricing.discountPromo': { $gt: 0 },
          createdAt: { $gte: start, $lte: end },
          paymentStatus: 'succeeded'
        }
      },
      {
        $group: {
          _id: null,
          totalPromoDiscount: { $sum: '$pricing.discountPromo' },
          count: { $sum: 1 }
        }
      }
    ]);

    // 5. Podsumowanie
    const pointsDiscountData = paymentsWithPointsDiscount[0] || { totalPointsDiscount: 0, count: 0 };
    const referralData = referralCosts[0] || { totalPointsGiven: 0, totalReferrals: 0, clientsReferred: 0, providersReferred: 0 };
    const tierDiscountData = ordersWithTierDiscount[0] || { totalTierDiscount: 0, count: 0 };
    const promoDiscountData = ordersWithPromoDiscount[0] || { totalPromoDiscount: 0, count: 0 };

    const totalMarketingCosts = 
      (pointsDiscountData.totalPointsDiscount || 0) +
      (referralData.totalPointsGiven || 0) * 0.1 + // Punkty * 0.1 zł (wartość punktu)
      (tierDiscountData.totalTierDiscount || 0) +
      (promoDiscountData.totalPromoDiscount || 0);

    res.json({
      period: {
        from: periodFrom.format('YYYY-MM-DD'),
        to: periodTo.format('YYYY-MM-DD')
      },
      costs: {
        pointsDiscounts: {
          total: pointsDiscountData.totalPointsDiscount || 0,
          count: pointsDiscountData.count || 0,
          description: 'Zniżki z punktów lojalnościowych (pokrywane przez platformę)'
        },
        referrals: {
          totalPoints: referralData.totalPointsGiven || 0,
          totalCost: (referralData.totalPointsGiven || 0) * 0.1, // Punkty * wartość punktu
          totalReferrals: referralData.totalReferrals || 0,
          clientsReferred: referralData.clientsReferred || 0,
          providersReferred: referralData.providersReferred || 0,
          description: 'Punkty przyznane za polecenia (koszt marketingowy)'
        },
        tierDiscounts: {
          total: tierDiscountData.totalTierDiscount || 0,
          count: tierDiscountData.count || 0,
          description: 'Zniżki z poziomów lojalności (Silver/Gold/Platinum)'
        },
        promoDiscounts: {
          total: promoDiscountData.totalPromoDiscount || 0,
          count: promoDiscountData.count || 0,
          description: 'Zniżki z kodów promocyjnych'
        }
      },
      summary: {
        totalMarketingCosts: totalMarketingCosts,
        totalMarketingCostsPLN: (totalMarketingCosts / 100).toFixed(2) + ' zł'
      }
    });
  } catch (error) {
    console.error('Error getting marketing costs:', error);
    res.status(500).json({ message: 'Błąd pobierania kosztów marketingowych', error: error.message });
  }
});

// GET /api/admin/marketing-costs/payments-breakdown - Szczegółowy breakdown płatności z zniżkami
router.get('/marketing-costs/payments-breakdown', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { from, to, limit = 100 } = req.query || {};
    const periodFrom = from ? dayjs(from).startOf('day') : dayjs().startOf('month');
    const periodTo = to ? dayjs(to).endOf('day') : dayjs().endOf('month');

    const start = periodFrom.toDate();
    const end = periodTo.endOf('day').toDate();

    // Najpierw znajdź płatności z zniżkami z punktów
    const paymentsWithDiscounts = await Payment.find({
      $or: [
        { pointsDiscount: { $gt: 0 } }
      ],
      createdAt: { $gte: start, $lte: end },
      status: 'succeeded'
    })
    .populate('client', 'name email')
    .populate('provider', 'name email')
    .populate('order')
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .lean();
    
    // Znajdź też zlecenia z zniżkami tier/promo
    const ordersWithDiscounts = await Order.find({
      $or: [
        { 'pricing.discountTier': { $gt: 0 } },
        { 'pricing.discountPromo': { $gt: 0 } }
      ],
      createdAt: { $gte: start, $lte: end },
      paymentStatus: 'succeeded',
      paymentId: { $exists: true }
    })
    .populate('client', 'name email')
    .populate('provider', 'name email')
    .populate('paymentId')
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .lean();
    
    // Połącz płatności i zlecenia
    const allPayments = [...paymentsWithDiscounts];
    ordersWithDiscounts.forEach(order => {
      if (order.paymentId && !allPayments.find(p => String(p._id) === String(order.paymentId._id))) {
        allPayments.push({
          ...order.paymentId,
          order: order,
          client: order.client,
          provider: order.provider
        });
      }
    });
    
    const payments = allPayments.slice(0, parseInt(limit));

    const breakdown = payments.map(p => {
      const order = p.order || {};
      const pricing = order.pricing || {};
      
      return {
        paymentId: p._id,
        orderId: order._id,
        date: p.createdAt,
        client: {
          name: p.client?.name || 'Nieznany',
          email: p.client?.email || ''
        },
        provider: {
          name: p.provider?.name || 'Nieznany',
          email: p.provider?.email || ''
        },
        amounts: {
          originalTotal: pricing.originalTotal || p.amount + (p.pointsDiscount || 0),
          clientPaid: p.amount,
          pointsDiscount: p.pointsDiscount || 0,
          tierDiscount: pricing.discountTier || 0,
          promoDiscount: pricing.discountPromo || 0,
          platformFee: p.platformFeeAmount || 0,
          providerReceives: (pricing.originalTotal || p.amount + (p.pointsDiscount || 0)) - (p.platformFeeAmount || 0)
        },
        totalDiscount: (p.pointsDiscount || 0) + (pricing.discountTier || 0) + (pricing.discountPromo || 0)
      };
    });

    res.json({
      period: {
        from: periodFrom.format('YYYY-MM-DD'),
        to: periodTo.format('YYYY-MM-DD')
      },
      breakdown,
      total: breakdown.length
    });
  } catch (error) {
    console.error('Error getting payments breakdown:', error);
    res.status(500).json({ message: 'Błąd pobierania breakdown płatności', error: error.message });
  }
});

module.exports = router;

