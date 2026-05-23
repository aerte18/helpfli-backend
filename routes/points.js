const express = require('express');
const router = express.Router();
const PointTransaction = require('../models/PointTransaction');
const User = require('../models/User');
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const {
  formatPointReason,
  pointsRedeemValuePln,
  pointsToPln,
  getUnifiedPointsBalance,
} = require('../utils/userPoints');

router.get('/me', auth, async (req, res) => {
  const balance = await getUnifiedPointsBalance(req.user._id);
  const user = await User.findById(req.user._id).select('loyaltyHistory');
  const txs = await PointTransaction.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const loyaltyEntries = (user?.loyaltyHistory || [])
    .slice()
    .reverse()
    .map((h, i) => ({
      _id: `loyalty-${i}-${h.ts}`,
      delta: h.delta,
      reason: h.reason,
      reasonLabel: formatPointReason(h.reason),
      createdAt: h.ts,
      source: 'loyalty',
    }));

  const ptEntries = txs.map((t) => ({
    _id: t._id,
    delta: t.delta,
    reason: t.reason,
    reasonLabel: formatPointReason(t.reason),
    createdAt: t.createdAt,
    balanceAfter: t.balanceAfter,
    source: 'ledger',
  }));

  const seen = new Set();
  const history = [...ptEntries, ...loyaltyEntries]
    .filter((h) => {
      const key = `${h.reason}-${h.delta}-${new Date(h.createdAt).getTime()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);

  try {
    const { updateUserTier, TIER_BENEFITS } = require('../utils/gamification');
    const tierUpdate = await updateUserTier(req.user._id);
    const tierUser = await User.findById(req.user._id).select('gamification');
    const currentTier = tierUser.gamification?.tier || 'bronze';
    const tierInfo = TIER_BENEFITS[currentTier];

    res.json({
      balance,
      balancePln: pointsToPln(balance),
      redeemValuePln: pointsRedeemValuePln(),
      history,
      tier: {
        current: currentTier,
        ...tierInfo,
      },
      tierUpdate,
    });
  } catch (error) {
    console.error('Error updating tier:', error);
    res.json({
      balance,
      balancePln: pointsToPln(balance),
      redeemValuePln: pointsRedeemValuePln(),
      history,
    });
  }
});

router.post('/redeem', auth, async (req, res) => {
  const { deltaNegative, reason } = req.body || {};
  if (!deltaNegative || deltaNegative >= 0) {
    return res.status(400).json({ message: 'deltaNegative should be negative' });
  }

  const balance = await getUnifiedPointsBalance(req.user._id);
  if (balance + deltaNegative < 0) {
    return res.status(400).json({ message: 'Insufficient points' });
  }

  const { grantUserPoints } = require('../utils/userPoints');
  const tx = await grantUserPoints(req.user._id, deltaNegative, reason || 'manual_redeem');

  try {
    const { checkPointsBadges } = require('../utils/gamification');
    await checkPointsBadges(req.user._id);
  } catch (gamificationError) {
    console.error('Error checking points badges:', gamificationError);
  }

  res.json({ ok: true, tx, balance: tx?.balance });
});

module.exports = router;
