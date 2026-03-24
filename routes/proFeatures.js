const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');

// GET /api/pro-features/status - sprawdź status funkcji PRO
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Sprawdź czy ma aktywną subskrypcję PRO
    const subscription = await UserSubscription.findOne({ 
      user: userId,
      planKey: 'PROV_PRO',
      validUntil: { $gt: new Date() }
    });
    
    const user = await User.findById(userId);
    
    if (!subscription) {
      return res.json({
        hasProPackage: false,
        features: {
          highlight: false,
          topBadge: false,
          aiRecommendations: false,
          freeBoosts: false,
          advancedStats: false
        }
      });
    }
    
    // Sprawdź aktywne funkcje
    const now = new Date();
    const highlight = user.promo?.highlightUntil && new Date(user.promo.highlightUntil) > now;
    const topBadge = user.promo?.topBadgeUntil && new Date(user.promo.topBadgeUntil) > now;
    const aiRecommendations = user.promo?.aiTopTagUntil && new Date(user.promo.aiTopTagUntil) > now;
    const hasProBadge = user.badges && user.badges.includes('pro');
    
    res.json({
      hasProPackage: true,
      subscription: {
        planKey: subscription.planKey,
        validUntil: subscription.validUntil
      },
      features: {
        highlight,
        topBadge,
        aiRecommendations,
        freeBoosts: true, // Providerzy PRO mają darmowe boosty
        advancedStats: true, // Providerzy PRO mają zaawansowane statystyki
        proBadge: hasProBadge
      }
    });
  } catch (error) {
    console.error('❌ Błąd sprawdzania statusu PRO:', error);
    res.status(500).json({ message: 'Błąd sprawdzania statusu' });
  }
});

// POST /api/pro-features/activate - aktywuj funkcje PRO
router.post('/activate', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Sprawdź czy ma aktywną subskrypcję PRO
    const subscription = await UserSubscription.findOne({ 
      user: userId,
      planKey: 'PROV_PRO',
      validUntil: { $gt: new Date() }
    });
    
    if (!subscription) {
      return res.status(403).json({ message: 'Brak aktywnej subskrypcji PRO' });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie istnieje' });
    }
    
    // Aktywuj funkcje PRO na czas subskrypcji
    const validUntil = subscription.validUntil;
    
    user.promo = user.promo || {};
    user.promo.highlightUntil = validUntil; // Wyróżnienie profilu
    user.promo.topBadgeUntil = validUntil; // Badge TOP
    user.promo.aiTopTagUntil = validUntil; // Polecenia AI
    user.promo.rankBoostPoints = 100; // Maksymalne punkty rankingowe
    user.promo.rankBoostUntil = validUntil;
    
    // Dodaj badge PRO
    if (!user.badges || !user.badges.includes('pro')) {
      user.badges = user.badges || [];
      user.badges.push('pro');
    }
    
    await user.save();
    
    res.json({
      message: 'Funkcje PRO zostały aktywowane',
      validUntil,
      features: {
        highlight: true,
        topBadge: true,
        aiRecommendations: true,
        freeBoosts: true,
        advancedStats: true,
        proBadge: true
      }
    });
  } catch (error) {
    console.error('❌ Błąd aktywacji funkcji PRO:', error);
    res.status(500).json({ message: 'Błąd aktywacji funkcji' });
  }
});

module.exports = router;



