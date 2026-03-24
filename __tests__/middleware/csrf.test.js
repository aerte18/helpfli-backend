/**
 * Testy jednostkowe dla CSRF protection middleware
 */

const { csrfProtection, generateCsrfToken } = require('../../middleware/csrf');
const crypto = require('crypto');

// Mock logger
jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn()
}));

describe('CSRF Protection Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      method: 'POST',
      path: '/api/test',
      cookies: {},
      headers: {},
      body: {},
      ip: '127.0.0.1'
    };
    res = {
      cookie: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateCsrfToken', () => {
    it('should generate a valid hex token', () => {
      const token = generateCsrfToken();
      
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('should generate different tokens each time', () => {
      const token1 = generateCsrfToken();
      const token2 = generateCsrfToken();
      
      expect(token1).not.toBe(token2);
    });
  });

  describe('csrfProtection', () => {
    it('should skip CSRF for GET requests', () => {
      req.method = 'GET';
      
      csrfProtection(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('should skip CSRF for HEAD requests', () => {
      req.method = 'HEAD';
      
      csrfProtection(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip CSRF for OPTIONS requests', () => {
      req.method = 'OPTIONS';
      
      csrfProtection(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip CSRF for webhook endpoints', () => {
      req.method = 'POST';
      req.path = '/api/payments/webhook';
      
      csrfProtection(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip CSRF for API with JWT token', () => {
      req.method = 'POST';
      req.headers.authorization = 'Bearer valid-jwt-token';
      
      csrfProtection(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should generate and set cookie when no CSRF token exists', () => {
      req.method = 'POST';
      req.cookies = {};
      
      csrfProtection(req, res, next);

      expect(res.cookie).toHaveBeenCalled();
      expect(req.csrfToken).toBeDefined();
      expect(next).toHaveBeenCalled();
    });

    it('should return 403 when CSRF token is missing for POST', () => {
      req.method = 'POST';
      req.cookies = { _csrf: 'cookie-token' };
      req.headers = {};
      req.body = {};
      
      csrfProtection(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'CSRF token missing',
        message: 'Brak tokenu CSRF. Odśwież stronę i spróbuj ponownie.'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when CSRF tokens do not match', () => {
      req.method = 'POST';
      req.cookies = { _csrf: 'cookie-token' };
      req.headers = { 'x-csrf-token': 'different-token' };
      
      csrfProtection(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'CSRF token mismatch',
        message: 'Nieprawidłowy token CSRF. Odśwież stronę i spróbuj ponownie.'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow request when CSRF tokens match', () => {
      const token = 'valid-csrf-token';
      req.method = 'POST';
      req.cookies = { _csrf: token };
      req.headers = { 'x-csrf-token': token };
      
      csrfProtection(req, res, next);

      expect(req.csrfToken).toBe(token);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should check token from body._csrf if not in header', () => {
      const token = 'valid-csrf-token';
      req.method = 'POST';
      req.cookies = { _csrf: token };
      req.body = { _csrf: token };
      
      csrfProtection(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

