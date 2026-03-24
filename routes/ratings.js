const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const Rating = require('../models/Rating');
const User = require('../models/User');
const router = express.Router();

// Dodaj ocenę (np. klient ocenia wykonawcę)
router.post('/', authMiddleware, async (req, res) => {
  const { ratedUser, rating, comment, orderId } = req.body;

  if (!ratedUser || !rating) {
    return res.status(400).json({ message: 'Brakuje danych' });
  }

  try {
    // Opcjonalna walidacja: pozwól ocenić tylko gdy użytkownik był klientem w zakończonym zleceniu
    if (orderId) {
      const Order = require('../models/Order');
      const order = await Order.findById(orderId);
      if (!order) return res.status(404).json({ message: 'Zlecenie nie istnieje' });
      const isClientRatingProvider = String(order.client) === String(req.user._id) && String(order.provider) === String(ratedUser);
      const isProviderRatingClient = String(order.provider) === String(req.user._id) && String(order.client) === String(ratedUser);
      if (!isClientRatingProvider && !isProviderRatingClient) {
        return res.status(403).json({ message: 'Brak uprawnień do oceny w tym zleceniu' });
      }
      const doneStatuses = ['completed','done','closed','released'];
      if (!doneStatuses.includes(order.status)) {
        return res.status(400).json({ message: 'Zlecenie nie zostało zakończone' });
      }
    }
    const existing = await Rating.findOne({ from: req.user._id, to: ratedUser });
    if (existing) {
      return res.status(400).json({ message: 'Już oceniłeś tego wykonawcę' });
    }

    const newRating = await Rating.create({
      from: req.user._id,
      to: ratedUser, // mapuj ratedUser na to (zgodnie z modelem)
      rating,
      comment,
      orderId: orderId || undefined
    });

    // Przyznaj 10 punktów za recenzję
    try {
      const PointTransaction = require('../models/PointTransaction');
      const lastTx = await PointTransaction.findOne({ user: req.user._id }).sort({ createdAt: -1 });
      const currentBalance = lastTx?.balanceAfter || 0;
      
      await PointTransaction.create({
        user: req.user._id,
        delta: 10,
        reason: 'review_submitted',
        balanceAfter: currentBalance + 10
      });
      
      console.log(`Awarded 10 points to user ${req.user._id} for review`);
      
      // Gamification: sprawdź badges po napisaniu recenzji
      try {
        const { checkReviewBadges, checkPointsBadges } = require('../utils/gamification');
        await checkReviewBadges(req.user._id);
        await checkPointsBadges(req.user._id);
      } catch (gamificationError) {
        console.error('Error checking review badges:', gamificationError);
      }
    } catch (pointsError) {
      console.error('Error awarding points for review:', pointsError);
      // Nie blokuj tworzenia recenzji jeśli punkty się nie udały
    }

    res.status(201).json(newRating);
  } catch (err) {
    console.error('Błąd przy dodawaniu oceny:', err);
    res.status(500).json({ message: 'Błąd przy dodawaniu oceny' });
  }
});

// Pobierz oceny danego użytkownika
router.get('/:userId', async (req, res) => {
  try {
    const ratings = await Rating.find({ to: req.params.userId })
      .populate('from', 'name')
      .sort({ createdAt: -1 });

    const avg =
      ratings.reduce((sum, r) => sum + r.rating, 0) / (ratings.length || 1);

    res.json({
      average: avg.toFixed(2),
      total: ratings.length,
      ratings
    });
  } catch (err) {
    res.status(500).json({ message: 'Błąd przy pobieraniu ocen' });
  }
});

// GET /api/ratings/avg/:id - pobierz średnią ocen użytkownika
router.get('/avg/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log("⭐ GET_AVERAGE_RATING:", { id });
    
    // Spróbuj znaleźć użytkownika po ID (może być ObjectId lub string)
    const mongoose = require('mongoose');
    let userId = id;
    
    // Jeśli ID wygląda jak MongoDB ObjectId, spróbuj go przekonwertować
    if (mongoose.Types.ObjectId.isValid(id)) {
      userId = new mongoose.Types.ObjectId(id);
    }
    
    // Spróbuj też znaleźć po innych polach (np. jeśli id to email lub name)
    const User = require('../models/User');
    let user = null;
    
    if (mongoose.Types.ObjectId.isValid(id)) {
      user = await User.findById(id).lean();
    }
    
    if (!user) {
      // Spróbuj znaleźć po innych polach
      user = await User.findOne({ 
        $or: [
          { email: id },
          { name: id },
          { _id: id }
        ]
      }).lean();
    }
    
    if (user) {
      userId = user._id;
      console.log("✅ Found user:", { name: user.name, id: userId });
    } else {
      console.log("⚠️ User not found for ID:", id);
      // Zwróć 0 zamiast błędu, jeśli użytkownik nie istnieje
      return res.json({ 
        avg: 0, 
        count: 0,
        ratings: []
      });
    }
    
    const ratings = await Rating.find({ to: userId });
    console.log("📊 Found ratings:", ratings.length);
    
    const avg = ratings.length > 0 
      ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length 
      : 0;
    
    console.log("✅ AVERAGE_RATING:", { avg: avg.toFixed(2), count: ratings.length });
    res.json({ 
      avg: Number(avg.toFixed(2)), 
      count: ratings.length,
      ratings: ratings.map(r => ({
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt
      }))
    });
  } catch (err) {
    console.error('GET_AVERAGE_RATING_ERROR:', err);
    res.status(500).json({ message: 'Błąd serwera' });
  }
});

// Sprawdź, czy zalogowany użytkownik może ocenić wskazanego użytkownika (czy mają zakończone zlecenie)
router.get('/eligible', authMiddleware, async (req, res) => {
  try {
    const otherUser = req.query.otherUser;
    if (!otherUser) return res.status(400).json({ eligible: false, reason: 'Brak otherUser' });
    const Order = require('../models/Order');
    const doneStatuses = ['completed','done','closed'];
    const order = await Order.findOne({
      status: { $in: doneStatuses },
      $or: [
        { client: req.user._id, provider: otherUser },
        { client: otherUser, provider: req.user._id }
      ]
    }).lean();
    res.json({ eligible: !!order });
  } catch (e) {
    res.status(500).json({ eligible: false });
  }
});

module.exports = router;