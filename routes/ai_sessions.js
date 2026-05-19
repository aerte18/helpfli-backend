/**
 * Historia sesji AI Concierge
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const ConversationMemory = require('../models/ConversationMemory');
const ConversationMemoryService = require('../services/ConversationMemoryService');

/**
 * GET /api/ai/concierge/sessions
 * Lista ostatnich rozmów użytkownika
 */
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 30);
    const sessions = await ConversationMemoryService.getUserHistory(userId, limit, 'concierge');

    const enriched = await Promise.all(
      sessions.map(async (s) => {
        const memory = await ConversationMemory.findOne({
          userId,
          sessionId: s.sessionId,
          agentType: 'concierge'
        })
          .select('messages lastInteraction updatedAt')
          .lean();

        const visible = (memory?.messages || []).filter((m) => !m.isSummarized && m.role !== 'system');
        const firstUser = visible.find((m) => m.role === 'user');
        const preview = firstUser?.content?.slice(0, 80) || 'Rozmowa z asystentem';

        return {
          sessionId: s.sessionId,
          updatedAt: s.updatedAt,
          preview,
          messageCount: visible.length,
          lastInteraction: memory?.lastInteraction || s.lastInteraction || null
        };
      })
    );

    res.json({ ok: true, sessions: enriched });
  } catch (error) {
    console.error('GET sessions error:', error);
    res.status(500).json({ ok: false, message: 'Nie udało się pobrać historii rozmów' });
  }
});

/**
 * GET /api/ai/concierge/sessions/:sessionId
 * Wiadomości z wybranej sesji
 */
router.get('/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { sessionId } = req.params;

    const memory = await ConversationMemory.findOne({
      userId,
      sessionId,
      agentType: 'concierge'
    }).lean();

    if (!memory) {
      return res.status(404).json({ ok: false, message: 'Nie znaleziono rozmowy' });
    }

    const messages = (memory.messages || [])
      .filter((m) => !m.isSummarized && m.role !== 'system')
      .map((m) => ({
        role: m.role,
        text: m.content,
        ts: m.timestamp,
        agent: m.agent,
        metadata: m.metadata || {}
      }));

    res.json({
      ok: true,
      sessionId,
      messages,
      lastInteraction: memory.lastInteraction || null,
      preferences: memory.preferences || {}
    });
  } catch (error) {
    console.error('GET session error:', error);
    res.status(500).json({ ok: false, message: 'Nie udało się wczytać rozmowy' });
  }
});

module.exports = router;
