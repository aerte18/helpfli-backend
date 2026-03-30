const SponsorCampaign = require("../models/SponsorCampaign");
const SponsorImpression = require("../models/SponsorImpression");

function ymd(d = new Date()) {
	return d.toISOString().slice(0, 10);
}

exports.fetchActiveCampaigns = async ({ service, city }) => {
	const now = new Date();
	const q = {
		isActive: true,
		startAt: { $lte: now },
		endAt: { $gte: now },
		$or: [{ service: "*" }, { service }],
	};
	if (city) q.$or = [...q.$or, { locations: { $size: 0 } }, { locations: city }];
	return await SponsorCampaign.find(q).populate("provider").lean();
};

exports.capForUser = async ({ campaigns, userId }) => {
	const today = ymd();
	const capped = [];
	for (const c of campaigns) {
		if (!userId) {
			capped.push(c);
			continue;
		}
		const doc = await SponsorImpression.findOne({ campaign: c._id, user: userId, date: today });
		if (!doc || doc.count < (c.dailyCap || 1)) capped.push(c);
	}
	return capped;
};

exports.injectSponsored = ({ list, campaigns }) => {
	const byPos = {};
	for (const c of campaigns) {
		for (const pos of c.positions || []) {
			if (!byPos[pos]) byPos[pos] = c;
		}
	}
	const out = [...list];
	Object.entries(byPos).forEach(([p, camp]) => {
		if (!camp.provider || !camp.provider._id) return;
		const idx = Math.max(0, Math.min(out.length, Number(p) - 1));
		const without = out.filter((x) => String(x._id) !== String(camp.provider._id));
		const item = { ...camp.provider, _sponsored: true, _campaignId: camp._id };
		without.splice(idx, 0, item);
		out.splice(0, out.length, ...without);
	});
	return out;
};

exports.trackImpression = async ({ campaignId, providerId, userId }) => {
	if (!campaignId || !userId) return;
	const today = ymd();
	await SponsorImpression.updateOne(
		{ campaign: campaignId, provider: providerId, user: userId, date: today },
		{ $inc: { count: 1 } },
		{ upsert: true }
	);
};







