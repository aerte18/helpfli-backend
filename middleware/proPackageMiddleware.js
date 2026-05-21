const { getUserFromToken } = require('./authMiddleware');
const { syncProviderSubscriptionLimits } = require('../utils/syncProviderSubscriptionLimits');

// Synchronizacja limitów PRO — JWT, bo req.user nie istnieje jeszcze w globalnym middleware.
const proPackageMiddleware = async (req, res, next) => {
  try {
    const userId = getUserFromToken(req);
    if (userId) {
      await syncProviderSubscriptionLimits(userId);
    }
    next();
  } catch (error) {
    console.error('❌ Błąd w proPackageMiddleware:', error);
    next();
  }
};

module.exports = { proPackageMiddleware };
