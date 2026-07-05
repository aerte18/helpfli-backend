/**
 * CSRF Protection Middleware
 * 
 * Uwaga: CSRF protection jest wymagane dla aplikacji webowych używających cookies/sessions.
 * Dla API używającego JWT tokens w headers, CSRF jest mniej krytyczne, ale nadal zalecane.
 * 
 * Implementacja używa double-submit cookie pattern (prostsze niż synchronizer token).
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/** Ścieżki wyłączone z walidacji CSRF (własna autoryzacja lub safe public API). */
const CSRF_SKIP_PREFIXES = [
  '/api/telemetry/public',
  '/api/growth/cron-webhook',
  '/api/health',
  '/api/payments/webhook',
  '/webhook'
];

function shouldSkipCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.path.includes('/webhook')) return true;
  if (CSRF_SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return true;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) return true;
  return false;
}

// Generuj CSRF token
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware do generowania i walidacji CSRF tokenów
const csrfProtection = (req, res, next) => {
  if (shouldSkipCsrf(req)) {
    return next();
  }

  // Dla formularzy HTML (jeśli używamy cookies/sessions)
  // Generuj token jeśli nie istnieje
  if (!req.cookies || !req.cookies['_csrf']) {
    const token = generateCsrfToken();
    res.cookie('_csrf', token, {
      httpOnly: false, // Musi być dostępny dla JavaScript (double-submit pattern)
      secure: process.env.NODE_ENV === 'production', // Tylko HTTPS w produkcji
      sameSite: 'strict',
      maxAge: 3600000 // 1 godzina
    });
    req.csrfToken = token;
    return next();
  }

  // Waliduj token dla POST/PUT/DELETE/PATCH
  const cookieToken = req.cookies['_csrf'];
  const headerToken = req.headers['x-csrf-token'] || req.body._csrf;

  if (!headerToken) {
    logger.warn(`CSRF token missing for ${req.method} ${req.path} from ${req.ip}`);
    return res.status(403).json({ 
      error: 'CSRF token missing',
      message: 'Brak tokenu CSRF. Odśwież stronę i spróbuj ponownie.'
    });
  }

  if (cookieToken !== headerToken) {
    logger.warn(`CSRF token mismatch for ${req.method} ${req.path} from ${req.ip}`);
    return res.status(403).json({ 
      error: 'CSRF token mismatch',
      message: 'Nieprawidłowy token CSRF. Odśwież stronę i spróbuj ponownie.'
    });
  }

  // Token jest poprawny
  req.csrfToken = cookieToken;
  next();
};

// Middleware do dodania CSRF tokena do response (dla formularzy)
const csrfToken = (req, res, next) => {
  // Jeśli token już istnieje w cookies, użyj go
  if (req.cookies && req.cookies['_csrf']) {
    res.locals.csrfToken = req.cookies['_csrf'];
  } else {
    // Generuj nowy token
    const token = generateCsrfToken();
    res.cookie('_csrf', token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000
    });
    res.locals.csrfToken = token;
  }
  next();
};

module.exports = {
  csrfProtection,
  csrfToken,
  generateCsrfToken
};

