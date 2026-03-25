// Social features routes - recenzje, portfolio, galeria, referral
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/authMiddleware');
const Rating = require('../models/Rating');
const PortfolioItem = require('../models/Portfolio');
const Referral = require('../models/Referral');
const User = require('../models/User');
const Order = require('../models/Order');
const { remember, delPrefix } = require('../utils/cache');

// Konfiguracja multer dla zdjęć portfolio
const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/portfolio');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${req.user._id}_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
    cb(null, filename);
  }
});

const portfolioUpload = multer({
  storage: portfolioStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Tylko pliki obrazów (JPEG, PNG, GIF, WebP) są dozwolone'));
    }
  }
});

// ========== ROZSZERZONE RECENZJE ==========

/**
 * POST /api/social/ratings - Dodaj rozszerzoną recenzję
 */
router.post('/ratings', authMiddleware, async (req, res) => {
  try {
    const { ratedUser, rating, comment, orderId, categories, photos } = req.body;

    if (!ratedUser || !rating) {
      return res.status(400).json({ message: 'Brakuje danych' });
    }

    // Walidacja zlecenia
    if (orderId) {
      const order = await Order.findById(orderId);
      if (!order) return res.status(404).json({ message: 'Zlecenie nie istnieje' });
      
      const isClientRatingProvider = String(order.client) === String(req.user._id) && String(order.provider) === String(ratedUser);
      const isProviderRatingClient = String(order.provider) === String(req.user._id) && String(order.client) === String(ratedUser);
      
      if (!isClientRatingProvider && !isProviderRatingClient) {
        return res.status(403).json({ message: 'Brak uprawnień do oceny w tym zleceniu' });
      }

      const doneStatuses = ['completed', 'done', 'closed'];
      if (!doneStatuses.includes(order.status)) {
        return res.status(400).json({ message: 'Zlecenie nie zostało zakończone' });
      }
    }

    // Sprawdź czy już oceniono
    const existing = await Rating.findOne({ from: req.user._id, to: ratedUser, orderId: orderId || null });
    if (existing) {
      return res.status(400).json({ message: 'Już oceniłeś tego użytkownika dla tego zlecenia' });
    }

    const newRating = await Rating.create({
      from: req.user._id,
      to: ratedUser,
      orderId: orderId || undefined,
      rating,
      comment,
      categories: categories || {},
      photos: photos || [],
      verified: !!orderId // Jeśli powiązane ze zleceniem, automatycznie zweryfikowane
    });

    // Wyczyść cache dla tego użytkownika
    await delPrefix(`ratings:${ratedUser}:`);
    await delPrefix(`categoryAverages:${ratedUser}`);

    // Aktualizuj średnią ocen użytkownika
    await updateUserRating(ratedUser);

    res.status(201).json(newRating);
  } catch (err) {
    console.error('Błąd przy dodawaniu recenzji:', err);
    res.status(500).json({ message: 'Błąd przy dodawaniu recenzji' });
  }
});

/**
 * GET /api/social/ratings/:userId - Pobierz recenzje użytkownika
 */
router.get('/ratings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { verified, limit = 20, offset = 0 } = req.query;

    // Cache key
    const cacheKey = `ratings:${userId}:${verified || 'all'}:${limit}:${offset}`;
    
    const result = await remember(cacheKey, 120, async () => {
      const query = { to: userId, status: 'active' };
      if (verified !== undefined) {
        query.verified = verified === 'true';
      }

      const ratings = await Rating.find(query)
        .populate('from', 'name avatar')
        .populate('orderId', 'service title')
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(offset));

      const total = await Rating.countDocuments(query);

      // Oblicz średnie dla kategorii (z cache)
      const categoryAverages = await remember(`categoryAverages:${userId}`, 300, async () => {
        return await calculateCategoryAverages(userId);
      });

      return {
        ratings,
        total,
        categoryAverages,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: total > parseInt(offset) + parseInt(limit)
        }
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Błąd pobierania recenzji:', err);
    res.status(500).json({ message: 'Błąd pobierania recenzji' });
  }
});

/**
 * POST /api/social/ratings/:ratingId/helpful - Oznacz recenzję jako pomocną
 */
router.post('/ratings/:ratingId/helpful', authMiddleware, async (req, res) => {
  try {
    const { ratingId } = req.params;
    const rating = await Rating.findById(ratingId);

    if (!rating) {
      return res.status(404).json({ message: 'Recenzja nie znaleziona' });
    }

    const userId = req.user._id;
    const isHelpful = rating.helpfulUsers.includes(userId);

    if (isHelpful) {
      // Usuń oznaczenie
      rating.helpfulUsers = rating.helpfulUsers.filter(id => String(id) !== String(userId));
      rating.helpful = Math.max(0, rating.helpful - 1);
    } else {
      // Dodaj oznaczenie
      rating.helpfulUsers.push(userId);
      rating.helpful += 1;
    }

    await rating.save();
    res.json({ helpful: rating.helpful, isHelpful: !isHelpful });
  } catch (err) {
    console.error('Błąd oznaczenia recenzji:', err);
    res.status(500).json({ message: 'Błąd oznaczenia recenzji' });
  }
});

