const Usage = require('../models/Usage');
const { MONTH_KEY, getActiveSubscription } = require('../utils/billingUtils');
const User = require('../models/User');
const { canUseCompanyResource, consumeCompanyResource } = require('../utils/resourcePool');

exports.ensureClientCanFastTrack = async (req, res, next) => {
	try {
		const sub = await getActiveSubscription(req.user._id);
		const limit = sub?.limits?.fastTrackMonthly ?? 0; // brak limits w naszym sub – zostaw 0 aby wymusić plan
		if (limit === 0) return res.status(403).json({ message: 'Plan nie obejmuje Fast-Track.' });
		if (limit < 0 || limit >= 9999) return next();
		const monthKey = MONTH_KEY();
		const usage = await Usage.findOne({ user: req.user._id, monthKey }) || { fastTrackUsed: 0 };
		if (usage.fastTrackUsed >= limit) return res.status(403).json({ message: 'Limit Fast-Track wyczerpany.' });
		req.__usageMonthKey = monthKey;
		return next();
	} catch (e) {
		console.error(e);
		return res.status(500).json({ message: 'Błąd weryfikacji Fast-Track.' });
	}
};

exports.consumeClientFastTrack = async (req, _res, next) => {
	if (!req.__usageMonthKey) return next();
	await Usage.updateOne(
		{ user: req.user._id, monthKey: req.__usageMonthKey },
		{ $inc: { fastTrackUsed: 1 } },
		{ upsert: true }
	);
	return next();
};

exports.ensureProviderCanRespond = async (req, res, next) => {
	try {
		const sub = await getActiveSubscription(req.user._id);
		const limit = sub?.limits?.responsesPerMonth ?? 0;
		if (limit === 0) return res.status(403).json({ message: 'Plan nie pozwala odpowiadać na zlecenia.' });
		if (limit < 0) return next();
		const monthKey = MONTH_KEY();
		const usage = await Usage.findOne({ user: req.user._id, monthKey }) || { responsesUsed: 0 };
		if (usage.responsesUsed >= limit) return res.status(403).json({ message: 'Limit odpowiedzi wyczerpany.' });
		req.__usageMonthKey_provider = monthKey;
		return next();
	} catch (e) {
		console.error(e);
		return res.status(500).json({ message: 'Błąd weryfikacji limitu odpowiedzi.' });
	}
};

exports.consumeProviderResponse = async (req, _res, next) => {
	if (!req.__usageMonthKey_provider) return next();
	await Usage.updateOne(
		{ user: req.user._id, monthKey: req.__usageMonthKey_provider },
		{ $inc: { responsesUsed: 1 } },
		{ upsert: true }
	);
	return next();
};






