// Middleware do autoryzacji partnerów API
const Partner = require('../models/Partner');
const crypto = require('crypto');

/**
 * Middleware do autoryzacji partnerów przez API Key
 * Sprawdza API Key w nagłówku X-API-Key
 */
const partnerAuth = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({ 
        error: 'UNAUTHORIZED',
        message: 'Brak API Key. Dodaj nagłówek X-API-Key.' 
      });
    }

    // Znajdź partnera po API Key
    const partner = await Partner.findOne({ apiKey, isActive: true, status: 'active' });
    
    if (!partner) {
      return res.status(401).json({ 
        error: 'UNAUTHORIZED',
        message: 'Nieprawidłowy lub nieaktywny API Key.' 
      });
    }

    // Sprawdź rate limiting
    const rateLimitCheck = partner.checkRateLimit();
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({ 
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Przekroczono limit żądań: ${rateLimitCheck.reason}`,
        retryAfter: 3600 // sekundy
      });
    }

    // Zwiększ licznik żądań
    await partner.incrementRequest();

    // Dodaj partnera do request
    req.partner = partner;
    next();
  } catch (error) {
    console.error('PARTNER_AUTH_ERROR:', error);
    res.status(500).json({ 
      error: 'INTERNAL_ERROR',
      message: 'Błąd autoryzacji partnera' 
    });
  }
};

/**
 * Middleware sprawdzające uprawnienia partnera
 * @param {String} permission - Nazwa uprawnienia (np. 'readOrders')
 */
const requirePartnerPermission = (permission) => {
  return (req, res, next) => {
    if (!req.partner) {
      return res.status(401).json({ 
        error: 'UNAUTHORIZED',
        message: 'Brak autoryzacji partnera' 
      });
    }

    if (!req.partner.canAccess(permission)) {
      return res.status(403).json({ 
        error: 'FORBIDDEN',
        message: `Brak uprawnień: ${permission}` 
      });
    }

    next();
  };
};

/**
 * Generuje nowy API Key dla partnera
 */
function generateApiKey() {
  return `pk_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Generuje API Secret (do hashowania)
 */
function generateApiSecret() {
  return crypto.randomBytes(64).toString('hex');
}

module.exports = {
  partnerAuth,
  requirePartnerPermission,
  generateApiKey,
  generateApiSecret
};