/**
 * POST /api/social/ratings/:ratingId/response - Odpowiedz na recenzję (tylko wykonawca)
 */
router.post('/ratings/:ratingId/response', authMiddleware, async (req, res) => {
  try {
    const { ratingId } = req.params;
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ message: 'Brak tekstu odpowiedzi' });
    }

    const rating = await Rating.findById(ratingId);
    if (!rating) {
      return res.status(404).json({ message: 'Recenzja nie znaleziona' });
    }

    // Tylko wykonawca może odpowiadać
    if (String(rating.to) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Tylko wykonawca może odpowiadać na recenzję' });
    }

    rating.response = {
      text,
      createdAt: new Date()
    };

    await rating.save();
    res.json(rating);
  } catch (err) {
    console.error('Błąd dodawania odpowiedzi:', err);
    res.status(500).json({ message: 'Błąd dodawania odpowiedzi' });
  }
});

// ========== PORTFOLIO ==========

/**
 * POST /api/social/portfolio/upload - Upload zdjęć portfolio
 */
router.post('/portfolio/upload', authMiddleware, portfolioUpload.array('images', 10), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role !== 'provider') {
      // Usuń przesłane pliki jeśli błąd
      if (req.files) {
        req.files.forEach(file => fs.unlink(file.path, () => {}));
      }
      return res.status(403).json({ message: 'Tylko wykonawcy mogą przesyłać zdjęcia portfolio' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'Nie wybrano plików' });
    }

    const uploadedUrls = req.files.map(file => `/uploads/portfolio/${file.filename}`);
    
    res.json({
      success: true,
      urls: uploadedUrls,
      message: `Przesłano ${uploadedUrls.length} zdjęć`
    });
  } catch (err) {
    console.error('Błąd uploadu zdjęć portfolio:', err);
    // Usuń przesłane pliki jeśli błąd
    if (req.files) {
      req.files.forEach(file => fs.unlink(file.path, () => {}));
    }
    res.status(500).json({ message: err.message || 'Błąd przesyłania zdjęć' });
  }
});

/**
 * POST /api/social/portfolio - Dodaj element do portfolio
 */
router.post('/portfolio', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko wykonawcy mogą dodawać portfolio' });
    }

    const { title, description, category, service, photos, beforeAfter, location, completedAt, orderId, tags, featured } = req.body;

    if (!title || !photos || photos.length === 0) {
      return res.status(400).json({ message: 'Tytuł i przynajmniej jedno zdjęcie są wymagane' });
    }

    const portfolioItem = await PortfolioItem.create({
      provider: req.user._id,
      title,
      description,
      category,
      service,
      photos: photos.map((url, index) => ({ url, order: index })),
      beforeAfter: beforeAfter || {},
      location,
      completedAt: completedAt ? new Date(completedAt) : new Date(),
      orderId,
      tags: tags || [],
      featured: featured || false,
      status: 'published'
    });

    // Wyczyść cache portfolio dla tego wykonawcy
    await delPrefix(`portfolio:${req.user._id}:`);

    res.status(201).json(portfolioItem);
  } catch (err) {
    console.error('Błąd dodawania portfolio:', err);
    res.status(500).json({ message: 'Błąd dodawania portfolio' });
  }
});

/**
 * GET /api/social/portfolio/:providerId - Pobierz portfolio wykonawcy
 */
router.get('/portfolio/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const { category, service, featured, limit = 20, offset = 0 } = req.query;

    // Cache key
    const cacheKey = `portfolio:${providerId}:${category || 'all'}:${service || 'all'}:${featured || 'all'}:${limit}:${offset}`;
    
    const result = await remember(cacheKey, 300, async () => {
      const query = { provider: providerId, status: 'published' };
      if (category) query.category = category;
      if (service) query.service = service;
      if (featured === 'true') query.featured = true;

      const items = await PortfolioItem.find(query)
        .sort({ featured: -1, createdAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(offset));

      const total = await PortfolioItem.countDocuments(query);

      return {
        items,
        total,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: total > parseInt(offset) + parseInt(limit)
        }
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Błąd pobierania portfolio:', err);
    res.status(500).json({ message: 'Błąd pobierania portfolio' });
  }
});

/**
 * POST /api/social/portfolio/:itemId/like - Polub element portfolio
 */
router.post('/portfolio/:itemId/like', authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = await PortfolioItem.findById(itemId);

    if (!item) {
      return res.status(404).json({ message: 'Element portfolio nie znaleziony' });
    }

    const userId = req.user._id;
    const isLiked = item.likedBy.includes(userId);

    if (isLiked) {
      item.likedBy = item.likedBy.filter(id => String(id) !== String(userId));
      item.likes = Math.max(0, item.likes - 1);
    } else {
      item.likedBy.push(userId);
      item.likes += 1;
    }

    await item.save();
    res.json({ likes: item.likes, isLiked: !isLiked });
  } catch (err) {
    console.error('Błąd polubienia:', err);
    res.status(500).json({ message: 'Błąd polubienia' });
  }
});

