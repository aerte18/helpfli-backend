const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

// In development, disable all rate limiters unless explicitly enabled
const DISABLE_LIMITERS = (process.env.ENABLE_RATE_LIMIT !== '1') && (process.env.NODE_ENV !== 'production');

function envInt(name, defaultVal) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

// Helper: no-op middleware
const passThrough = (req, res, next) => next();

/** GET binarnych załączników zleceń — nie zużywają ogólnego limitu API ani speed limitera (strona z wieloma miniaturami). */
function isOrderAttachmentBinaryGet(req) {
  if (req.method !== 'GET') return false;
  const url = req.originalUrl || req.url || '';
  return (
    url.includes('/api/orders/') &&
    url.includes('/attachments/') &&
    (url.includes('/file') || url.includes('resolve-file'))
  );
}
const API_LIMIT_SKIP_PATHS = [
  '/api/notifications/unread/count',
  '/api/orders/temp-upload',
  // Własne limitery (auth/register) — nie podwajać naliczania ogólnym apiLimiter
  '/api/auth/login',
  '/api/auth/register',
  // Publiczne endpointy mocno używane przez Home/Landing
  '/api/search',
  '/api/services'
];

const AUTH_WINDOW_MS = envInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const AUTH_MAX = envInt(
  'AUTH_RATE_LIMIT_MAX',
  process.env.NODE_ENV === 'development' ? 500 : 100
);
const authRetryMinutes = Math.max(1, Math.round(AUTH_WINDOW_MS / 60000));

// Rate limiter dla autentykacji
const authLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: AUTH_MAX,
  // Ograniczaj per login (email + IP), żeby shared NAT/VPN nie blokował wszystkich.
  keyGenerator: (req) => {
    const email = normalizeEmail(req?.body?.email);
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    return `auth:${email || 'anon'}:${ip}`;
  },
  // Udane logowania (2xx) nie zużywają limitu — zostaje ochrona przed brute-force na złe hasło
  skipSuccessfulRequests: true,
  message: {
    error: `Zbyt wiele prób logowania. Spróbuj ponownie za ${authRetryMinutes} minut.`,
    retryAfter: Math.floor(AUTH_WINDOW_MS / 1000),
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterSec = Number(res.getHeader('Retry-After')) || Math.floor(AUTH_WINDOW_MS / 1000);
    return res.status(options.statusCode).json({
      error: `Zbyt wiele prób logowania. Spróbuj ponownie za ${Math.max(1, Math.ceil(retryAfterSec / 60))} min.`,
      retryAfter: retryAfterSec,
    });
  },
  // Pomiń dla zaufanych IP (opcjonalnie)
  skip: (req) => {
    // Nie naliczaj preflight/GET itp. — limiter logowania dotyczy tylko realnego POST /login
    if (req.method !== 'POST') return true;
    const trustedIPs = process.env.TRUSTED_IPS?.split(',') || [];
    return trustedIPs.includes(req.ip);
  }
});

const REGISTER_WINDOW_MS = envInt('REGISTER_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000);
const REGISTER_MAX = envInt(
  'REGISTER_RATE_LIMIT_MAX',
  process.env.NODE_ENV === 'development' ? 20 : 10
);

// Rate limiter dla rejestracji
const registerLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: REGISTER_WINDOW_MS,
  max: REGISTER_MAX,
  message: {
    error: 'Zbyt wiele prób rejestracji. Spróbuj ponownie za godzinę.',
    retryAfter: Math.floor(REGISTER_WINDOW_MS / 1000)
  },
  standardHeaders: true,
  legacyHeaders: false
});

const API_WINDOW_MS = envInt('API_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const API_MAX = envInt(
  'API_RATE_LIMIT_MAX',
  process.env.NODE_ENV === 'development' ? 5000 : 1200
);

// Rate limiter dla API
const apiLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: API_WINDOW_MS,
  max: API_MAX,
  message: {
    error: 'Zbyt wiele requestów. Spróbuj ponownie za chwilę.',
    retryAfter: Math.floor(API_WINDOW_MS / 1000)
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const trustedIPs = process.env.TRUSTED_IPS?.split(',') || [];
    if (trustedIPs.includes(req.ip)) return true;
    if (isOrderAttachmentBinaryGet(req)) return true;
    const url = req.originalUrl || req.url || '';
    return API_LIMIT_SKIP_PATHS.some((path) => url.startsWith(path));
  }
});

// Rate limiter dla wyszukiwania
const searchLimiter = DISABLE_LIMITERS ? passThrough : rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuta
  max: 120, // 120 wyszukiwań na minutę
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
  skipSuccessfulRequests: false,
  skip: (req) => isOrderAttachmentBinaryGet(req)
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
