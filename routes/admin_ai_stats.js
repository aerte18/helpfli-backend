/**
 * Admin: statystyki kosztów i użycia hybrydowego AI (Gemini vs Claude)
 * GET /api/admin/ai-stats?days=30
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const AIAnalyticsService = require('../services/AIAnalyticsService');

router.get('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const stats = await AIAnalyticsService.getAiRoutingStats(days);

    res.json({
      ok: true,
      ...stats
    });
  } catch (error) {
    console.error('admin ai-stats error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania statystyk AI'
    });
  }
});

module.exports = router;
