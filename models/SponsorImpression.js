const mongoose = require("mongoose");

const SponsorImpressionSchema = new mongoose.Schema({
	// Dla starych kampanii (backward compatibility)
	campaign: { type: mongoose.Schema.Types.ObjectId, ref: "SponsorCampaign" },
	provider: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
	
	// Dla nowych reklam kontekstowych
	ad: { type: mongoose.Schema.Types.ObjectId, ref: "SponsorAd" },
	
	user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
	date: { type: String, required: true }, // YYYY-MM-DD
	count: { type: Number, default: 0 },
	
	// Typ interakcji
	type: {
		type: String,
		enum: ['impression', 'click', 'conversion'],
		default: 'impression'
	},
	
	// Konwersja - szczegóły
	conversion: {
		type: { type: String, enum: ['purchase', 'inquiry', 'signup', 'download', 'other'] }, // Typ konwersji
		value: Number, // Wartość konwersji (np. wartość zakupu w groszach)
		currency: { type: String, default: 'pln' },
		metadata: mongoose.Schema.Types.Mixed // Dodatkowe dane (np. ID zamówienia, produkt)
	},
	
	// Kontekst wyświetlenia
	context: {
		keywords: [{ type: String }],
		serviceCategory: String,
		orderType: String,
		location: {
			city: String,
			lat: Number,
			lon: Number
		}
	},
	
	// A/B Testing - który wariant został wyświetlony/kliknięty
	abTestVariant: { type: String, enum: ['A', 'B', 'C'] },
	
	// Retargeting - czy użytkownik widział już tę reklamę
	isRetargeting: { type: Boolean, default: false },
	previousImpressionDate: Date // Data poprzedniego wyświetlenia
}, { timestamps: true });

SponsorImpressionSchema.index({ campaign: 1, user: 1, date: 1 });
SponsorImpressionSchema.index({ ad: 1, user: 1, date: 1 });
SponsorImpressionSchema.index({ ad: 1, type: 1, createdAt: -1 });

module.exports = mongoose.models.SponsorImpression || mongoose.model("SponsorImpression", SponsorImpressionSchema);





























