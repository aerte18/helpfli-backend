const rateLimit = require('express-rate-limit');
const cfg = require('../config/marketingIntegration');

const DISABLE_LIMITERS =
  process.env.ENABLE_RATE_LIMIT !== '1' && process.env.NODE_ENV !== 'production';

const passThrough = (_req, _res, next) => next();

const marketingIntegrationRateLimiter = DISABLE_LIMITERS
  ? passThrough
  : rateLimit({
      windowMs: cfg.rateLimitWindowMs,
      max: cfg.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `acc-marketing:${req.integrationClient || 'unknown'}`,
      handler: (_req, res) =>
        res.status(429).json({
          error: 'rate_limited',
          message: 'Przekroczono limit zapytań integracji marketingowej',
          retryAfter: Math.ceil(cfg.rateLimitWindowMs / 1000),
        }),
    });

module.exports = { marketingIntegrationRateLimiter };
