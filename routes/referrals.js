const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const ReferralCode = require('../models/ReferralCode');
const Referral = require('../models/Referral');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const User = require('../models/User');

// GET /api/referrals/my-code - Pobierz swój kod polecający
router.get('/my-code', auth, async (req, res) => {
  try {
    let referralCode = await ReferralCode.findOne({ 
      referrer: req.user._id, 
      active: true 
    });
    
    if (!referralCode) {
      // Generuj nowy kod
      const code = ReferralCode.generateCode(req.user._id);
      referralCode = await ReferralCode.create({
        code,
        referrer: req.user._id,
        referrerRole: req.user.role,
        rewards: {
          referrerReward: req.user.role === 'provider' ? '1_month_pro' : '1_month_standard',
          refereeReward: '20_percent_discount'
        }
      });
    }
    
    res.json({
      code: referralCode.code,
      totalUses: referralCode.totalUses,
      usedBy: referralCode.usedBy.length,
      rewards: referralCode.rewards
    });
  } catch (error) {
    console.error('Error getting referral code:', error);
    res.status(500).json({ message: 'Błąd pobierania kodu polecającego' });
  }
});

// POST /api/referrals/use - Użyj kodu polecającego przy subskrypcji
router.post('/use', auth, async (req, res) => {
  try {
    const { code, planKey } = req.body || {};
    
    if (!code || !planKey) {
      return res.status(400).json({ message: 'Kod i plan są wymagane' });
    }
    
    const referralCode = await ReferralCode.findOne({ 
      code: code.toUpperCase(), 
      active: true 
    });
    
    if (!referralCode) {
      return res.status(404).json({ message: 'Nieprawidłowy kod polecający' });
    }
    
    // Sprawdź czy kod nie wygasł
    if (referralCode.expiresAt && referralCode.expiresAt < new Date()) {
      return res.status(400).json({ message: 'Kod polecający wygasł' });
    }
    
    // Sprawdź limit użyć
    if (referralCode.maxUses && referralCode.totalUses >= referralCode.maxUses) {
      return res.status(400).json({ message: 'Kod polecający został wyczerpany' });
    }
    
    // Sprawdź czy użytkownik już użył tego kodu
    const alreadyUsed = referralCode.usedBy.some(
      u => u.user.toString() === req.user._id.toString()
    );
    
    if (alreadyUsed) {
      return res.status(400).json({ message: 'Ten kod został już użyty' });
    }
    
    // Sprawdź czy użytkownik nie próbuje użyć własnego kodu
    if (referralCode.referrer.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Nie możesz użyć własnego kodu polecającego' });
    }
    
    // Znajdź plan
    const plan = await SubscriptionPlan.findOne({ key: planKey, active: true });
    if (!plan) {
      return res.status(404).json({ message: 'Plan nie istnieje' });
    }
    
    // Oblicz zniżkę dla zaproszonego (20% zniżki)
    let discountPercent = 0;
    if (referralCode.rewards.refereeReward === '20_percent_discount') {
      discountPercent = 20;
    } else if (referralCode.rewards.refereeReward === 'first_month_free') {
      discountPercent = 100; // Pierwszy miesiąc za darmo
    }
    
    // Oblicz cenę z zniżką
    const basePrice = plan.priceMonthly || 0;
    const discountAmount = Math.round((basePrice * discountPercent / 100) * 100); // w groszach
    const finalPrice = Math.max(0, Math.round(basePrice * 100) - discountAmount);
    
    // Zapisz użycie kodu
    referralCode.usedBy.push({
      user: req.user._id,
      usedAt: new Date(),
      rewardGranted: false
    });
    referralCode.totalUses += 1;
    await referralCode.save();
    
    // Przyznaj nagrodę referrerowi (1 miesiąc STANDARD/PRO za darmo)
    const referrer = await User.findById(referralCode.referrer);
    if (referrer) {
      const rewardPlanKey = referralCode.rewards.referrerReward === '1_month_pro' 
        ? (referrer.role === 'provider' ? 'PROV_PRO' : 'CLIENT_PRO')
        : (referrer.role === 'provider' ? 'PROV_STD' : 'CLIENT_STD');
      
      const rewardPlan = await SubscriptionPlan.findOne({ key: rewardPlanKey, active: true });
      if (rewardPlan) {
        // Sprawdź czy referrer już ma aktywną subskrypcję
        let referrerSub = await UserSubscription.findOne({ user: referrer._id });
        
        if (referrerSub) {
          // Przedłuż istniejącą subskrypcję o 1 miesiąc
          const newValidUntil = new Date(referrerSub.validUntil);
          newValidUntil.setMonth(newValidUntil.getMonth() + 1);
          referrerSub.validUntil = newValidUntil;
          await referrerSub.save();
        } else {
          // Utwórz nową subskrypcję na 1 miesiąc
          const now = new Date();
          const validUntil = new Date(now);
          validUntil.setMonth(validUntil.getMonth() + 1);
          
          referrerSub = await UserSubscription.create({
            user: referrer._id,
            planKey: rewardPlanKey,
            startedAt: now,
            validUntil: validUntil,
            renews: false, // Nie odnawia się automatycznie
            freeExpressLeft: rewardPlan.freeExpressPerMonth || 0
          });
        }
        
        // Oznacz nagrodę jako przyznaną
        const usedEntry = referralCode.usedBy[referralCode.usedBy.length - 1];
        usedEntry.rewardGranted = true;
        await referralCode.save();
      }
    }
    
    res.json({
      success: true,
      discountPercent,
      discountAmount: discountAmount / 100, // w zł
      finalPrice: finalPrice / 100, // w zł
      message: `Otrzymujesz ${discountPercent}% zniżki na pierwszy miesiąc!`
    });
    
  } catch (error) {
    console.error('Error using referral code:', error);
    res.status(500).json({ message: 'Błąd używania kodu polecającego' });
  }
});

