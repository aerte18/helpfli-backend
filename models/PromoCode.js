const mongoose = require('mongoose');

const PromoCodeSchema = new mongoose.Schema({
	code: { type: String, required: true, unique: true, uppercase: true, trim: true },
	discountPercent: { type: Number, min: 0, max: 100, default: 0 },
	discountFlat: { type: Number, min: 0, default: 0 },
	maxRedemptions: { type: Number, default: 0 },
	redemptions: { type: Number, default: 0 },
	minOrderValue: { type: Number, default: 0 },
	validFrom: { type: Date, default: Date.now },
	validTo: { type: Date },
	firstOrderOnly: { type: Boolean, default: false },
	allowedServices: [{ type: String }],
	active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('PromoCode', PromoCodeSchema);





























