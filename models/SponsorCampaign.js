const mongoose = require("mongoose");

const SponsorCampaignSchema = new mongoose.Schema({
	provider: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
	service: { type: String, default: "*" },
	locations: [String],
	positions: { type: [Number], default: [2, 7] },
	startAt: { type: Date, required: true },
	endAt: { type: Date, required: true },
	dailyCap: { type: Number, default: 1 },
	isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.SponsorCampaign || mongoose.model("SponsorCampaign", SponsorCampaignSchema);





























