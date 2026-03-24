const express = require("express");
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Revenue = require("../models/Revenue");
const Order = require("../models/Order");

const router = express.Router();

/**
 * GET /api/revenue/stats - statystyki przychodów (tylko admin)
 */
router.get("/stats", auth, async (req, res) => {
  try {
    // Sprawdź czy użytkownik to admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: "Brak uprawnień" });
    }

    const { period = '30d', type } = req.query;
    
    // Oblicz datę początkową
    const now = new Date();
    let startDate;
    switch (period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case '1y':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    // Filtry
    const filter = {
      createdAt: { $gte: startDate },
      status: 'paid'
    };
    
    if (type) {
      filter.type = type;
    }

    // Agregacja przychodów
    const stats = await Revenue.aggregate([
      { $match: filter },
      {
        $group: {
          _id: {
            type: "$type",
            month: { $month: "$createdAt" },
            year: { $year: "$createdAt" }
          },
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.type",
          totalAmount: { $sum: "$totalAmount" },
          totalCount: { $sum: "$count" },
          monthly: {
            $push: {
              month: "$_id.month",
              year: "$_id.year",
              amount: "$totalAmount",
              count: "$count"
            }
          }
        }
      }
    ]);

    // Przychody według typu
    const revenueByType = {};
    stats.forEach(stat => {
      revenueByType[stat._id] = {
        totalAmount: stat.totalAmount,
        totalCount: stat.totalCount,
        monthly: stat.monthly
      };
    });

    // Całkowite przychody
    const totalRevenue = await Revenue.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          totalCount: { $sum: 1 }
        }
      }
    ]);

    // Przychody z priorytetów vs boost
    const priorityRevenue = await Revenue.aggregate([
      { $match: { ...filter, type: "priority_fee" } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          totalCount: { $sum: 1 }
        }
      }
    ]);

    const boostRevenue = await Revenue.aggregate([
      { $match: { ...filter, type: "boost_fee" } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          totalCount: { $sum: 1 }
        }
      }
    ]);

    res.json({
      period,
      startDate,
      endDate: now,
      totalRevenue: totalRevenue[0] || { totalAmount: 0, totalCount: 0 },
      revenueByType,
      priorityRevenue: priorityRevenue[0] || { totalAmount: 0, totalCount: 0 },
      boostRevenue: boostRevenue[0] || { totalAmount: 0, totalCount: 0 }
    });

  } catch (error) {
    console.error("Revenue stats error:", error);
    res.status(500).json({ message: "Błąd pobierania statystyk" });
  }
});

/**
 * GET /api/revenue/transactions - lista transakcji (tylko admin)
 */
router.get("/transactions", auth, async (req, res) => {
  try {
    // Sprawdź czy użytkownik to admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: "Brak uprawnień" });
    }

    const { page = 1, limit = 50, type, status } = req.query;
    const skip = (page - 1) * limit;

    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;

    const transactions = await Revenue.find(filter)
      .populate('orderId', 'service description')
      .populate('clientId', 'name email')
      .populate('providerId', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Revenue.countDocuments(filter);

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("Revenue transactions error:", error);
    res.status(500).json({ message: "Błąd pobierania transakcji" });
  }
});

/**
 * GET /api/revenue/user - rozliczenia użytkownika (client/provider)
 */
router.get("/user", auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20, type, status } = req.query;
    const skip = (page - 1) * limit;

    // Filtruj transakcje użytkownika
    const filter = {
      $or: [
        { clientId: userId },
        { providerId: userId }
      ]
    };
    
    if (type) filter.type = type;
    if (status) filter.status = status;

    const transactions = await Revenue.find(filter)
      .populate('orderId', 'service description status')
      .populate('clientId', 'name email')
      .populate('providerId', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Revenue.countDocuments(filter);

    // Statystyki dla użytkownika
    const stats = await Revenue.aggregate([
      { $match: { $or: [{ clientId: userId }, { providerId: userId }] } },
      {
        $group: {
          _id: null,
          totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
          totalPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
          totalRefunded: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, '$amount', 0] } },
          countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
          countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
        }
      }
    ]);

    const userStats = stats[0] || {
      totalPaid: 0,
      totalPending: 0,
      totalRefunded: 0,
      countPaid: 0,
      countPending: 0
    };

    res.json({
      transactions,
      stats: {
        totalPaid: userStats.totalPaid / 100, // konwersja z groszy
        totalPending: userStats.totalPending / 100,
        totalRefunded: userStats.totalRefunded / 100,
        countPaid: userStats.countPaid,
        countPending: userStats.countPending
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("User revenue error:", error);
    res.status(500).json({ message: "Błąd pobierania rozliczeń" });
  }
});

module.exports = router;


