const dayjs = require('dayjs');
const UserSubscription = require('../models/UserSubscription');
const Boost = require('../models/Boost');

const MONTH_KEY = () => dayjs().format('YYYY-MM');

async function getActiveSubscription(userId) {
	// UserSubscription w tym repo
	const sub = await UserSubscription.findOne({ user: userId, renews: true });
	// zmapuj na format z limits/priorityBoost jeśli potrzebne
	return sub;
}

async function getActiveBoosts(userId) {
	const now = new Date();
	return await Boost.find({
		user: userId,
		$or: [ { endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } } ],
		startsAt: { $lte: now }
	});
}

function computeBoostScore(boosts) {
	let s = 0;
	for (const b of boosts) {
		if (b.code === 'TOP_24H') s += 20;
		if (b.code === 'TOP_7D') s += 40;
		if (b.code === 'TOP_30D') s += 80;
	}
	return s;
}

async function computeProviderRankScore(user) {
	// w tym repo brak SubscriptionPlan.priorityBoost; można bazować na completedOrders/avgRating + boosts
	const boosts = await getActiveBoosts(user._id);
	const fromBoosts = computeBoostScore(boosts);
	const ratingScore = (user.avgRating || 0) * 10;
	const completedScore = (user.completedOrders || 0) * 0.5;
	return fromBoosts + ratingScore + completedScore;
}

module.exports = {
	MONTH_KEY,
	getActiveSubscription,
	getActiveBoosts,
	computeProviderRankScore
};






