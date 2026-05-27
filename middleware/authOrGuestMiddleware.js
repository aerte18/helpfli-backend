const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { syncProviderSubscriptionLimits } = require('../utils/syncProviderSubscriptionLimits');
const { isValidGuestId } = require('../utils/guestAiTrial');

/**
 * JWT albo gość (X-Guest-Id). Wykonawcy / firmy wymagają pełnego logowania.
 */
const authOrGuestMiddleware = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (authHeader) {
    try {
      const decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id)
        .select('-password')
        .populate('services', 'name_pl name_en parent_slug slug code icon');
      if (!req.user) throw new Error('User not found');
      if (!req.user.isActive || req.user.anonymized) {
        return res.status(401).json({ message: 'Konto zostało zamknięte lub wyłączone.' });
      }
      if (req.user.role === 'provider') {
        await syncProviderSubscriptionLimits(req.user._id);
        req.user = await User.findById(decoded.id)
          .select('-password')
          .populate('services', 'name_pl name_en parent_slug slug code icon');
        await User.findByIdAndUpdate(req.user._id, {
          'provider_status.lastSeenAt': new Date(),
        });
      }
      req.authMode = 'user';
      return next();
    } catch {
      return res.status(401).json({ message: 'Nieautoryzowany dostęp' });
    }
  }

  const guestId = req.header('X-Guest-Id') || req.header('x-guest-id');
  if (!guestId || !isValidGuestId(guestId)) {
    return res.status(401).json({
      message: 'Zaloguj się lub rozpocznij darmową rozmowę z AI (brak tokenu lub X-Guest-Id).',
      code: 'AUTH_OR_GUEST_REQUIRED',
      requiresAuth: true,
    });
  }

  req.guest = { id: guestId };
  req.isGuest = true;
  req.authMode = 'guest';
  return next();
};

module.exports = { authOrGuestMiddleware };
