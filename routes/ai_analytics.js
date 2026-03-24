/**
 * Routes dla AI Analytics
 * Dashboard i statystyki użycia AI agentów
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const AIAnalyticsService = require('../services/AIAnalyticsService');

/**
 * GET /api/ai/analytics/stats
 * Pobierz statystyki użycia agentów (admin only)
 */
router.get('/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const timeRange = parseInt(req.query.days) || 7;
    const agent = req.query.agent || null;

    let stats;
    if (agent) {
      stats = {
        [agent]: await AIAnalyticsService.getAgentStats(agent, timeRange)
      };
    } else {
      stats = await AIAnalyticsService.getAllAgentsStats(timeRange);
    }

    res.json({
      ok: true,
      stats,
      timeRange,
      currency: 'PLN'
    });
  } catch (error) {
    console.error('Analytics stats error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania statystyk'
    });
  }
});

/**
 * GET /api/ai/analytics/errors
 * Pobierz błędy (admin only)
 */
router.get('/errors', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const timeRange = parseInt(req.query.days) || 7;
    const limit = parseInt(req.query.limit) || 50;

    const errors = await AIAnalyticsService.getErrors(timeRange, limit);

    res.json({
      ok: true,
      errors,
      count: errors.length
    });
  } catch (error) {
    console.error('Analytics errors error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania błędów'
    });
  }
});

/**
 * GET /api/ai/analytics/costs
 * Pobierz statystyki kosztów (admin only)
 */
router.get('/costs', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const timeRange = parseInt(req.query.days) || 30;

    const costStats = await AIAnalyticsService.getCostStats(timeRange);

    // Agreguj per agent
    const agentCosts = {};
    let totalCost = 0;

    costStats.forEach(stat => {
      const agent = stat._id.agent;
      if (!agentCosts[agent]) {
        agentCosts[agent] = {
          cost: 0,
          requests: 0,
          tokens: 0
        };
      }
      agentCosts[agent].cost += stat.cost;
      agentCosts[agent].requests += stat.requests;
      agentCosts[agent].tokens += stat.tokens;
      totalCost += stat.cost;
    });

    res.json({
      ok: true,
      costStats,
      agentCosts,
      totalCost: totalCost / 100, // Konwersja z groszy na PLN
      currency: 'PLN',
      timeRange
    });
  } catch (error) {
    console.error('Analytics costs error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania statystyk kosztów'
    });
  }
});

module.exports = router;

