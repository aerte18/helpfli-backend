?/**
 * Testy integracyjne dla Fazy 1
 * Testują współpracę wszystkich komponentów
 */

const ConversationMemoryService = require('../../services/ConversationMemoryService');
const FeedbackService = require('../../services/FeedbackService');
const AIAnalyticsService = require('../../services/AIAnalyticsService');
const ConversationMemory = require('../../models/ConversationMemory');
const AIFeedback = require('../../models/AIFeedback');
const AIAnalytics = require('../../models/AIAnalytics');
const mongoose = require('mongoose');

describe('Phase 1: Integration Tests', () => {
  let userId;
  let sessionId;
  let messageId;
  let requestId;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    
    userId = new mongoose.Types.ObjectId();
    sessionId = `integration_test_${Date.now()}`;
    messageId = `msg_${Date.now()}`;
    requestId = AIAnalyticsService.generateRequestId();
  });

  afterAll(async () => {
    await ConversationMemory.deleteMany({ userId });
    await AIFeedback.deleteMany({ user: userId });
    await AIAnalytics.deleteMany({ userId });
    await mongoose.connection.close();
  });

  test('should track full conversation flow', async () => {
    // 1. Utwórz sesję
    const memory = await ConversationMemoryService.getOrCreateSession(
      userId,
      sessionId,
      'concierge'
    );
    expect(memory).toBeDefined();

    // 2. Dodaj wiadomości
    await ConversationMemoryService.addMessage(
      userId,
      sessionId,
      'user',
      'Mam problem z hydrauliką w Warszawie',
      'concierge',
      {},
      'concierge'
    );

    await ConversationMemoryService.addMessage(
      userId,
      sessionId,
      'assistant',
      'Rozumiem, pomogę Ci znaleźć hydraulika w Warszawie',
      'concierge',
      { detectedService: 'hydraulik' },
      'concierge'
    );

    // 3. Track analytics
    await AIAnalyticsService.trackRequest({
      requestId,
      userId,
      sessionId,
      agent: 'concierge',
      endpoint: '/api/ai/concierge/v2',
      messageCount: 2,
      responseTime: 1500,
      success: true,
      llmProvider: 'claude'
    });

    // 4. Collect feedback
    await FeedbackService.collectFeedback({
      userId,
      sessionId,
      messageId,
      agent: 'concierge',
      quickFeedback: 'positive',
      rating: 5,
      wasHelpful: true
    });

    // 5. Verify everything was saved
    const context = await ConversationMemoryService.getContext(userId, sessionId, 10, 'concierge');
    expect(context.recentMessages.length).toBeGreaterThanOrEqual(2);

    const stats = await AIAnalyticsService.getAgentStats('concierge', 30);
    expect(stats.total).toBeGreaterThanOrEqual(1);

    const feedbackStats = await FeedbackService.getAgentStats('concierge', 30);
    expect(feedbackStats.total).toBeGreaterThanOrEqual(1);
  });

  test('should handle memory preferences extraction', async () => {
    // Dodaj więcej wiadomości
    await ConversationMemoryService.addMessage(
      userId,
      sessionId,
      'user',
      'Szukam elektryka w Krakowie',
      'concierge',
      {},
      'concierge'
    );

    // Aktualizuj preferencje
    await ConversationMemoryService.updatePreferences(
      userId,
      sessionId,
      {
        preferredServices: ['elektryk'],
        preferredLocations: ['Kraków']
      },
      'concierge'
    );

    // Pobierz preferencje
    const preferences = await ConversationMemoryService.getUserPreferences(userId, 'concierge');
    expect(preferences.preferredServices).toContain('elektryk');
    expect(preferences.preferredLocations.length).toBeGreaterThan(0);
  });

  test('should track error scenario', async () => {
    const errorRequestId = AIAnalyticsService.generateRequestId();

    await AIAnalyticsService.trackRequest({
      requestId: errorRequestId,
      userId,
      sessionId,
      agent: 'concierge',
      endpoint: '/api/ai/concierge/v2',
      responseTime: 5000,
      success: false,
      error: 'Timeout error',
      errorType: 'timeout'
    });

    const errors = await AIAnalyticsService.getErrors(30, 10);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    
    const error = errors.find(e => e.requestId === errorRequestId);
    expect(error).toBeDefined();
    expect(error.errorType).toBe('timeout');
  });
});

