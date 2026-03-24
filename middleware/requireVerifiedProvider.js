module.exports = function requireVerifiedProvider(req, res, next) {
  try {
    if (!req.user || req.user.role !== 'provider') {
      return res.status(403).json({ message: 'Tylko dla wykonawców.' });
    }
    if (req.user.kycStatus !== 'verified') {
      return res.status(403).json({ message: 'Wymagana pozytywna weryfikacja KYC, aby wykonać tę akcję.' });
    }
    next();
  } catch (e) { next(e); }
};























