?/**
 * Testy dla Feedback Loop (Faza 1)
 */

const FeedbackService = require('../../services/FeedbackService');
const AIFeedback = require('../../models/AIFeedback');
const mongoose = require('mongoose');

describe('Phase 1: Feedback Loop', () => {
  let userId;
  let sessionId;
  let messageId;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    
    userId = new mongoose.Types.ObjectId();
    sessionId = `test_session_${Date.now()}`;
    messageId = `test_msg_${Date.now()}`;
  });

  afterAll(async () => {
    await AIFeedback.deleteMany({ user: userId });
    await mongoose.connection.close();
  });

  describe('FeedbackService', () => {
    test('should collect feedback', async () => {
      const feedback = await FeedbackService.collectFeedback({
        userId,
        sessionId,
        messageId,
        agent: 'concierge',
        quickFeedback: 'positive',
        rating: 5,
        wasHelpful: true,
        actionTaken: 'created_order'
      });

      expect(feedback).toBeDefined();
      expect(feedback.sessionId).toBe(sessionId);
      expect(feedback.messageId).toBe(messageId);
      expect(feedback.quickFeedback).toBe('positive');
      expect(feedback.feedback.rating).toBe(5);
    });

    test('should get agent stats', async () => {
      // Poczekaj chwilę żeby feedback został zapisany
      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = await FeedbackService.getAgentStats('concierge', 30);

      expect(stats).toBeDefined();
      expect(stats.total).toBeGreaterThanOrEqual(1);
      expect(stats.positive).toBeGreaterThanOrEqual(1);
      expect(stats.satisfactionRate).toBeGreaterThanOrEqual(0);
      expect(stats.averageRating).toBeGreaterThanOrEqual(0);
    });

    test('should collect negative feedback', async () => {
      const feedback = await FeedbackService.collectFeedback({
        userId,
        sessionId: `test_session_${Date.now()}`,
        messageId: `test_msg_${Date.now()}`,
        agent: 'concierge',
        quickFeedback: 'negative',
        rating: 2,
        wasHelpful: false,
        comment: 'Odpowiedź nie była pomocna'
      });

      expect(feedback.quickFeedback).toBe('negative');
      expect(feedback.feedback.rating).toBe(2);
      expect(feedback.wasHelpful).toBe(false);
    });

    test('should get all agents stats', async () => {
      const stats = await FeedbackService.getAllAgentsStats(30);

      expect(stats).toBeDefined();
      expect(stats.concierge).toBeDefined();
      expect(stats.overall).toBeDefined();
      expect(stats.overall.total).toBeGreaterThanOrEqual(0);
    });

    test('should get problematic responses', async () => {
      const problematic = await FeedbackService.getProblematicResponses('concierge', 10);

      expect(Array.isArray(problematic)).toBe(true);
    });
  });
});

