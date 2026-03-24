exports.requireKycVerified = (req, res, next) => {
  const u = req.user;
  if (!u) return res.status(401).json({ message: 'Unauthorized' });
  if (u.role !== 'provider') return res.status(403).json({ message: 'Tylko dla wykonawców' });

  if (u.kyc?.status !== 'verified') {
    return res.status(403).json({
      message: 'Wymagana weryfikacja KYC (zweryfikuj profil wykonawcy).',
      kycStatus: u.kyc?.status || 'not_started',
    });
  }
  next();
};






















