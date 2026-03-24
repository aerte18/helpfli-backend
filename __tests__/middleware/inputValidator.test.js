/**
 * Testy dla input validator middleware
 */

const express = require('express');
const request = require('supertest');
const {
  validateRequest,
  validateRegistration,
  validateLogin,
  validateSearch,
  validateCreateOrder,
  validateQuote,
  validateObjectId,
  validateChatMessage,
  validateTelemetry,
  validateFileUpload
} = require('../../middleware/inputValidator');

describe('Input Validator Middleware', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  describe('validateRequest', () => {
    it('should pass when no validation errors', (done) => {
      app.post('/test', validateRequest, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/test')
        .send({})
        .expect(200, done);
    });
  });

  describe('validateRegistration', () => {
    it('should reject invalid email', (done) => {
      app.post('/register', validateRegistration, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/register')
        .send({
          name: 'Test User',
          email: 'invalid-email',
          password: 'Test123!',
          role: 'client'
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('Błąd walidacji danych');
          expect(res.body.details).toBeInstanceOf(Array);
        })
        .end(done);
    });

    it('should reject weak password', (done) => {
      app.post('/register', validateRegistration, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/register')
        .send({
          name: 'Test User',
          email: 'test@example.com',
          password: 'weak',
          role: 'client'
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.details.some(d => d.field === 'password')).toBe(true);
        })
        .end(done);
    });

    it('should accept valid registration data', (done) => {
      app.post('/register', validateRegistration, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/register')
        .send({
          name: 'Test User',
          email: 'test@example.com',
          password: 'Test123!@#',
          role: 'client'
        })
        .expect(200, done);
    });

    it('should reject invalid role', (done) => {
      app.post('/register', validateRegistration, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/register')
        .send({
          name: 'Test User',
          email: 'test@example.com',
          password: 'Test123!@#',
          role: 'invalid_role'
        })
        .expect(400, done);
    });
  });

  describe('validateLogin', () => {
    it('should reject invalid email', (done) => {
      app.post('/login', validateLogin, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/login')
        .send({
          email: 'invalid-email',
          password: 'password123'
        })
        .expect(400, done);
    });

    it('should reject empty password', (done) => {
      app.post('/login', validateLogin, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/login')
        .send({
          email: 'test@example.com',
          password: ''
        })
        .expect(400, done);
    });

    it('should accept valid login data', (done) => {
      app.post('/login', validateLogin, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/login')
        .send({
          email: 'test@example.com',
          password: 'password123'
        })
        .expect(200, done);
    });
  });

  describe('validateSearch', () => {
    it('should accept valid search query', (done) => {
      app.get('/search', validateSearch, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .get('/search?q=hydraulik&city=Warszawa')
        .expect(200, done);
    });

    it('should reject query with invalid characters', (done) => {
      app.get('/search', validateSearch, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .get('/search?q=<script>alert("xss")</script>')
        .expect(400, done);
    });

    it('should reject invalid minRating', (done) => {
      app.get('/search', validateSearch, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .get('/search?minRating=10')
        .expect(400, done);
    });
  });

  describe('validateCreateOrder', () => {
    it('should reject missing service', (done) => {
      app.post('/orders', validateCreateOrder, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/orders')
        .send({
          description: 'Test order'
        })
        .expect(400, done);
    });

    it('should reject invalid latitude', (done) => {
      app.post('/orders', validateCreateOrder, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/orders')
        .send({
          service: 'hydraulik',
          location: {
            lat: 100, // Invalid (> 90)
            lng: 21
          }
        })
        .expect(400, done);
    });

    it('should accept valid order data', (done) => {
      app.post('/orders', validateCreateOrder, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/orders')
        .send({
          service: 'hydraulik',
          description: 'Naprawa kranu',
          location: {
            lat: 52.2297,
            lng: 21.0122
          },
          budget: 500
        })
        .expect(200, done);
    });
  });

  describe('validateQuote', () => {
    it('should reject negative price', (done) => {
      app.post('/quotes', validateQuote, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/quotes')
        .send({
          price: -100
        })
        .expect(400, done);
    });

    it('should accept valid quote data', (done) => {
      app.post('/quotes', validateQuote, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/quotes')
        .send({
          price: 500,
          estimatedTime: '2 godziny',
          comment: 'Standardowa naprawa'
        })
        .expect(200, done);
    });
  });

  describe('validateObjectId', () => {
    it('should reject invalid MongoDB ObjectId', (done) => {
      app.get('/users/:id', validateObjectId('id'), (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .get('/users/invalid-id')
        .expect(400, done);
    });

    it('should accept valid MongoDB ObjectId', (done) => {
      app.get('/users/:id', validateObjectId('id'), (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .get('/users/507f1f77bcf86cd799439011')
        .expect(200, done);
    });
  });

  describe('validateChatMessage', () => {
    it('should reject empty message', (done) => {
      app.post('/chat', validateChatMessage, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/chat')
        .send({
          text: '',
          orderId: '507f1f77bcf86cd799439011'
        })
        .expect(400, done);
    });

    it('should reject message with HTML tags', (done) => {
      app.post('/chat', validateChatMessage, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/chat')
        .send({
          text: '<script>alert("xss")</script>',
          orderId: '507f1f77bcf86cd799439011'
        })
        .expect(400, done);
    });

    it('should accept valid message', (done) => {
      app.post('/chat', validateChatMessage, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/chat')
        .send({
          text: 'Hello, how are you?',
          orderId: '507f1f77bcf86cd799439011'
        })
        .expect(200, done);
    });
  });

  describe('validateTelemetry', () => {
    it('should reject invalid event type', (done) => {
      app.post('/telemetry', validateTelemetry, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/telemetry')
        .send({
          eventType: 'invalid_event'
        })
        .expect(400, done);
    });

    it('should accept valid event type', (done) => {
      app.post('/telemetry', validateTelemetry, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/telemetry')
        .send({
          eventType: 'page_view',
          properties: {},
          metadata: {}
        })
        .expect(200, done);
    });
  });

  describe('validateFileUpload', () => {
    it('should reject when no file provided', (done) => {
      app.post('/upload', validateFileUpload, (req, res) => {
        res.status(200).json({ success: true });
      });

      request(app)
        .post('/upload')
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('Brak pliku do uploadu');
        })
        .end(done);
    });
  });
});

