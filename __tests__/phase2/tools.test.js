/**
 * Testy dla konkretnych narzędzi (Tools)
 */

// Mock concierge.js żeby uniknąć problemów z MongoDB aggregation syntax
jest.mock('../../utils/concierge', () => ({
  recommendProviders: jest.fn(() => Promise.resolve([
    { _id: '1', name: 'Test Provider', distanceKm: 5, avgRating: 4.5 }
  ])),
  computePriceHints: jest.fn(() => Promise.resolve({
    basic: { min: 100, max: 200 },
    standard: { min: 150, max: 300 },
    pro: { min: 250, max: 500 }
  })),
  getCityPricingMultiplier: jest.fn(() => ({ multiplier: 1.0 }))
}));

const mongoose = require('mongoose');
const createOrderTool = require('../../ai/tools/createOrderTool');
const searchProvidersTool = require('../../ai/tools/searchProvidersTool');
const getPriceHintsTool = require('../../ai/tools/getPriceHintsTool');

describe('Phase 2: Tools', () => {
  let userId;

  beforeAll(async () => {
    // Połącz z MongoDB i załaduj modele
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli_test');
    }
    
    // Załaduj modele (wymagane dla createOrderTool) - tylko jeśli nie są już załadowane
    try {
      require('../../models/Order');
      require('../../models/Service');
      require('../../models/User');
    } catch (e) {
      // Modele mogą być już załadowane
    }
    
    userId = new mongoose.Types.ObjectId();
  });

  afterAll(async () => {
    // Cleanup - usuń testowe zlecenia
    try {
      const Order = require('../../models/Order');
      await Order.deleteMany({ client: userId });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('createOrderTool', () => {
    test('should validate required parameters', async () => {
      const context = { userId };

      await expect(
        createOrderTool({}, context) // Brak wymaganych parametrów
      ).rejects.toThrow();
    });

    test('should create order with valid parameters', async () => {
      const Order = require('../../models/Order');
      const Service = require('../../models/Service');
      
      // Upewnij się że service 'inne' istnieje (używa slug)
      await Service.findOneAndUpdate(
        { slug: 'inne' },
        { 
          slug: 'inne', 
          parent_slug: 'inne',
          name_pl: 'Inne', 
          name_en: 'Other',
          description: 'Other service'
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const context = { userId };
      const params = {
        service: 'inne', // Slug service
        description: 'Test problem',
        location: 'Warszawa',
        urgency: 'standard'
      };

      const result = await createOrderTool(params, context);

      expect(result.success).toBe(true);
      expect(result.orderId).toBeDefined();
      expect(result.order).toBeDefined();
      expect(result.order.service).toBeDefined();
      expect(result.message).toContain('utworzone');

      // Cleanup
      if (result.orderId) {
        await Order.deleteOne({ _id: result.orderId }).catch(() => {});
      }
    }, 10000);
  });

  describe('searchProvidersTool', () => {
    test('should require service parameter', async () => {
      // Suppress console.error for this test
      const originalError = console.error;
      console.error = jest.fn();
      
      try {
        await expect(
          searchProvidersTool({}, {}) // Brak service
        ).rejects.toThrow('Service is required');
      } finally {
        console.error = originalError;
      }
    });

    test('should search providers', async () => {
      const params = {
        service: 'hydraulik',
        location: 'Warszawa'
      };

      const result = await searchProvidersTool(params, {});

      expect(result.success).toBe(true);
      expect(result.providers).toBeDefined();
      expect(Array.isArray(result.providers)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(0);
    }, 10000);
  });

  describe('getPriceHintsTool', () => {
    test('should require service parameter', async () => {
      // Suppress console.error for this test
      const originalError = console.error;
      console.error = jest.fn();
      
      try {
        await expect(
          getPriceHintsTool({}, {}) // Brak service
        ).rejects.toThrow('Service is required');
      } finally {
        console.error = originalError;
      }
    });

    test('should get price hints', async () => {
      const params = {
        service: 'hydraulik',
        location: 'Warszawa',
        urgency: 'standard'
      };

      const result = await getPriceHintsTool(params, {});

      expect(result.success).toBe(true);
      expect(result.service).toBe('hydraulik');
      expect(result.ranges).toBeDefined();
      expect(result.ranges.basic).toBeDefined();
      expect(result.ranges.standard).toBeDefined();
    }, 10000);
  });
});
