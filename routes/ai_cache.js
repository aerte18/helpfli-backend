/**
 * Routes dla AI Cache Management (admin only)
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const CacheService = require('../services/CacheService');

/**
 * GET /api/ai/cache/stats
 * Pobierz statystyki cache (admin only)
 */
router.get('/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const stats = await CacheService.getStats();
    res.json({
      ok: true,
      stats
    });
  } catch (error) {
    console.error('Cache stats error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania statystyk cache'
    });
  }
});

/**
 * DELETE /api/ai/cache/clear
 * Wyczyść cache (admin only)
 */
router.delete('/clear', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const pattern = req.query.pattern || null; // np. 'ai_cache:price_hints:*'
    await CacheService.clear(pattern);
    res.json({
      ok: true,
      message: pattern ? `Cache cleared for pattern: ${pattern}` : 'Cache cleared'
    });
  } catch (error) {
    console.error('Cache clear error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas czyszczenia cache'
    });
  }
});

module.exports = router;

