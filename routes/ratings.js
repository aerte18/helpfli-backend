const express = require('express');
const { authMiddleware } = require('../middleware/authMiddleware');
const Rating = require('../models/Rating');
const router = express.Router();

/** Czy użytkownik jest przypisanym wykonawcą albo należy do zespołu firmy tego wykonawcy (owner/manager/provider w Company). */
async function userActsAsOrderProvider(user, order) {
  const pid =
    order.provider == null ? null : String(order.provider._id || order.provider);
  if (!pid) return false;
  if (String(user._id) === pid) return true;
  if (!user.company) return false;
  const Company = require('../models/Company');
  const company = await Company.findById(user.company).lean();
  if (!company) return false;
  const memberIds = [
    company.owner?.toString(),
    ...(company.managers || []).map((m) => m.toString()),
    ...(company.providers || []).map((p) => p.toString()),
  ].filter(Boolean);
  return memberIds.includes(pid);
}

// Dodaj ocenę (np. klient ocenia wykonawcę)
router.post('/', authMiddleware, async (req, res) => {
  let { ratedUser, rating, comment, orderId } = req.body;

  if (ratedUser && typeof ratedUser === 'object' && ratedUser._id) {
    ratedUser = ratedUser._id;
  }
  if (ratedUser != null) ratedUser = String(ratedUser).trim();
  if (orderId != null) orderId = String(orderId).trim();

  const ratingNum = Number(rating);
  if (!ratedUser || !Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ message: 'Brakuje danych lub nieprawidłowa ocena (1–5)' });
  }
  rating = ratingNum;

  try {
    if (!orderId) {
      return res.status(400).json({
        message: 'Ocena jest możliwa tylko po zakończonym zleceniu — użyj przycisku w szczegółach zlecenia lub profilu po realizacji.',
      });
    }

    if (String(ratedUser) === String(req.user._id)) {
      return res.status(400).json({ message: 'Nie możesz ocenić samego siebie.' });
    }

    const Order = require('../models/Order');
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Zlecenie nie istnieje' });

    const orderClientId = order.client?._id != null ? order.client._id : order.client;
    const orderProviderId = order.provider?._id != null ? order.provider._id : order.provider;

    const isClientRatingProvider =
      String(orderClientId) === String(req.user._id) &&
      String(orderProviderId) === String(ratedUser);
    const actsAsProvider = await userActsAsOrderProvider(req.user, order);
    const isProviderRatingClient =
      actsAsProvider && String(orderClientId) === String(ratedUser);
    if (!isClientRatingProvider && !isProviderRatingClient) {
      return res.status(403).json({ message: 'Brak uprawnień do oceny w tym zleceniu' });
    }
    const doneStatuses = ['completed', 'done', 'closed', 'released', 'rated', 'paid'];
    if (!doneStatuses.includes(order.status)) {
      return res.status(400).json({
        message: 'Zlecenie nie zostało zakończone — ocena będzie możliwa po zakończeniu realizacji i domknięciu zlecenia.',
        orderStatus: order.status,
      });
    }

    const existing = await Rating.findOne({ from: req.user._id, to: ratedUser, orderId });
    if (existing) {
      return res.status(400).json({
        message: 'Już wystawiłeś ocenę dla tego zlecenia',
      });
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

// Konkretne ścieżki przed `/:userId`, inaczej Express dopasuje np. "eligible" lub "avg" jako userId.
// Sprawdź, czy zalogowany użytkownik może ocenić wskazanego użytkownika (czy mają zakończone zlecenie)
router.get('/eligible', authMiddleware, async (req, res) => {
  try {
    const otherUser = req.query.otherUser;
    if (!otherUser) return res.status(400).json({ eligible: false, reason: 'Brak otherUser' });
    if (String(otherUser) === String(req.user._id)) {
      return res.json({ eligible: false, reason: 'self' });
    }

    const Order = require('../models/Order');
    const doneStatuses = ['completed', 'done', 'closed', 'released', 'rated', 'paid'];

    const findUnratedOrder = async (orderQuery, ratingRole) => {
      const candidates = await Order.find({
        status: { $in: doneStatuses },
        ...orderQuery,
      })
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean();

      for (const candidate of candidates) {
        const already = await Rating.findOne({
          from: req.user._id,
          to: otherUser,
          orderId: candidate._id,
        }).lean();
        if (!already) {
          return { order: candidate, ratingRole };
        }
      }
      return null;
    };

    // Klient ocenia wykonawcę
    let match = await findUnratedOrder(
      { client: req.user._id, provider: otherUser },
      'client_rates_provider'
    );

    // Wykonawca (lub członek firmy) ocenia klienta
    if (!match) {
      const asProviderOrders = await Order.find({
        status: { $in: doneStatuses },
        client: otherUser,
        provider: { $exists: true, $ne: null },
      })
        .sort({ updatedAt: -1 })
        .limit(30)
        .lean();

      for (const candidate of asProviderOrders) {
        if (!(await userActsAsOrderProvider(req.user, candidate))) continue;
        const already = await Rating.findOne({
          from: req.user._id,
          to: otherUser,
          orderId: candidate._id,
        }).lean();
        if (!already) {
          match = { order: candidate, ratingRole: 'provider_rates_client' };
          break;
        }
      }
    }

    if (!match) {
      return res.json({ eligible: false, reason: 'no_completed_order' });
    }

    const heading =
      match.ratingRole === 'provider_rates_client' ? 'Oceń klienta' : 'Oceń wykonawcę';

    res.json({
      eligible: true,
      orderId: String(match.order._id),
      ratingRole: match.ratingRole,
      heading,
    });
  } catch (e) {
    console.error('GET /ratings/eligible error:', e);
    res.status(500).json({ eligible: false });
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

module.exports = router;