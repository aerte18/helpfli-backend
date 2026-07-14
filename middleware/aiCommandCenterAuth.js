const crypto = require('crypto');

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = console;
}

function extractProvidedToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const internal = req.headers['x-internal-token'];
  if (internal) return String(internal).trim();
  return '';
}

function safeEqualToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

function isIpAllowed(req) {
  const raw = process.env.AI_COMMAND_CENTER_ALLOWED_IPS;
  if (!raw || !String(raw).trim()) return true;
  const allowed = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return true;
  const ip = getClientIp(req);
  return allowed.includes(ip);
}

/**
 * Service-to-service auth dla read-only integracji marketingowej.
 * Wymaga AI_COMMAND_CENTER_READ_TOKEN (Bearer lub X-Internal-Token).
 */
function aiCommandCenterAuth(req, res, next) {
  const expected = process.env.AI_COMMAND_CENTER_READ_TOKEN;
  if (!expected || !String(expected).trim()) {
    return res.status(503).json({
      error: 'integration_unavailable',
      message: 'Integracja marketingowa nie jest skonfigurowana',
    });
  }

  const provided = extractProvidedToken(req);
  if (!provided) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Brak tokenu integracji',
    });
  }

  if (!safeEqualToken(provided, String(expected).trim())) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Nieprawidłowy token integracji',
    });
  }

  if (!isIpAllowed(req)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Adres IP nie jest na liście dozwolonych',
    });
  }

  req.integrationClient = 'ai_command_center';
  req.integrationScope = 'marketing_read';

  logger.info?.('[marketing-integration] authorized request', {
    method: req.method,
    path: req.originalUrl || req.url,
    ip: getClientIp(req),
    client: req.integrationClient,
  });

  next();
}

module.exports = {
  aiCommandCenterAuth,
  extractProvidedToken,
  safeEqualToken,
  getClientIp,
};
