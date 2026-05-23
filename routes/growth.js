const express = require('express');
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const {
  getFoundingProviderStatus,
  activateFoundingProvider,
  buildGrowthBenefitsSummary,
} = require('../utils/foundingProvider');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');

const router = express.Router();

/** Publiczny status programu Founding Provider (licznik miejsc). */
router.get('/founding-provider-status', async (_req, res) => {
  try {
    const status = await getFoundingProviderStatus();
    res.json(status);
  } catch (e) {
    console.error('[growth] founding-provider-status:', e?.message);
    res.json({
      limit: 1000,
      used: 0,
      remaining: 1000,
      enabled: true,
      fallback: true,
    });
  }
});

/** Aktywacja statusu przez zalogowanego providera. */
router.post('/activate-founding-provider', auth, async (req, res) => {
  try {
    const result = await activateFoundingProvider(req.user._id);
    if (!result.ok) {
      const statusMap = {
        NOT_PROVIDER: 403,
        ALREADY_ACTIVE: 409,
        ALREADY_USED: 409,
        LIMIT_REACHED: 409,
        NOT_FOUND: 404,
      };
      return res.status(statusMap[result.code] || 400).json({
        message: result.message,
        code: result.code,
      });
    }
    res.json({
      message: 'Aktywowano status Pierwszego wykonawcy Helpfli',
      founding: result.user,
      program: result.status,
    });
  } catch (e) {
    console.error('[growth] activate-founding-provider:', e);
    res.status(500).json({ message: 'Błąd aktywacji programu' });
  }
});

/** Podsumowanie benefitów growth dla zalogowanego użytkownika. */
router.get('/me', auth, async (req, res) => {
  try {
    const u = req.user;
    const program = await getFoundingProviderStatus();
    const sub = await UserSubscription.findOne({
      user: u._id,
      validUntil: { $gt: new Date() },
    });
    let subscriptionInfo = null;
    if (sub) {
      const plan = await SubscriptionPlan.findOne({ key: sub.planKey }).lean();
      subscriptionInfo = {
        planKey: sub.planKey,
        planName: plan?.name || sub.planKey,
        validUntil: sub.validUntil,
        renews: sub.renews,
      };
    }
    const growthBenefits = buildGrowthBenefitsSummary(u, subscriptionInfo, program);
    res.json({
      role: u.role,
      growthBenefits,
      foundingProvider: growthBenefits.provider?.foundingProvider || { active: false },
      welcomeCredit: growthBenefits.client?.welcomeCredit || {
        amountPln: u.welcomeCreditAmount ?? 0,
        used: !!u.welcomeCreditUsed,
        eligible: !!u.firstOrderBonusEligible,
      },
      subscription: subscriptionInfo,
      program,
    });
  } catch (e) {
    res.status(500).json({ message: 'Błąd pobierania danych growth' });
  }
});

/** Ręczne uruchomienie crona (admin / dev) */
router.post('/run-cron', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Tylko administrator' });
  }
  try {
    const { runOnce } = require('../jobs/foundingProviderGrowth');
    await runOnce();
    res.json({ message: 'Cron Founding Provider wykonany' });
  } catch (e) {
    res.status(500).json({ message: e?.message || 'Błąd crona' });
  }
});

module.exports = router;
