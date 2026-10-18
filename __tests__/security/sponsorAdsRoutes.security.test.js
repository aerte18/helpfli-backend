const express = require('express');
const request = require('supertest');

const mockFind = jest.fn();
const mockFindById = jest.fn();
const mockCreate = jest.fn();

jest.mock('../../models/SponsorAd', () => ({
  find: (...args) => mockFind(...args),
  findById: (...args) => mockFindById(...args),
  findOne: jest.fn(),
  create: (...args) => mockCreate(...args),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../../middleware/authMiddleware', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = {
      _id: '507f1f77bcf86cd799439011',
      email: 'owner@example.com',
      role: 'provider',
    };
    next();
  },
}));

jest.mock('../../middleware/sponsorMetrics', () => ({
  metricsLimiter: (_req, _res, next) => next(),
  sponsorMetricsGuard: (_req, _res, next) => next(),
}));

jest.mock('../../utils/sponsorAds', () => ({
  recordClick: jest.fn(),
}));

const router = require('../../routes/sponsorAds');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('sponsor ads security boundaries', () => {
  beforeEach(() => jest.clearAllMocks());

  test('anonymous status filter cannot reveal pending ads and response is projected', async () => {
    const query = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{
        _id: 'ad-1',
        title: 'Publiczna reklama',
        status: 'active',
        advertiser: { companyName: 'Firma', email: 'secret@example.com', nip: '123' },
        payment: { paymentIntentId: 'pi_secret' },
        priority: 99,
      }]),
    };
    mockFind.mockReturnValue(query);

    const response = await request(makeApp()).get('/?status=pending');

    expect(response.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ status: 'active' });
    expect(query.select).toHaveBeenCalled();
    expect(response.body.ads[0].advertiser).toEqual({ companyName: 'Firma' });
    expect(response.body.ads[0]).not.toHaveProperty('payment');
    expect(response.body.ads[0]).not.toHaveProperty('priority');
  });

  test('owner update ignores status, payment, priority and moderation fields', async () => {
    const ad = {
      _id: 'ad-1',
      owner: '507f1f77bcf86cd799439011',
      advertiser: { email: 'owner@example.com' },
      title: 'Przed zmianą',
      status: 'pending',
      priority: 0,
      payment: { status: 'pending' },
      freeTrial: { isFreeTrial: false },
      moderation: null,
      campaign: { budget: 10000, spent: 0 },
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindById.mockResolvedValue(ad);

    const response = await request(makeApp())
      .put('/ad-1')
      .set('Authorization', 'Bearer test')
      .send({
        title: 'Po zmianie',
        status: 'active',
        priority: 100,
        payment: { status: 'succeeded' },
        freeTrial: { isFreeTrial: true },
        moderation: { reviewedBy: 'attacker' },
        campaign: { startDate: '2026-10-20', spent: 999999 },
      });

    expect(response.status).toBe(200);
    expect(ad.title).toBe('Po zmianie');
    expect(ad.status).toBe('pending');
    expect(ad.priority).toBe(0);
    expect(ad.payment).toEqual({ status: 'pending' });
    expect(ad.freeTrial).toEqual({ isFreeTrial: false });
    expect(ad.moderation).toBeNull();
    expect(ad.campaign.spent).toBe(0);
    expect(ad.campaign.startDate).toBe('2026-10-20');
    expect(ad.save).toHaveBeenCalledTimes(1);
  });

  test('free trial still requires moderation before it is public', async () => {
    mockFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    const findOne = require('../../models/SponsorAd').findOne;
    findOne.mockResolvedValue(null);
    mockCreate.mockImplementation(async (value) => ({ _id: 'ad-2', ...value }));

    const response = await request(makeApp()).post('/').send({
      advertiser: { companyName: 'Firma' },
      adType: 'other',
      title: 'Próba',
      description: 'Reklama w darmowym okresie próbnym',
      link: 'https://example.com',
      isFreeTrial: true,
      campaign: {
        budget: 0,
        pricingModel: 'package',
        startDate: '2026-10-20',
        endDate: '2026-10-27',
      },
    });

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      owner: '507f1f77bcf86cd799439011',
      status: 'pending',
    }));
    expect(response.body.message).toMatch(/oczekuje na akceptację/i);
  });
});
