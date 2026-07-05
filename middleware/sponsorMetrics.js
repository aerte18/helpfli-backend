const rateLimit = require('express-rate-limit');

const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Zbyt wiele żądań metryk reklamowych' },
});

function sponsorMetricsGuard(req, res, next) {
  const origin = req.headers.origin || req.headers.referer || '';
  const allowed = (process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'https://helpfli.pl')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const okOrigin =
    !origin ||
    allowed.some((base) => origin.startsWith(base)) ||
    (process.env.NODE_ENV !== 'production' && /localhost|127\.0\.0\.1/.test(origin));
  if (!okOrigin) {
    return res.status(403).json({ message: 'Niedozwolone źródło żądania' });
  }
  return next();
}

module.exports = { metricsLimiter, sponsorMetricsGuard };
