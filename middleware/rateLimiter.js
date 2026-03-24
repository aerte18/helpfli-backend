const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

// In development, disable all rate limiters unless explicitly enabled
const DISABLE_LIMITERS = (process.env.ENABLE_RATE_LIMIT !== '1') && (process.env.NODE_ENV !== 'production');

// Helper: no-op middleware
const passThrough = (req, res, next) => next();

// Rate limiter dla autentykacji
const authLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max: process.env.NODE_ENV === 'development' ? 500 : 5, // 500 prób w dev, 5 w prod
  message: {
    error: 'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.',
    retryAfter: 15 * 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Pomiń dla zaufanych IP (opcjonalnie)
  skip: (req) => {
    const trustedIPs = process.env.TRUSTED_IPS?.split(',') || [];
    return trustedIPs.includes(req.ip);
  }
});

// Rate limiter dla rejestracji
const registerLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 60 * 60 * 1000, // 1 godzina
  max: process.env.NODE_ENV === 'development' ? 20 : 3, // 20 w dev, 3 w prod
  message: {
    error: 'Zbyt wiele prób rejestracji. Spróbuj ponownie za godzinę.',
    retryAfter: 60 * 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter dla API
const apiLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max: process.env.NODE_ENV === 'development' ? 5000 : 100, // 5000 w dev, 100 w prod
  message: {
    error: 'Zbyt wiele requestów. Spróbuj ponownie za chwilę.',
    retryAfter: 15 * 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter dla wyszukiwania
const searchLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuta
  max: 30, // 30 wyszukiwań na minutę
  message: {
    error: 'Zbyt wiele wyszukiwań. Poczekaj chwilę.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter dla wycen (dla providerów)
const quoteLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 60 * 60 * 1000, // 1 godzina
  max: 20, // 20 wycen na godzinę
  message: {
    error: 'Zbyt wiele wycen w krótkim czasie. Poczekaj godzinę.',
    retryAfter: 60 * 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter dla wiadomości w czacie
const chatLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuta
  max: 10, // 10 wiadomości na minutę
  message: {
    error: 'Zbyt wiele wiadomości. Poczekaj chwilę.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Speed limiter - spowalnia requesty po przekroczeniu limitu
const speedLimiter = DISABLE_LIMITERS ? passThrough : slowDown({
  windowMs: 15 * 60 * 1000, // 15 minut
  delayAfter: 50, // spowalnia po 50 requestach
  delayMs: () => 500, // dodaje 500ms opóźnienia
  maxDelayMs: 20000, // maksymalne opóźnienie 20 sekund
  skipFailedRequests: false,
  skipSuccessfulRequests: false
});

// Rate limiter dla telemetry
const telemetryLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuta
  max: 100, // 100 eventów telemetry na minutę
  message: {
    error: 'Zbyt wiele eventów telemetry.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter dla uploadu plików
const uploadLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 60 * 60 * 1000, // 1 godzina
  max: 10, // 10 uploadów na godzinę
  message: {
    error: 'Zbyt wiele uploadów plików. Spróbuj ponownie za godzinę.',
    retryAfter: 60 * 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  authLimiter,
  registerLimiter,
  apiLimiter,
  searchLimiter,
  quoteLimiter,
  chatLimiter,
  speedLimiter,
  telemetryLimiter,
  uploadLimiter
};