// GET /api/referrals/stats - Statystyki kodu polecającego
router.get('/stats', auth, async (req, res) => {
  try {
    const referralCode = await ReferralCode.findOne({ 
      referrer: req.user._id, 
      active: true 
    });
    
    if (!referralCode) {
      return res.json({
        code: null,
        totalUses: 0,
        totalRewards: 0
      });
    }
    
    res.json({
      code: referralCode.code,
      totalUses: referralCode.totalUses,
      usedBy: referralCode.usedBy.length,
      rewardsGranted: referralCode.usedBy.filter(u => u.rewardGranted).length
    });
  } catch (error) {
    console.error('Error getting referral stats:', error);
    res.status(500).json({ message: 'Błąd pobierania statystyk' });
  }
});

// GET /api/referrals/me - Pobierz dane o swoim kodzie polecającym i statystyki
router.get('/me', auth, async (req, res) => {
  try {
    const referralCode = await ReferralCode.findOne({ 
      referrer: req.user._id, 
      active: true 
    });
    
    if (!referralCode) {
      // Generuj nowy kod jeśli nie istnieje
      const code = ReferralCode.generateCode(req.user._id);
      const newCode = await ReferralCode.create({
        code,
        referrer: req.user._id,
        referrerRole: req.user.role,
        rewards: {
          referrerReward: req.user.role === 'provider' ? '1_month_pro' : '1_month_standard',
          refereeReward: '20_percent_discount'
        }
      });
      
      return res.json({
        referralCode: newCode.code,
        shareUrl: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/register?ref=${newCode.code}`,
        stats: {
          totalReferrals: 0,
          pendingReferrals: 0,
          totalRewards: 0,
          clientsReferred: 0,
          providersReferred: 0
        }
      });
    }
    
    // Pobierz statystyki z modelu Referral
    const referrals = await Referral.find({ referrer: req.user._id }).populate('referred', 'name role');
    
    const stats = {
      totalReferrals: referrals.length,
      pendingReferrals: referrals.filter(r => r.status === 'pending').length,
      totalRewards: referrals.reduce((sum, r) => sum + (r.referrerReward?.points || 0), 0),
      clientsReferred: referrals.filter(r => r.referredRole === 'client').length,
      providersReferred: referrals.filter(r => r.referredRole === 'provider').length
    };
    
    res.json({
      referralCode: referralCode.code,
      shareUrl: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/register?ref=${referralCode.code}`,
      stats
    });
  } catch (error) {
    console.error('Error getting referral data:', error);
    res.status(500).json({ message: 'Błąd pobierania danych polecających' });
  }
});

// GET /api/referrals/history - Historia poleceń
router.get('/history', auth, async (req, res) => {
  try {
    const referrals = await Referral.find({ referrer: req.user._id })
      .populate('referred', 'name email role')
      .sort({ createdAt: -1 })
      .limit(100);
    
    res.json({ referrals });
  } catch (error) {
    console.error('Error getting referral history:', error);
    res.status(500).json({ message: 'Błąd pobierania historii poleceń' });
  }
});

module.exports = router;
