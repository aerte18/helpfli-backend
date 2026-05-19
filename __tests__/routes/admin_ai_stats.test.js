const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/authMiddleware', () => ({
  authMiddleware: (_req, _res, next) => next()
}));

jest.mock('../../middleware/roles', () => ({
  requireRole: () => (_req, _res, next) => next()
}));

jest.mock('../../services/AIAnalyticsService', () => ({
  getAiRoutingStats: jest.fn()
}));

const AIAnalyticsService = require('../../services/AIAnalyticsService');
const adminAiStatsRoutes = require('../../routes/admin_ai_stats');

describe('GET /api/admin/ai-stats', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/admin/ai-stats', adminAiStatsRoutes);
    jest.clearAllMocks();
  });

  it('returns hybrid routing stats for admin', async () => {
    AIAnalyticsService.getAiRoutingStats.mockResolvedValue({
      timeRangeDays: 30,
      currency: 'PLN',
      summary: {
        totalRequests: 100,
        totalCostPln: 12.5,
        escalationsToClaude: 8,
        hybridGeminiSharePct: 72
      },
      providers: {
        gemini: { requests: 72, costPln: 2.1, sharePct: 72 },
        claude: { requests: 28, costPln: 10.4, sharePct: 28 }
      },
      tiers: { cheap: { requests: 72 }, smart: { requests: 36 } },
      daily: [],
      config: { routerMode: 'hybrid' }
    });

    const res = await request(app).get('/api/admin/ai-stats?days=30').expect(200);

    expect(res.body.ok).toBe(true);
    expect(AIAnalyticsService.getAiRoutingStats).toHaveBeenCalledWith(30);
    expect(res.body.providers.gemini.requests).toBe(72);
    expect(res.body.summary.hybridGeminiSharePct).toBe(72);
  });

  it('clamps days between 1 and 90', async () => {
    AIAnalyticsService.getAiRoutingStats.mockResolvedValue({ timeRangeDays: 90, summary: {}, providers: {} });

    await request(app).get('/api/admin/ai-stats?days=999').expect(200);
    expect(AIAnalyticsService.getAiRoutingStats).toHaveBeenCalledWith(90);
  });
});
