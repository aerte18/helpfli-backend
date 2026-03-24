// Middleware do obsługi white-label (routing per domena)
const whiteLabelService = require('../services/whiteLabelService');

/**
 * Middleware do wykrywania white-label po domenie
 * Użyj tego middleware na początku aplikacji, aby wykryć white-label
 */
const detectWhiteLabel = async (req, res, next) => {
  try {
    const host = req.get('host') || req.hostname;
    
    // Usuń port jeśli jest
    const domain = host.split(':')[0];
    
    // Sprawdź czy to domena white-label
    const whiteLabel = await whiteLabelService.getByDomain(domain);
    
    if (whiteLabel) {
      // Dodaj white-label do request
      req.whiteLabel = whiteLabel;
      
      // Zwiększ statystyki wizyt
      await whiteLabelService.incrementVisit(whiteLabel._id, false);
    }
    
    next();
  } catch (error) {
    console.error('DETECT_WHITELABEL_ERROR:', error);
    next(); // Kontynuuj nawet jeśli błąd
  }
};

/**
 * Middleware do wymuszania white-label
 * Jeśli użytkownik jest na domenie white-label, wymuś użycie tego white-label
 */
const enforceWhiteLabel = (req, res, next) => {
  if (req.whiteLabel && !req.whiteLabel.isActive) {
    return res.status(403).json({ 
      message: 'White-label nie jest aktywny' 
    });
  }
  next();
};

module.exports = {
  detectWhiteLabel,
  enforceWhiteLabel
};













