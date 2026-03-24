const mongoose = require('mongoose');

const SubscriptionPlanSchema = new mongoose.Schema({
	key: { type: String, unique: true, required: true },
	name: { type: String, required: true },
	priceMonthly: { type: Number, required: true },
	priceYearly: { type: Number }, // Cena roczna z 20% zniżką
	perks: [{ type: String }],

	// Zniżki/opłaty ogólne
	feeDiscountPercent: { type: Number, default: 0 },
	platformFeePercent: { type: Number, default: 10 }, // Platform fee dla tego planu (domyślnie 10%)
	freeExpressPerMonth: { type: Number, default: 0 },
	freeBoostsPerMonth: { type: Number, default: 0 }, // Darmowe boosty ofert/mies dla klientów PRO
	zeroCommission: { type: Boolean, default: false },

	// Parametry specyficzne dla providerów (PROV_*)
	providerOffersLimit: { type: Number, default: 10 }, // ile ofert miesięcznie w pakiecie
	providerTier: {
		type: String,
		enum: ['basic', 'standard', 'pro'],
		default: 'basic'
	},
	
	// Parametry dla pakietów firmowych B2B
	maxUsers: { type: Number, default: null }, // Maksymalna liczba użytkowników (dla BUSINESS_*)
	businessFeatures: [{ type: String }], // Lista funkcji biznesowych: ['reports', 'analytics', 'api_access', 'white_label', etc.]

	active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('SubscriptionPlan', SubscriptionPlanSchema);





























