const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');

// Middleware do automatycznej aktywacji funkcji PRO dla providerów na podstawie SubscriptionPlan
const proPackageMiddleware = async (req, res, next) => {
  try {
    if (req.user && req.user.role === 'provider') {
      const userId = req.user._id;

      const now = new Date();
      // Sprawdź aktywną subskrypcję lub grace period (7 dni po wygaśnięciu)
      const subscription = await UserSubscription.findOne({
        user: userId,
        $or: [
          { validUntil: { $gt: now } }, // Aktywna subskrypcja
          { gracePeriodUntil: { $gt: now } } // Grace period (read-only dostęp)
        ]
      });

      if (subscription) {
        const plan = await SubscriptionPlan.findOne({ key: subscription.planKey, active: true });
        if (plan) {
          const user = await User.findById(userId);
          if (user) {
            // 1) Limity i tier z planu
            if (typeof plan.providerOffersLimit === 'number') {
              user.monthlyOffersLimit = plan.providerOffersLimit;
            }
            if (plan.providerTier) {
              user.providerTier = plan.providerTier;
            }

            // 2) Funkcje PRO tylko dla najwyższego pakietu providera (np. PROV_PRO)
            const isProProviderPlan = plan.key === 'PROV_PRO' || plan.providerTier === 'pro';
            if (isProProviderPlan) {
              const validUntil = subscription.validUntil;

              user.promo = user.promo || {};
              user.promo.highlightUntil = validUntil;
              user.promo.topBadgeUntil = validUntil;
              user.promo.aiTopTagUntil = validUntil;
              user.promo.rankBoostPoints = 100;
              user.promo.rankBoostUntil = validUntil;

              if (!user.badges || !user.badges.includes('pro')) {
                user.badges = user.badges || [];
                user.badges.push('pro');
              }

              // Ustaw poziomy widoczne w UI / rankingach
              user.level = 'pro';
              user.providerLevel = 'pro';

              user.isTopProvider = true;
              user.hasHelpfliGuarantee = true;

              console.log(`✅ Aktywowano funkcje PRO dla providera ${user.name} (${user.email})`);
            }

            await user.save();
          }
        }
      }
    }

    next();
  } catch (error) {
    console.error('❌ Błąd w proPackageMiddleware:', error);
    next();
  }
};

module.exports = { proPackageMiddleware };
