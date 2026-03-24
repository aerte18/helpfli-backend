const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const { getCurrentPerformanceDiscount, calculatePerformanceDiscount } = require('../utils/performancePricing');
const UserSubscription = require('../models/UserSubscription');

// GET /api/provider-performance/current - Obecny performance discount
router.get('/current', auth, async (req, res) => {
  try {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko dla providerów' });
    }
    
    const performance = await getCurrentPerformanceDiscount(req.user._id);
    
    // Sprawdź czy ma aktywną subskrypcję
    const subscription = await UserSubscription.findOne({ 
      user: req.user._id,
      validUntil: { $gt: new Date() }
    });
    
    res.json({
      ...performance,
      hasActiveSubscription: !!subscription,
      currentDiscount: subscription?.performanceDiscount || 0,
      currentTier: subscription?.performanceDiscountTier || 'none',
      nextPeriodDiscount: performance.discountPercent // Zniżka która będzie zastosowana przy następnym odnawianiu
    });
  } catch (error) {
    console.error('Error getting provider performance:', error);
    res.status(500).json({ message: 'Błąd pobierania performance discount' });
  }
});

// GET /api/provider-performance/history - Historia performance (ostatnie 6 miesięcy)
router.get('/history', auth, async (req, res) => {
  try {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko dla providerów' });
    }
    
    const history = [];
    const now = new Date();
    
    // Oblicz performance dla ostatnich 6 miesięcy
    for (let i = 0; i < 6; i++) {
      const referenceDate = new Date(now);
      referenceDate.setMonth(referenceDate.getMonth() - i);
      
      const performance = await calculatePerformanceDiscount(req.user._id, referenceDate);
      
      history.push({
        month: referenceDate.toISOString().substring(0, 7), // YYYY-MM
        ...performance
      });
    }
    
    res.json({ history });
  } catch (error) {
    console.error('Error getting provider performance history:', error);
    res.status(500).json({ message: 'Błąd pobierania historii performance' });
  }
});

module.exports = router;







