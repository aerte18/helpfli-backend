/**
 * Testy jednostkowe dla middleware autentykacji
 */

const jwt = require('jsonwebtoken');
const { auth, getUserFromToken } = require('../../middleware/auth');
const User = require('../../models/User');

// Mock mongoose i User model
jest.mock('../../models/User');

describe('Auth Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      headers: {},
      user: null,
      userId: null
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    process.env.JWT_SECRET = 'test-secret-key-for-jwt-tokens-min-32-chars';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getUserFromToken', () => {
    it('should return null when no authorization header', () => {
      const userId = getUserFromToken(req);
      expect(userId).toBeNull();
    });

    it('should return null when token is invalid', () => {
      req.headers.authorization = 'Bearer invalid-token';
      const userId = getUserFromToken(req);
      expect(userId).toBeNull();
    });

    it('should return user ID when token is valid', () => {
      const userId = '507f1f77bcf86cd799439011';
      const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
      req.headers.authorization = `Bearer ${token}`;
      
      const result = getUserFromToken(req);
      expect(result).toBe(userId);
    });
  });

  describe('auth middleware', () => {
    it('should return 401 when no token provided', async () => {
      await auth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Brak autoryzacji' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when token is invalid', async () => {
      req.headers.authorization = 'Bearer invalid-token';
      
      await auth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Brak autoryzacji' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when user not found', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
      req.headers.authorization = `Bearer ${token}`;
      
      User.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(null)
      });

      await auth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Nieprawidłowy token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when user is inactive', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
      req.headers.authorization = `Bearer ${token}`;
      
      const mockUser = {
        _id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'client',
        isActive: false
      };
      User.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser)
      });

      await auth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Nieprawidłowy token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next() when user is valid and active', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
      req.headers.authorization = `Bearer ${token}`;
      
      const mockUser = {
        _id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'client',
        isActive: true,
        company: null,
        roleInCompany: null
      };
      User.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser)
      });

      await auth(req, res, next);

      expect(req.user).toEqual(mockUser);
      expect(req.userId).toBe(userId);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should add company info when user belongs to company', async () => {
      const userId = '507f1f77bcf86cd799439011';
      const companyId = '507f1f77bcf86cd799439012';
      const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
      req.headers.authorization = `Bearer ${token}`;
      
      const mockUser = {
        _id: userId,
        name: 'Test User',
        email: 'test@example.com',
        role: 'provider',
        isActive: true,
        company: companyId,
        roleInCompany: 'owner'
      };
      User.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser)
      });

      await auth(req, res, next);

      expect(req.userCompany).toBe(companyId);
      expect(req.userRoleInCompany).toBe('owner');
      expect(next).toHaveBeenCalled();
    });
  });
});

