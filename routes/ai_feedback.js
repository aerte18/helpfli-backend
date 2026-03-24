/**
 * Routes dla AI Feedback
 * Zbieranie i analiza feedbacku od użytkowników
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const FeedbackService = require('../services/FeedbackService');

/**
 * POST /api/ai/feedback
 * Zbierz feedback dla odpowiedzi AI
 */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const {
      sessionId,
      messageId,
      agent,
      quickFeedback, // 'positive' | 'negative'
      rating, // 1-5
      comment,
      wasHelpful,
      actionTaken, // 'created_order', 'contacted_provider', etc.
      metadata = {}
    } = req.body;

    if (!sessionId || !messageId) {
      return res.status(400).json({
        ok: false,
        message: 'sessionId i messageId są wymagane'
      });
    }

    const feedback = await FeedbackService.collectFeedback({
      userId: req.user._id || req.user.id,
      sessionId,
      messageId,
      agent: agent || 'concierge',
      quickFeedback,
      rating,
      comment,
      wasHelpful,
      actionTaken,
      metadata
    });

    res.json({
      ok: true,
      message: 'Feedback zapisany',
      feedback: {
        id: feedback._id,
        sessionId: feedback.sessionId,
        messageId: feedback.messageId,
        agent: feedback.agent
      }
    });
  } catch (error) {
    console.error('Feedback collection error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas zapisywania feedbacku'
    });
  }
});

/**
 * GET /api/ai/feedback/stats
 * Pobierz statystyki feedbacku (admin only)
 */
router.get('/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const timeRange = parseInt(req.query.days) || 30;
    const agent = req.query.agent || null;

    let stats;
    if (agent) {
      stats = {
        [agent]: await FeedbackService.getAgentStats(agent, timeRange)
      };
    } else {
      stats = await FeedbackService.getAllAgentsStats(timeRange);
    }

    res.json({
      ok: true,
      stats,
      timeRange
    });
  } catch (error) {
    console.error('Feedback stats error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania statystyk'
    });
  }
});

/**
 * GET /api/ai/feedback/problematic
 * Pobierz problematyczne odpowiedzi (admin only)
 */
router.get('/problematic', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const agent = req.query.agent || null;
    const limit = parseInt(req.query.limit) || 20;

    const problematic = await FeedbackService.getProblematicResponses(agent, limit);

    res.json({
      ok: true,
      problematic,
      count: problematic.length
    });
  } catch (error) {
    console.error('Problematic responses error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania problematycznych odpowiedzi'
    });
  }
});

/**
 * GET /api/ai/feedback/my
 * Pobierz własny feedback (użytkownik)
 */
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const feedback = await FeedbackService.getUserFeedback(req.user._id || req.user.id, limit);

    res.json({
      ok: true,
      feedback,
      count: feedback.length
    });
  } catch (error) {
    console.error('My feedback error:', error);
    res.status(500).json({
      ok: false,
      message: 'Błąd podczas pobierania feedbacku'
    });
  }
});

module.exports = router;

