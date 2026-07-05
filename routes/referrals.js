const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const ReferralCode = require('../models/ReferralCode');
const Referral = require('../models/Referral');
const UserSubscription = require('../models/UserSubscription');
const User = require('../models/User');
const {
  REFERRAL_REWARD_RULES,
  REFERRAL_CREDIT_PLN,
  plnToLoyaltyPoints,
} = require('../utils/growthRewards');
const { getFrontendUrl } = require('../utils/publicUrl');

function getShareUrl(code) {
  return `${getFrontendUrl()}/register?ref=${encodeURIComponent(code)}`;
}

function mapReferralForHistory(ref) {
  const rr = ref.referrerReward || {};
  const rd = ref.referredReward || {};
  const signupPts = Number(rr.points) || 0;
  const creditGranted = !!rr.welcomeCreditGranted;
  const providerGranted = !!rr.providerReferralGranted;

  let milestoneLabel = 'Oczekuje na warunek';
  if (ref.status === 'rewarded') {
    if (creditGranted) milestoneLabel = 'Kredyt po zleceniu przyznany';
    else if (providerGranted) milestoneLabel = 'Nagroda wykonawcy przyznana';
    else milestoneLabel = 'Nagrody przyznane';
  } else if (ref.status === 'pending') {
    milestoneLabel =
      ref.referredRole === 'client'
        ? 'Czeka na pierwsze ukończone zlecenie'
        : 'Czeka na ukończenie profilu wykonawcy';
  }

  return {
    _id: ref._id,
    referred: ref.referred,
    referredRole: ref.referredRole,
    status: ref.status,
    createdAt: ref.createdAt,
    completedAt: ref.completedAt,
    signupPointsReferrer: signupPts,
    signupPointsReferred: Number(rd.points) || 0,
    creditGranted,
    creditPln: creditGranted ? REFERRAL_CREDIT_PLN : 0,
    creditPoints: creditGranted ? plnToLoyaltyPoints(REFERRAL_CREDIT_PLN) : 0,
    providerReferralGranted: providerGranted,
    proDaysAdded: providerGranted ? Number(rr.proDaysAdded) || 30 : 0,
    extraBoosts: providerGranted ? 5 : 0,
    milestoneLabel,
  };
}

// GET /api/referrals/rules — zasady nagród (publiczne)
router.get('/rules', (_req, res) => {
  res.json({ rules: REFERRAL_REWARD_RULES });
});

// GET /api/referrals/my-code — @deprecated Użyj User.referralCode z GET /api/referrals/me (program growth).
router.get('/my-code', auth, async (req, res) => {
  res.set('Deprecation', 'true');
  res.set('Link', '</api/referrals/me>; rel="successor-version"');
  try {
    if (req.user.referralCode) {
      return res.json({
        code: req.user.referralCode,
        deprecated: true,
        message: 'Użyj GET /api/referrals/me — ten endpoint dotyczy starego programu subskrypcyjnego.',
        shareUrl: getShareUrl(req.user.referralCode),
      });
    }
    let referralCode = await ReferralCode.findOne({
      referrer: req.user._id,
      active: true,
    });

    if (!referralCode) {
      const code = ReferralCode.generateCode(req.user._id);
      referralCode = await ReferralCode.create({
        code,
        referrer: req.user._id,
        referrerRole: req.user.role,
        rewards: {
          referrerReward: req.user.role === 'provider' ? '1_month_pro' : '1_month_standard',
          refereeReward: '20_percent_discount',
        },
      });
    }

    res.json({
      code: referralCode.code,
      totalUses: referralCode.totalUses,
      usedBy: referralCode.usedBy.length,
      rewards: referralCode.rewards,
    });
  } catch (error) {
    console.error('Error getting referral code:', error);
    res.status(500).json({ message: 'Błąd pobierania kodu polecającego' });
  }
});

