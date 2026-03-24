?/**
 * Testy dla Analytics & Monitoring (Faza 1)
 */

const AIAnalyticsService = require('../../services/AIAnalyticsService');
const AIAnalytics = require('../../models/AIAnalytics');
const mongoose = require('mongoose');

describe('Phase 1: Analytics & Monitoring', () => {
  let userId;
  let requestId;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    
    userId = new mongoose.Types.ObjectId();
  });

  afterAll(async () => {
    await AIAnalytics.deleteMany({ userId });
    await mongoose.connection.close();
  });

  describe('AIAnalyticsService', () => {
    test('should generate requestId', () => {
      const requestId = AIAnalyticsService.generateRequestId();
      
      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe('string');
      expect(requestId.startsWith('req_')).toBe(true);
    });

    test('should track successful request', async () => {
      const requestId = AIAnalyticsService.generateRequestId();
      
      const analytics = await AIAnalyticsService.trackRequest({
        requestId,
        userId,
        sessionId: 'test_session',
        agent: 'concierge',
        endpoint: '/api/ai/concierge/v2',
        messageCount: 3,
        responseTime: 1250,
        success: true,
        llmProvider: 'claude',
        llmModel: 'claude-3-5-haiku-20241022',
        tokensInput: 500,
        tokensOutput: 200,
        quality: {
          confidence: 0.85
        }
      });

      expect(analytics).toBeDefined();
      expect(analytics.requestId).toBe(requestId);
      expect(analytics.success).toBe(true);
      expect(analytics.responseTime).toBe(1250);
    });

    test('should track failed request', async () => {
      const requestId = AIAnalyticsService.generateRequestId();
      
      const analytics = await AIAnalyticsService.trackRequest({
        requestId,
        userId,
        sessionId: 'test_session',
        agent: 'concierge',
        endpoint: '/api/ai/concierge/v2',
        responseTime: 5000,
        success: false,
        error: 'Timeout',
        errorType: 'timeout'
      });

      expect(analytics.success).toBe(false);
      expect(analytics.error).toBe('Timeout');
      expect(analytics.errorType).toBe('timeout');
    });

    test('should get agent stats', async () => {
      // Poczekaj chwilę żeby analytics został zapisany
      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = await AIAnalyticsService.getAgentStats('concierge', 30);

      expect(stats).toBeDefined();
      expect(stats.total).toBeGreaterThanOrEqual(1);
      expect(stats.successful).toBeGreaterThanOrEqual(0);
      expect(stats.failed).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeGreaterThanOrEqual(0);
      expect(stats.successRate).toBeLessThanOrEqual(100);
      expect(stats.avgResponseTime).toBeGreaterThanOrEqual(0);
    });

    test('should get all agents stats', async () => {
      const stats = await AIAnalyticsService.getAllAgentsStats(30);

      expect(stats).toBeDefined();
      expect(stats.concierge).toBeDefined();
      expect(stats.overall).toBeDefined();
      expect(stats.overall.total).toBeGreaterThanOrEqual(0);
    });

    test('should get errors', async () => {
      const errors = await AIAnalyticsService.getErrors(30, 10);

      expect(Array.isArray(errors)).toBe(true);
    });

    test('should estimate cost', () => {
      const cost = AIAnalyticsService.estimateCost(
        'claude',
        'claude-3-5-haiku-20241022',
        1000, // input tokens
        500   // output tokens
      );

      expect(typeof cost).toBe('number');
      expect(cost).toBeGreaterThanOrEqual(0); // Może być 0 dla niektórych providerów
      
      // Dla Claude powinno być > 0
      if (process.env.ANTHROPIC_API_KEY) {
        expect(cost).toBeGreaterThan(0);
      }
    });

    test('should get cost stats', async () => {
      const costStats = await AIAnalyticsService.getCostStats(30);

      expect(Array.isArray(costStats)).toBe(true);
    });
  });
});