// ========== REFERRAL (POLEcenia) ==========

/**
 * POST /api/social/referral/generate - Wygeneruj kod polecenia
 */
router.post('/referral/generate', authMiddleware, async (req, res) => {
  try {
    const { type = 'both', rewardCondition, referrerReward, referredReward, expiresInDays = 90 } = req.body;

    // Generuj unikalny kod
    const code = generateReferralCode(req.user._id);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const referral = await Referral.create({
      referrer: req.user._id,
      code,
      type,
      rewardCondition: rewardCondition || { type: 'first_completed_order' },
      referrerReward: referrerReward || { type: 'points', amount: 100 },
      referredReward: referredReward || { type: 'points', amount: 50 },
      expiresAt,
      status: 'pending'
    });

    res.status(201).json(referral);
  } catch (err) {
    console.error('Błąd generowania kodu polecenia:', err);
    res.status(500).json({ message: 'Błąd generowania kodu polecenia' });
  }
});

/**
 * POST /api/social/referral/apply - Zastosuj kod polecenia
 */
router.post('/referral/apply', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ message: 'Brak kodu polecenia' });
    }

    const referral = await Referral.findOne({ code, status: 'pending' });

    if (!referral) {
      return res.status(404).json({ message: 'Kod polecenia nie znaleziony lub już użyty' });
    }

    if (referral.expiresAt && referral.expiresAt < new Date()) {
      referral.status = 'expired';
      await referral.save();
      return res.status(400).json({ message: 'Kod polecenia wygasł' });
    }

    // Nie można użyć własnego kodu
    if (String(referral.referrer) === String(req.user._id)) {
      return res.status(400).json({ message: 'Nie możesz użyć własnego kodu polecenia' });
    }

    referral.referred = req.user._id;
    referral.status = 'completed';
    await referral.save();

    // Zastosuj nagrody (można to zrobić asynchronicznie)
    await applyReferralRewards(referral);

    res.json({ message: 'Kod polecenia zastosowany pomyślnie', referral });
  } catch (err) {
    console.error('Błąd zastosowania kodu polecenia:', err);
    res.status(500).json({ message: 'Błąd zastosowania kodu polecenia' });
  }
});

/**
 * GET /api/social/referral/my - Pobierz moje kody polecenia
 */
router.get('/referral/my', authMiddleware, async (req, res) => {
  try {
    const referrals = await Referral.find({ referrer: req.user._id })
      .populate('referred', 'name email')
      .sort({ createdAt: -1 });

    res.json({ referrals });
  } catch (err) {
    console.error('Błąd pobierania kodów polecenia:', err);
    res.status(500).json({ message: 'Błąd pobierania kodów polecenia' });
  }
});

// Helper functions

async function updateUserRating(userId) {
  const ratings = await Rating.find({ to: userId, status: 'active' });
  const avg = ratings.length > 0
    ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
    : 0;

  await User.findByIdAndUpdate(userId, {
    rating: Number(avg.toFixed(2)),
    ratingCount: ratings.length
  });
}

async function calculateCategoryAverages(userId) {
  const ratings = await Rating.find({ to: userId, status: 'active', categories: { $exists: true } });
  
  const categories = ['quality', 'punctuality', 'communication', 'price', 'professionalism'];
  const averages = {};

  categories.forEach(cat => {
    const values = ratings
      .map(r => r.categories?.[cat])
      .filter(v => v !== undefined && v !== null);
    
    if (values.length > 0) {
      averages[cat] = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
    }
  });

  return averages;
}

function generateReferralCode(userId) {
  const prefix = 'HELPFLI';
  const timestamp = Date.now().toString(36).toUpperCase();
  const userHash = userId.toString().slice(-4).toUpperCase();
  return `${prefix}-${timestamp}-${userHash}`;
}

async function applyReferralRewards(referral) {
  // Zastosuj nagrodę dla polecającego
  if (referral.referrerReward && !referral.referrerReward.applied) {
    const referrer = await User.findById(referral.referrer);
    if (referrer) {
      if (referral.referrerReward.type === 'points') {
        referrer.rankingPoints = (referrer.rankingPoints || 0) + referral.referrerReward.amount;
      }
      // Można dodać inne typy nagród
      await referrer.save();
      
      referral.referrerReward.applied = true;
      referral.referrerReward.appliedAt = new Date();
    }
  }

  // Zastosuj nagrodę dla poleconego
  if (referral.referredReward && !referral.referredReward.applied && referral.referred) {
    const referred = await User.findById(referral.referred);
    if (referred) {
      if (referral.referredReward.type === 'points') {
        referred.rankingPoints = (referred.rankingPoints || 0) + referral.referredReward.amount;
      }
      await referred.save();
      
      referral.referredReward.applied = true;
      referral.referredReward.appliedAt = new Date();
    }
  }

  await referral.save();
}

module.exports = router;

