const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');

// GET /api/user/stats - pobierz statystyki użytkownika
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Mock data - w przyszłości można pobrać z bazy danych
    const stats = {
      orders: userRole === 'client' ? 12 : 45,
      activeOrders: userRole === 'client' ? 2 : 0,
      pendingOrders: userRole === 'provider' ? 3 : 0,
      completedOrders: userRole === 'client' ? 10 : 42,
      favorites: userRole === 'client' ? 5 : 0,
      rating: userRole === 'provider' ? 4.8 : 0,
      monthlyOrders: userRole === 'provider' ? 12 : 0,
      monthlyRevenue: userRole === 'provider' ? 2400 : 0
    };

    res.json(stats);
  } catch (error) {
    console.error('Błąd pobierania statystyk użytkownika:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

module.exports = router;
