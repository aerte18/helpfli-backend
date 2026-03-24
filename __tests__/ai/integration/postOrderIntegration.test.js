?/**
 * Testy integracji Post-Order Agent z endpointem /api/orders/:id/complete
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mock models
jest.mock('../../../models/Order');
jest.mock('../../../models/User');
jest.mock('../../../models/Service');
jest.mock('../../../services/NotificationService');

const Order = require('../../../models/Order');
const NotificationService = require('../../../services/NotificationService');
const { runPostOrderAgent } = require('../../../ai/agents/postOrderAgent');

describe('Post-Order Agent Integration', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Mock routes/orders endpoint
    const { authMiddleware: auth } = require('../../../middleware/authMiddleware');
    const { requireKycVerified } = require('../../../middleware/kyc');
    
    // Mock middleware
    const mockAuth = (req, res, next) => {
      req.user = { _id: 'provider123', id: 'provider123', role: 'provider' };
      next();
    };
    
    const mockKycVerified = (req, res, next) => next();
    
    const mockLoadOrderById = (req, res, next) => {
      req.order = {
        _id: 'order123',
        provider: 'provider123',
        status: 'in_progress',
        service: 'hydraulik',
        client: 'client123',
        paidInSystem: true,
        save: jest.fn().mockResolvedValue(true)
      };
      next();
    };
    
    app.post('/api/orders/:id/complete', mockAuth, mockKycVerified, mockLoadOrderById, async (req, res) => {
      try {
        const order = req.order;
        order.status = 'completed';
        order.completedAt = new Date();
        await order.save();
        
        // Notification
        try {
          await NotificationService.notifyOrderCompleted(order._id);
        } catch (error) {
          console.error('Notification error:', error);
        }
        
        // Post-Order Agent
        let postOrderResult = null;
        try {
          postOrderResult = await runPostOrderAgent({
            service: order.service || 'inne',
            outcome: 'completed',
            paidInApp: order.paidInSystem || false,
            rating: null
          });
          
          if (postOrderResult && postOrderResult.ok) {
            // W rzeczywistości zapisalibyśmy to do bazy
            order.aiPostOrderMessage = postOrderResult.messageToClient;
            order.aiFollowUpSuggestion = postOrderResult.followUp;
          }
        } catch (postOrderError) {
          console.error('Post-Order Agent error:', postOrderError);
        }
        
        res.json({ 
          message: 'Zlecenie zakończone', 
          order,
          ai: postOrderResult || null
        });
      } catch (e) {
        console.error('Complete order error:', e);
        res.status(500).json({ message: 'Błąd zakończenia zlecenia' });
      }
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('powinien wywołać Post-Order Agent po zakończeniu zlecenia', async () => {
    const response = await request(app)
      .post('/api/orders/order123/complete')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.ai).toBeDefined();
    expect(response.body.ai.ok).toBe(true);
    expect(response.body.ai.messageToClient).toBeDefined();
    expect(response.body.ai.ratingPrompt).toBeDefined();
    expect(response.body.ai.followUp).toBeDefined();
  });

  test('powinien zwrócić ratingPrompt.ask=true dla completed order', async () => {
    const response = await request(app)
      .post('/api/orders/order123/complete')
      .send({});

    expect(response.body.ai.ratingPrompt.ask).toBe(true);
    expect(response.body.ai.ratingPrompt.text).toBeDefined();
  });

  test('powinien zasugerować follow-up dla hydrauliki', async () => {
    Order.findById = jest.fn().mockResolvedValue({
      _id: 'order123',
      service: { code: 'hydraulik' },
      paidInSystem: true
    });

    const response = await request(app)
      .post('/api/orders/order123/complete')
      .send({});

    expect(response.body.ai.followUp.suggested).toBe(true);
    expect(response.body.ai.followUp.service).toBe('hydraulik_konserwacja');
    expect(response.body.ai.followUp.reason).toBeDefined();
  });

  test('powinien obsłużyć błąd Post-Order Agent gracefully', async () => {
    // Mock runPostOrderAgent żeby rzucił błąd
    jest.spyOn(require('../../../ai/agents/postOrderAgent'), 'runPostOrderAgent')
      .mockRejectedValueOnce(new Error('Post-Order Agent error'));

    const response = await request(app)
      .post('/api/orders/order123/complete')
      .send({});

    // Endpoint powinien zwrócić 200 nawet jeśli Post-Order Agent się nie powiódł
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Zlecenie zakończone');
    expect(response.body.order).toBeDefined();
    // AI może być null jeśli agent się nie powiódł
  });

  test('powinien zapisać aiPostOrderMessage do zlecenia', async () => {
    const mockSave = jest.fn().mockResolvedValue(true);
    Order.findByIdAndUpdate = jest.fn().mockResolvedValue({
      _id: 'order123',
      aiPostOrderMessage: 'Dziękujemy za korzystanie z Helpfli!'
    });

    const response = await request(app)
      .post('/api/orders/order123/complete')
      .send({});

    expect(response.body.ai).toBeDefined();
    expect(response.body.order.aiPostOrderMessage).toBeDefined();
    expect(typeof response.body.order.aiPostOrderMessage).toBe('string');
  });
});

