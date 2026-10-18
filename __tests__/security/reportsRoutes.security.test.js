const express = require('express');
const request = require('supertest');

const mockExists = jest.fn();
const mockCreate = jest.fn();

jest.mock('../../models/Report', () => ({
  exists: (...args) => mockExists(...args),
  create: (...args) => mockCreate(...args),
}));

jest.mock('../../middleware/authMiddleware', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', role: 'client' };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  reportLimiter: (_req, _res, next) => next(),
}));

const router = require('../../routes/reports');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('reports abuse prevention', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates a moderation report without automatically suspending the target', async () => {
    mockExists.mockResolvedValue(false);
    mockCreate.mockResolvedValue({ _id: 'report-1' });

    const response = await request(makeApp()).post('/').send({
      reportedUser: '507f191e810c19729de860ea',
      reason: 'Powtarzające się nadużycie w wiadomościach.',
    });

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      user: '507f1f77bcf86cd799439011',
      reportedUser: '507f191e810c19729de860ea',
    }));
  });

  test('rejects a duplicate report from the same account', async () => {
    mockExists.mockResolvedValue(true);

    const response = await request(makeApp()).post('/').send({
      reportedUser: '507f191e810c19729de860ea',
      reason: 'Powtarzające się nadużycie w wiadomościach.',
    });

    expect(response.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
