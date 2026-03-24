const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const Order = require('../models/Order');
const Rating = require('../models/Rating');
const Message = require('../models/Message');
const router = express.Router();

// Pobierz dane dashboardu zalogowanego użytkownika
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;

    // Podstawowe dane użytkownika
    const user = await User.findById(userId).select('-password').populate('services');

    // Zlecenia (jako klient lub wykonawca)
    const orders = await Order.find({
      $or: [{ client: userId }, { provider: userId }]
    }).populate('client provider service');

    // Opinie (dla tego użytkownika)
    const ratings = await Rating.find({ to: userId }).populate('from', 'name');
    const averageRating =
      ratings.reduce((sum, r) => sum + r.stars, 0) / (ratings.length || 1);

    // Ostatnie wiadomości (z unikalnymi osobami)
    const messages = await Message.find({
      $or: [{ from: userId }, { to: userId }]
    })
      .sort({ createdAt: -1 })
      .limit(30);

    res.json({
      user,
      orders,
      ratings: {
        average: averageRating.toFixed(2),
        total: ratings.length,
        list: ratings
      },
      recentMessages: messages
    });
  } catch (err) {
    res.status(500).json({ message: 'Błąd pobierania danych dashboardu' });
  }
});

module.exports = router;