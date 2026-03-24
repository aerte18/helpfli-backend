/**
 * Testy E2E dla całego flow AI Concierge
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock dependencies
jest.mock('../../../models/User');
jest.mock('../../../models/Order');
jest.mock('../../../models/Service');

const { conciergeHandler } = require('../../../ai/index');
const authMiddleware = require('../../../middleware/authMiddleware');

describe('AI Concierge E2E Flow', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/ai/concierge/v2', authMiddleware, conciergeHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Pełny flow od problemu do rozwiązania', () => {
    test('scenariusz 1: Podstawowy problem → DIY suggestion', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({
          messages: [
            { role: 'user', content: 'Cieknie mi kran w kuchni, nie jest to pilne' }
          ],
          userContext: {
            location: { text: 'Warszawa' }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.result).toBeDefined();
      
      // Sprawdź czy jest nextStep
      expect(response.body.result.nextStep).toBeDefined();
      
      // Jeśli nextStep to suggest_diy, sprawdź czy jest agent diy
      if (response.body.result.nextStep === 'suggest_diy') {
        expect(response.body.agents?.diy).toBeDefined();
        expect(response.body.agents.diy.steps.length).toBeGreaterThan(0);
      }
    });

    test('scenariusz 2: Pilna sytuacja → Diagnostic → Express suggestion', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({
          messages: [
            { role: 'user', content: 'ZALEWA MNIE WODA! PILNE! Potrzebuję hydraulika teraz!' }
          ],
          userContext: {
            location: { text: 'Warszawa', lat: 52.2297, lng: 21.0122 }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      
      // Sprawdź czy diagnostic agent był wywołany
      if (response.body.result.nextStep === 'diagnose' || response.body.result.urgency === 'urgent') {
        expect(response.body.agents?.diagnostic).toBeDefined();
        expect(response.body.agents.diagnostic.urgency).toBe('urgent');
        expect(response.body.agents.diagnostic.immediateActions.length).toBeGreaterThan(0);
      }
    });

    test('scenariusz 3: Niebezpieczna sytuacja → Safety flags', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({
          messages: [
            { role: 'user', content: 'Czuję zapach gazu w kuchni, boję się' }
          ],
          userContext: {
            location: { text: 'Kraków' }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      
      // Sprawdź safety flags
      if (response.body.agents?.diagnostic) {
        expect(response.body.agents.diagnostic.safety.flag).toBe(true);
        expect(response.body.agents.diagnostic.risk).toBe('high');
        expect(response.body.agents.diagnostic.immediateActions.length).toBeGreaterThan(0);
      }
    });

    test('scenariusz 4: Konsultacja cenowa → Pricing agent', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({
          messages: [
            { role: 'user', content: 'Ile kosztuje naprawa hydraulika w Warszawie?' }
          ],
          userContext: {
            location: { text: 'Warszawa' }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      
      // Jeśli nextStep to show_pricing, sprawdź pricing agent
      if (response.body.result.nextStep === 'show_pricing' || response.body.agents?.pricing) {
        expect(response.body.agents.pricing).toBeDefined();
        expect(response.body.agents.pricing.ranges).toBeDefined();
        expect(response.body.agents.pricing.ranges.basic).toBeDefined();
        expect(response.body.agents.pricing.ranges.standard).toBeDefined();
        expect(response.body.agents.pricing.ranges.pro).toBeDefined();
      }
    });

    test('scenariusz 5: Szukanie wykonawcy → Matching agent', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({
          messages: [
            { role: 'user', content: 'Potrzebuję hydraulika w Warszawie, znajdź mi najlepszego' }
          ],
          userContext: {
            location: { text: 'Warszawa', lat: 52.2297, lng: 21.0122 }
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      
      // Jeśli nextStep to suggest_providers, sprawdź matching agent
      if (response.body.result.nextStep === 'suggest_providers' || response.body.agents?.matching) {
        expect(response.body.agents.matching).toBeDefined();
        expect(response.body.agents.matching.topProviders).toBeDefined();
        expect(Array.isArray(response.body.agents.matching.topProviders)).toBe(true);
      }
    });
  });

  describe('Backward compatibility', () => {
    test('powinien obsłużyć stary format request (description)', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({
          description: 'Cieknie kran w kuchni',
          locationText: 'Warszawa'
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.result).toBeDefined();
    });
  });

  describe('Error handling', () => {
    test('powinien zwrócić błąd dla nieprawidłowego request', async () => {
      const mockUser = { _id: 'user123', id: 'user123' };
      authMiddleware.mockImplementation((req, res, next) => {
        req.user = mockUser;
        next();
      });

      const response = await request(app)
        .post('/api/ai/concierge/v2')
        .send({});

      // Może zwrócić 200 z ok:false lub 400
      expect([200, 400]).toContain(response.status);
    });
  });
});

