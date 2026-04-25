const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/authMiddleware', () => ({
  authMiddleware: (_req, _res, next) => next()
}));

jest.mock('../../middleware/roles', () => ({
  requireRole: () => (_req, _res, next) => next()
}));

jest.mock('../../jobs/companyProAutoFollowupCron', () => ({
  getCompanyProAutoFollowupCronHealth: jest.fn()
}));

// Route imports these modules at top-level, so provide lightweight mocks.
jest.mock('../../models/Order', () => ({}));
jest.mock('../../models/User', () => ({}));
jest.mock('../../models/Payment', () => ({}));
jest.mock('../../models/UserSubscription', () => ({}));
jest.mock('../../models/Coupon', () => ({}));
jest.mock('../../models/Event', () => ({}));
jest.mock('../../models/Offer', () => ({}));
jest.mock('../../services/TelemetryService', () => ({}));
jest.mock('../../models/AIAnalytics', () => ({}));

const { getCompanyProAutoFollowupCronHealth } = require('../../jobs/companyProAutoFollowupCron');
const analyticsRoutes = require('../../routes/admin_analytics');

describe('Admin analytics company-pro cron health', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use('/api/admin/analytics', analyticsRoutes);
    jest.clearAllMocks();
  });

  it('returns health payload and stale flag false', async () => {
    getCompanyProAutoFollowupCronHealth.mockReturnValue({
      scheduledSpec: '*/30 * * * *',
      lastRunStartedAt: '2026-04-25T18:00:00.000Z',
      lastRunFinishedAt: new Date().toISOString(),
      lastStatus: 'ok',
      lastError: null,
      lastStats: { ordersTriggered: 3 },
      isRunning: false
    });

    const res = await request(app)
      .get('/api/admin/analytics/company-pro-cron-health')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('stale', false);
    expect(res.body).toHaveProperty('health.lastStatus', 'ok');
    expect(res.body).toHaveProperty('health.scheduledSpec', '*/30 * * * *');
  });

  it('marks stale true when last run is too old', async () => {
    process.env.COMPANY_PRO_AUTOFOLLOWUP_HEALTH_STALE_MINUTES = '10';
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago

    getCompanyProAutoFollowupCronHealth.mockReturnValue({
      scheduledSpec: '*/30 * * * *',
      lastRunStartedAt: oldDate,
      lastRunFinishedAt: oldDate,
      lastStatus: 'ok',
      lastError: null,
      lastStats: { ordersTriggered: 0 },
      isRunning: false
    });

    const res = await request(app)
      .get('/api/admin/analytics/company-pro-cron-health')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('stale', true);
    expect(res.body).toHaveProperty('staleAfterMinutes', 10);

    delete process.env.COMPANY_PRO_AUTOFOLLOWUP_HEALTH_STALE_MINUTES;
  });
});
