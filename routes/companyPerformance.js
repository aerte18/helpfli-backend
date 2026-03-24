const express = require('express');
const Company = require('../models/Company');
const Order = require('../models/Order');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Middleware sprawdzające uprawnienia do zarządzania firmą (lokalna kopia, żeby uniknąć circular dependency)
const requireCompanyAccess = async (req, res, next) => {
  try {
    const companyId = req.params.companyId || req.body.companyId;
    const user = await User.findById(req.user._id).populate('company');
    
    if (!companyId) {
      return res.status(400).json({ message: 'ID firmy jest wymagane' });
    }

    // Sprawdź czy użytkownik ma dostęp do firmy
    if (user.company && user.company._id.toString() === companyId) {
      if (user.canManageCompany()) {
        req.companyAccess = { canManage: true, canView: true };
        req.companyId = companyId;
        return next();
      } else {
        req.companyAccess = { canManage: false, canView: true };
        req.companyId = companyId;
        return next();
      }
    }

    // Sprawdź czy użytkownik jest adminem
    if (user.role === 'admin') {
      req.companyAccess = { canManage: true, canView: true };
      req.companyId = companyId;
      return next();
    }

    return res.status(403).json({ message: 'Brak uprawnień do tej firmy' });
  } catch (error) {
    res.status(500).json({ message: 'Błąd serwera', error: error.message });
  }
};

// GET /api/companies/:companyId/performance - Analityka wydajności zespołu
router.get('/:companyId/performance', auth, requireCompanyAccess, async (req, res) => {
  try {
    const companyId = req.params.companyId || req.companyId;
    const { startDate, endDate, memberId } = req.query;
    
    const company = await Company.findById(companyId).populate('providers managers owner');
    if (!company) {
      return res.status(404).json({ message: 'Firma nie znaleziona' });
    }
    
    // Określ zakres dat
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Domyślnie ostatnie 30 dni
    const end = endDate ? new Date(endDate) : new Date();
    
    // Pobierz wszystkich członków zespołu
    const teamMembers = [
      ...(company.owner ? [company.owner] : []),
      ...(company.managers || []),
      ...(company.providers || [])
    ];
    
    // Filtruj po członku jeśli podano
    const membersToAnalyze = memberId 
      ? teamMembers.filter(m => m._id.toString() === memberId)
      : teamMembers;
    
    // Pobierz zlecenia dla członków zespołu
    const memberIds = membersToAnalyze.map(m => m._id);
    
    const orders = await Order.find({
      provider: { $in: memberIds },
      createdAt: { $gte: start, $lte: end },
      status: { $in: ['completed', 'cancelled', 'in_progress'] }
    }).populate('provider', 'name email').populate('client', 'name email');
    
    // Oblicz statystyki per członek
    const performanceData = membersToAnalyze.map(member => {
      const memberOrders = orders.filter(o => o.provider?._id.toString() === member._id.toString());
      
      const completedOrders = memberOrders.filter(o => o.status === 'completed');
      const cancelledOrders = memberOrders.filter(o => o.status === 'cancelled');
      const inProgressOrders = memberOrders.filter(o => o.status === 'in_progress');
      
      // Oblicz przychód
      const revenue = completedOrders.reduce((sum, order) => {
        return sum + (order.finalPrice || order.price || 0);
      }, 0);
      
      // Oblicz średnią ocenę
      const ratings = completedOrders
        .map(o => o.rating)
        .filter(r => r && r > 0);
      const avgRating = ratings.length > 0
        ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length
        : 0;
      
      // Oblicz czas realizacji (średni)
      const completionTimes = completedOrders
        .map(o => {
          if (o.completedAt && o.createdAt) {
            return (new Date(o.completedAt) - new Date(o.createdAt)) / (1000 * 60 * 60); // W godzinach
          }
          return null;
        })
        .filter(t => t !== null);
      const avgCompletionTime = completionTimes.length > 0
        ? completionTimes.reduce((sum, t) => sum + t, 0) / completionTimes.length
        : 0;
      
      // Oblicz wskaźnik anulowań
      const cancellationRate = memberOrders.length > 0
        ? (cancelledOrders.length / memberOrders.length) * 100
        : 0;
      
      return {
        member: {
          _id: member._id,
          name: member.name,
          email: member.email,
          roleInCompany: member.roleInCompany
        },
        stats: {
          totalOrders: memberOrders.length,
          completedOrders: completedOrders.length,
          cancelledOrders: cancelledOrders.length,
          inProgressOrders: inProgressOrders.length,
          revenue: revenue,
          revenueFormatted: (revenue / 100).toFixed(2) + ' zł',
          avgRating: avgRating.toFixed(2),
          avgCompletionTime: avgCompletionTime.toFixed(1) + ' h',
          cancellationRate: cancellationRate.toFixed(1) + '%',
          completionRate: memberOrders.length > 0 
            ? ((completedOrders.length / memberOrders.length) * 100).toFixed(1) + '%'
            : '0%'
        },
        orders: memberOrders.map(o => ({
          _id: o._id,
          description: o.description,
          status: o.status,
          price: o.finalPrice || o.price || 0,
          rating: o.rating,
          createdAt: o.createdAt,
          completedAt: o.completedAt
        }))
      };
    });
    
    // Statystyki całej firmy
    const companyStats = {
      totalOrders: orders.length,
      completedOrders: orders.filter(o => o.status === 'completed').length,
      totalRevenue: orders
        .filter(o => o.status === 'completed')
        .reduce((sum, o) => sum + (o.finalPrice || o.price || 0), 0),
      avgRating: (() => {
        const ratings = orders
          .filter(o => o.status === 'completed')
          .map(o => o.rating)
          .filter(r => r && r > 0);
        return ratings.length > 0
          ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)
          : '0.00';
      })(),
      topPerformers: performanceData
        .sort((a, b) => b.stats.completedOrders - a.stats.completedOrders)
        .slice(0, 5)
        .map(p => ({
          member: p.member,
          completedOrders: p.stats.completedOrders,
          revenue: p.stats.revenueFormatted
        }))
    };
    
    res.json({
      success: true,
      period: {
        startDate: start,
        endDate: end
      },
      companyStats,
      performanceData,
      totalMembers: membersToAnalyze.length
    });
  } catch (error) {
    console.error('Error getting company performance:', error);
    res.status(500).json({ message: 'Błąd pobierania analityki', error: error.message });
  }
});

module.exports = router;







