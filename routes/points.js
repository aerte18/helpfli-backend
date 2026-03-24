const express = require('express');
const router = express.Router();
const PointTransaction = require('../models/PointTransaction');
const { authMiddleware: auth } = require('../middleware/authMiddleware');

router.get('/me', auth, async (req, res) => {
	const txs = await PointTransaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100);
	const balance = txs.length ? txs[0].balanceAfter : 0;
	
	// Aktualizuj tier użytkownika
	try {
		const { updateUserTier, TIER_BENEFITS, TIER_THRESHOLDS } = require('../utils/gamification');
		const tierUpdate = await updateUserTier(req.user._id);
		const User = require('../models/User');
		const user = await User.findById(req.user._id).select('gamification');
		const currentTier = user.gamification?.tier || 'bronze';
		const tierInfo = TIER_BENEFITS[currentTier];
		
		res.json({ 
			balance, 
			history: txs,
			tier: {
				current: currentTier,
				...tierInfo
			}
		});
	} catch (error) {
		console.error('Error updating tier:', error);
		res.json({ balance, history: txs });
	}
});

router.post('/redeem', auth, async (req, res) => {
	const { deltaNegative, reason } = req.body || {};
	if (!deltaNegative || deltaNegative >= 0) return res.status(400).json({ message: 'deltaNegative should be negative' });
	const last = await PointTransaction.findOne({ user: req.user._id }).sort({ createdAt: -1 });
	const lastBal = last?.balanceAfter || 0;
	if (lastBal + deltaNegative < 0) return res.status(400).json({ message: 'Insufficient points' });

	const tx = await PointTransaction.create({
		user: req.user._id,
		delta: deltaNegative,
		reason: reason || 'redeem',
		balanceAfter: lastBal + deltaNegative
	});
	
	// Gamification: sprawdź badges po aktualizacji punktów
	try {
		const { checkPointsBadges } = require('../utils/gamification');
		await checkPointsBadges(req.user._id);
	} catch (gamificationError) {
		console.error('Error checking points badges:', gamificationError);
	}
	
	res.json({ ok: true, tx });
});

module.exports = router;





