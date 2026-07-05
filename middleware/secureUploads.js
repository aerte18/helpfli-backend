const jwt = require('jsonwebtoken');
const path = require('path');

/** Ścieżki wymagające JWT (Bearer lub ?token= dla <img>). */
const SENSITIVE_PREFIXES = ['kyc', 'orders', 'chat', 'drafts', 'reports', 'platform'];

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query?.token && typeof req.query.token === 'string') return req.query.token;
  return null;
}

function verifyUploadToken(token) {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.id || decoded?.userId || null;
  } catch {
    return null;
  }
}

/**
 * Blokuje publiczny dostęp do wrażliwych plików w /uploads.
 * Awatary (/uploads/avatars) pozostają publiczne.
 */
function secureUploads(req, res, next) {
  const rel = (req.path || '').replace(/^\/+/, '').replace(/\\/g, '/');
  const top = rel.split('/')[0];
  if (!SENSITIVE_PREFIXES.includes(top)) return next();

  const userId = verifyUploadToken(extractToken(req));
  if (!userId) {
    return res.status(401).json({ message: 'Wymagana autoryzacja do pobrania pliku' });
  }
  req.uploadViewerId = userId;
  return next();
}

module.exports = { secureUploads, SENSITIVE_PREFIXES };
