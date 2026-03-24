const express = require('express');
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const User = require('../models/User');
const { BADGES, BADGE_DESCRIPTIONS, TIER_BENEFITS, TIER_THRESHOLDS, checkAllBadges, updateUserTier } = require('../utils/gamification');

const router = express.Router();

// GET /api/gamification/me - pobierz gamification data użytkownika
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('gamification loyaltyPoints');
    if (!user) {
      return res.status(404).json({ message: 'Użytkownik nie znaleziony' });
    }
    
    const badges = (user.gamification?.badges || []).map(badgeId => ({
      id: badgeId,
      ...BADGE_DESCRIPTIONS[badgeId]
    })).filter(b => b.name); // Filtruj tylko te z opisem
    
    // Pobierz aktualne punkty
    const PointTransaction = require('../models/PointTransaction');
    const lastTx = await PointTransaction.findOne({ user: req.user._id }).sort({ createdAt: -1 });
    const currentPoints = lastTx?.balanceAfter || 0;
    
    // Aktualizuj tier jeśli potrzeba
    const tierUpdate = await updateUserTier(req.user._id);
    const currentTier = tierUpdate?.newTier || user.gamification?.tier || 'bronze';
    
    // Pobierz aktualne dane użytkownika po aktualizacji
    const updatedUser = await User.findById(req.user._id).select('gamification');
    
    const tierInfo = TIER_BENEFITS[currentTier];
    const nextTier = currentTier === 'bronze' ? 'silver' : currentTier === 'silver' ? 'gold' : currentTier === 'gold' ? 'platinum' : null;
    const nextTierThreshold = nextTier ? TIER_THRESHOLDS[nextTier] : null;
    const pointsToNextTier = nextTierThreshold ? Math.max(0, nextTierThreshold - currentPoints) : null;
    
    res.json({
      badges,
      loginStreak: updatedUser.gamification?.loginStreak || 0,
      achievements: updatedUser.gamification?.achievements || [],
      tier: {
        current: currentTier,
        ...tierInfo,
        points: currentPoints,
        nextTier: nextTier ? {
          name: nextTier,
          ...TIER_BENEFITS[nextTier],
          threshold: nextTierThreshold,
          pointsNeeded: pointsToNextTier
        } : null
      },
      points: currentPoints
    });
  } catch (error) {
    console.error('Error fetching gamification data:', error);
    res.status(500).json({ message: 'Błąd pobierania danych gamification' });
  }
});

// POST /api/gamification/check - ręczne sprawdzenie wszystkich badges
router.post('/check', auth, async (req, res) => {
  try {
    await checkAllBadges(req.user._id);
    res.json({ message: 'Badges sprawdzone' });
  } catch (error) {
    console.error('Error checking badges:', error);
    res.status(500).json({ message: 'Błąd sprawdzania badges' });
  }
});

module.exports = router;

