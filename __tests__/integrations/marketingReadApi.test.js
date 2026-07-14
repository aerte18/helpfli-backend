/**
 * Testy integracji Marketing Read API (AI Command Center).
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../models/Order', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../models/User', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
      lean: jest.fn().mockResolvedValue([]),
    }),
  }),
}));

jest.mock('../../models/Service', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  }),
}));

const marketingRoutes = require('../../routes/integrationsMarketing');
const MarketingReadService = require('../../services/MarketingReadService');
const { getPlatformFacts } = require('../../services/MarketingPlatformFactsService');
const { extractProvidedToken, safeEqualToken } = require('../../middleware/aiCommandCenterAuth');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/marketing/v1', marketingRoutes);
  return app;
}

describe('Marketing Read API — AI Command Center', () => {
  const VALID_TOKEN = 'test-acc-read-token-min-32-chars-long';
  let app;
  let logSpy;

  beforeAll(() => {
    process.env.AI_COMMAND_CENTER_READ_TOKEN = VALID_TOKEN;
    process.env.ENABLE_RATE_LIMIT = '0';
    app = createApp();
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.clearAllMocks();
  });

  afterEach(() => {
    logSpy?.mockRestore();
  });

  describe('Auth', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/integrations/marketing/v1/catalog');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 403 with wrong token', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/catalog')
        .set('Authorization', 'Bearer wrong-token-value');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    });

    it('allows valid Bearer token', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/catalog')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe('helpfli-marketing-data-v1');
    });

    it('allows X-Internal-Token header', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/health')
        .set('X-Internal-Token', VALID_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('does not log provided token', async () => {
      await request(app)
        .get('/api/integrations/marketing/v1/health')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);

      const logCalls = [
        ...(logSpy.mock?.calls || []),
      ];
      const serialized = JSON.stringify(logCalls);
      expect(serialized).not.toContain(VALID_TOKEN);
    });
  });

  describe('Catalog', () => {
    it('returns active categories with schema version', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/catalog')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe('helpfli-marketing-data-v1');
      expect(res.body.generatedAt).toBeDefined();
      expect(res.body.sourceVersion).toBeDefined();
      expect(res.body.dataFreshness?.expiresAt).toBeDefined();
      expect(Array.isArray(res.body.data.categories)).toBe(true);
      expect(res.body.data.categories.length).toBeGreaterThan(0);
      expect(res.body.data.categories[0]).toMatchObject({
        categoryId: expect.any(String),
        categoryName: expect.any(String),
        active: true,
      });
    });

    it('response contains no PII fields', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/catalog')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);
      const forbidden = ['email', 'phone', 'password', 'userId', 'providerId', 'orderId', 'address', 'coordinates'];
      const body = JSON.stringify(res.body);
      for (const key of forbidden) {
        expect(body.toLowerCase()).not.toContain(key.toLowerCase());
      }
    });
  });

  describe('Demand summary', () => {
    it('accepts date range and returns aggregates envelope', async () => {
      const res = await request(app)
        .post('/api/integrations/marketing/v1/demand-summary')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({
          categoryIds: ['hydraulika'],
          locations: ['warszawa'],
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: '2026-02-01T00:00:00.000Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.aggregates).toEqual([]);
      expect(res.body.data.privacyMinCount).toBeGreaterThan(0);
    });

    it('rejects invalid date range', async () => {
      const res = await request(app)
        .post('/api/integrations/marketing/v1/demand-summary')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({
          dateFrom: '2026-06-01T00:00:00.000Z',
          dateTo: '2026-01-01T00:00:00.000Z',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_date_range');
    });

    it('rejects unsupported location', async () => {
      const res = await request(app)
        .post('/api/integrations/marketing/v1/demand-summary')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ locations: ['nieznane-miasto-xyz'] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('unsupported_location');
    });
  });

  describe('Supply summary', () => {
    it('returns supply aggregates without contractor identifiers', async () => {
      const res = await request(app)
        .post('/api/integrations/marketing/v1/supply-summary')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ categoryIds: ['hydraulika'], locations: ['warszawa'] });

      expect(res.status).toBe(200);
      const forbidden = ['providerId', 'userId', 'email', 'phone', '"name":', 'address'];
      const body = JSON.stringify(res.body);
      for (const key of forbidden) {
        expect(body).not.toContain(key);
      }
    });
  });

  describe('Platform facts', () => {
    it('returns facts with source and verified flags', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/platform-facts')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.data.facts.length).toBeGreaterThan(0);
      for (const f of res.body.data.facts) {
        expect(f.code).toBeDefined();
        expect(f.source).toBeDefined();
        expect(typeof f.verified).toBe('boolean');
      }
      const unverified = res.body.data.facts.filter((f) => !f.verified);
      expect(unverified.length).toBeGreaterThan(0);
    });
  });

  describe('Claims registry', () => {
    it('returns verified, unverified and forbidden claims', async () => {
      const res = await request(app)
        .get('/api/integrations/marketing/v1/claims')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      const statuses = res.body.data.claims.map((c) => c.status);
      expect(statuses).toContain('verified');
      expect(statuses).toContain('unverified');
      expect(statuses).toContain('forbidden');
    });

    it('has no duplicate claim codes', () => {
      const registry = MarketingReadService.getClaimsRegistry();
      const codes = registry.claims.map((c) => c.code);
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  describe('Security / contract', () => {
    it('POST demand-summary does not mutate data (read-only)', async () => {
      const Order = require('../../models/Order');
      await request(app)
        .post('/api/integrations/marketing/v1/demand-summary')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .send({ locations: ['warszawa'] });
      expect(Order.aggregate).toHaveBeenCalled();
      // brak metod zapisu na mocku
      expect(Order.countDocuments).not.toHaveBeenCalled();
    });

    it('suppresses small groups below privacy threshold', () => {
      const s = MarketingReadService.suppressCount(3);
      expect(s.suppressed).toBe(true);
      expect(s.value).toBeNull();
    });

    it('platform facts service is deterministic for code list', () => {
      const a = getPlatformFacts().map((f) => f.code).sort();
      const b = getPlatformFacts().map((f) => f.code).sort();
      expect(a).toEqual(b);
    });
  });

  describe('Token comparison', () => {
    it('uses timing-safe comparison', () => {
      expect(safeEqualToken('abc', 'abc')).toBe(true);
      expect(safeEqualToken('abc', 'abd')).toBe(false);
      expect(extractProvidedToken({ headers: { authorization: 'Bearer secret' } })).toBe('secret');
    });
  });
});