// POST /api/referrals/use — @deprecated Wyłączone — użyj rejestracji ?ref= + program growth.
router.post('/use', auth, async (req, res) => {
  res.set('Deprecation', 'true');
  return res.status(410).json({
    message:
      'Ten endpoint jest wyłączony. Użyj kodu przy rejestracji (?ref=) — nagrody przyznawane są po spełnieniu warunków (pierwsze zlecenie / ukończony onboarding wykonawcy).',
    code: 'REFERRAL_USE_DEPRECATED',
    successor: '/api/referrals/me',
  });
});

router.get('/stats', auth, async (req, res) => {
  try {
    const referrals = await Referral.find({ referrer: req.user._id });
    res.json({
      totalReferrals: referrals.length,
      pendingReferrals: referrals.filter((r) => r.status === 'pending').length,
      rewardedReferrals: referrals.filter((r) => r.status === 'rewarded').length,
    });
  } catch (error) {
    console.error('Error getting referral stats:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

// GET /api/referrals/me — kod z User.referralCode + statystyki z modelu Referral
router.get('/me', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select('referralCode role name email');
    let code = me?.referralCode;

    if (!code) {
      const crypto = require('crypto');
      code = `HELPFLI-${crypto
        .createHash('sha256')
        .update(String(me.email || me._id) + Date.now())
        .digest('hex')
        .substring(0, 8)
        .toUpperCase()}`;
      await User.findByIdAndUpdate(req.user._id, { referralCode: code });
    }

    const referrals = await Referral.find({ referrer: req.user._id }).populate(
      'referred',
      'name role onboardingCompleted'
    );

    const signupPointsTotal = referrals.reduce(
      (sum, r) => sum + (Number(r.referrerReward?.points) || 0),
      0
    );
    const creditRewardsCount = referrals.filter((r) => r.referrerReward?.welcomeCreditGranted).length;
    const providerRewardsCount = referrals.filter((r) => r.referrerReward?.providerReferralGranted).length;
    const pendingClientMilestones = referrals.filter(
      (r) => r.referredRole === 'client' && r.status === 'pending' && !r.referrerReward?.welcomeCreditGranted
    ).length;
    const pendingProviderMilestones = referrals.filter(
      (r) => r.referredRole === 'provider' && r.status === 'pending' && !r.referrerReward?.providerReferralGranted
    ).length;

    const stats = {
      totalReferrals: referrals.length,
      pendingReferrals: referrals.filter((r) => r.status === 'pending').length,
      rewardedReferrals: referrals.filter((r) => r.status === 'rewarded').length,
      totalSignupPoints: signupPointsTotal,
      totalCreditPlnEarned: creditRewardsCount * REFERRAL_CREDIT_PLN,
      totalCreditPointsEarned: creditRewardsCount * plnToLoyaltyPoints(REFERRAL_CREDIT_PLN),
      clientsReferred: referrals.filter((r) => r.referredRole === 'client').length,
      providersReferred: referrals.filter((r) => r.referredRole === 'provider').length,
      pendingClientMilestones,
      pendingProviderMilestones,
      providerRewardsGranted: providerRewardsCount,
    };

    res.json({
      referralCode: code,
      shareUrl: getShareUrl(code),
      stats,
      rules: REFERRAL_REWARD_RULES,
      role: me?.role || req.user.role,
    });
  } catch (error) {
    console.error('Error getting referral data:', error);
    res.status(500).json({ message: 'Błąd pobierania danych polecających' });
  }
});

router.get('/history', auth, async (req, res) => {
  try {
    const referrals = await Referral.find({ referrer: req.user._id })
      .populate('referred', 'name email role onboardingCompleted')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({
      referrals: referrals.map(mapReferralForHistory),
      rules: REFERRAL_REWARD_RULES,
    });
  } catch (error) {
    console.error('Error getting referral history:', error);
    res.status(500).json({ message: 'Błąd pobierania historii poleceń' });
  }
});

module.exports = router;
