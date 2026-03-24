/**
 * Testy dla promo codes routes
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const PromoCode = require('../../models/PromoCode');
const Order = require('../../models/Order');

// Mock models
jest.mock('../../models/PromoCode');
jest.mock('../../models/Order');

// Mock auth middleware
jest.mock('../../middleware/authMiddleware', () => ({
  authMiddleware: (req, res, next) => {
    req.user = {
      _id: '507f1f77bcf86cd799439011',
      email: 'test@example.com',
      role: 'client'
    };
    next();
  }
}));

const promoCodeRoutes = require('../../routes/promo_codes');

describe('Promo Codes Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // authMiddleware is already mocked, so routes will use the mock automatically
    app.use('/api/promo', promoCodeRoutes);
    process.env.JWT_SECRET = 'test-secret-key-for-jwt-tokens-min-32-chars';
    jest.clearAllMocks();
  });

  describe('POST /api/promo/validate', () => {
    it('should return 404 when promo code does not exist', async () => {
      PromoCode.findOne = jest.fn().mockResolvedValue(null);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'INVALID',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(404);

      expect(response.body.message).toBe('Kod nie istnieje lub jest nieaktywny');
    });

    it('should return 400 when promo code is expired', async () => {
      const expiredPromo = {
        code: 'EXPIRED',
        active: true,
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2020-12-31'),
        discountPercent: 10
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(expiredPromo);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'EXPIRED',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(400);

      expect(response.body.message).toBe('Kod nie jest aktualnie ważny');
    });

    it('should return 400 when max redemptions reached', async () => {
      const promo = {
        code: 'LIMITED',
        active: true,
        maxRedemptions: 10,
        redemptions: 10,
        discountPercent: 10
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(promo);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'LIMITED',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(400);

      expect(response.body.message).toBe('Limit użyć kodu został wyczerpany');
    });

    it('should return 400 when order value is too low', async () => {
      const promo = {
        code: 'MIN100',
        active: true,
        minOrderValue: 500,
        discountPercent: 10
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(promo);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'MIN100',
          serviceKey: 'hydraulik',
          baseAmount: 100
        })
        .expect(400);

      expect(response.body.message).toBe('Minimalna wartość zamówienia: 500');
    });

    it('should return 400 when service is not allowed', async () => {
      const promo = {
        code: 'SPECIFIC',
        active: true,
        allowedServices: ['elektryk'],
        discountPercent: 10
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(promo);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'SPECIFIC',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(400);

      expect(response.body.message).toBe('Kod nie dotyczy wybranej usługi');
    });

    it('should return 400 when first order only and user has orders', async () => {
      const promo = {
        code: 'FIRST',
        active: true,
        firstOrderOnly: true,
        discountPercent: 10
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(promo);
      Order.countDocuments = jest.fn().mockResolvedValue(1);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'FIRST',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(400);

      expect(response.body.message).toBe('Kod tylko na pierwsze zlecenie');
    });

    it('should return 200 with promo details when valid', async () => {
      const promo = {
        code: 'VALID10',
        active: true,
        discountPercent: 10,
        discountFlat: null
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(promo);
      Order.countDocuments = jest.fn().mockResolvedValue(0);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'VALID10',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.promo.code).toBe('VALID10');
      expect(response.body.promo.discountPercent).toBe(10);
    });

    it('should handle flat discount', async () => {
      const promo = {
        code: 'FLAT50',
        active: true,
        discountPercent: null,
        discountFlat: 50
      };
      PromoCode.findOne = jest.fn().mockResolvedValue(promo);
      Order.countDocuments = jest.fn().mockResolvedValue(0);

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'FLAT50',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(200);

      expect(response.body.promo.discountFlat).toBe(50);
    });

    it('should handle server errors gracefully', async () => {
      PromoCode.findOne = jest.fn().mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/promo/validate')
        .send({
          code: 'ERROR',
          serviceKey: 'hydraulik',
          baseAmount: 1000
        })
        .expect(500);

      expect(response.body.message).toBe('Błąd walidacji kodu');
    });
  });
});

