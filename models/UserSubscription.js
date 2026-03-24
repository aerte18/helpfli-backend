const mongoose = require('mongoose');

const UserSubscriptionSchema = new mongoose.Schema({
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
	planKey: { type: String, required: true },
	startedAt: { type: Date, default: Date.now },
	validUntil: { type: Date, required: true },
	renews: { type: Boolean, default: true },
	freeExpressLeft: { type: Number, default: 0 },
	// Limity podbić zleceń (dla klientów)
	freeOrderBoostsLeft: { type: Number, default: 0 }, // Pozostałe darmowe podbicia zleceń w tym miesiącu
	freeOrderBoostsLimit: { type: Number, default: 0 }, // Limit miesięczny (10 dla PRO, 5 dla STANDARD)
	freeOrderBoostsResetDate: { type: Date }, // Data resetu limitów (pierwszy dzień miesiąca)
	// Limity wyróżnień ofert (dla providerów)
	freeOfferBoostsLeft: { type: Number, default: 0 }, // Pozostałe darmowe wyróżnienia ofert w tym miesiącu
	freeOfferBoostsLimit: { type: Number, default: 0 }, // Limit miesięczny (10 dla PRO, 5 dla STANDARD)
	freeOfferBoostsResetDate: { type: Date }, // Data resetu limitów (pierwszy dzień miesiąca)
	// Trial system
	isTrial: { type: Boolean, default: false },
	trialStartedAt: { type: Date },
	trialEndsAt: { type: Date },
	trialConverted: { type: Boolean, default: false }, // Czy trial został przekonwertowany na płatną subskrypcję
	// Early bird / Launch pricing
	earlyAdopter: { type: Boolean, default: false },
	earlyAdopterDiscount: { type: Number, default: 0 }, // Procent zniżki (np. 30)
	// Loyalty rewards
	loyaltyMonths: { type: Number, default: 0 }, // Liczba miesięcy ciągłej subskrypcji
	loyaltyDiscount: { type: Number, default: 0 }, // Procent zniżki z lojalności (np. 5, 10, 15)
	// Referral
	referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
	referralCodeUsed: { type: String, default: null },
	// B2B
	companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
	isBusinessPlan: { type: Boolean, default: false },
	// Resource Pooling - czy używa limitów z puli firmowej
	useCompanyResourcePool: { type: Boolean, default: false },
	// Indywidualne limity (jeśli nie używa puli firmowej lub ma dodatkowe)
	individualLimits: {
		aiQueriesLimit: { type: Number, default: null }, // null = używa z planu, >0 = override
		fastTrackLimit: { type: Number, default: null },
		providerResponsesLimit: { type: Number, default: null }
	},
	// Stripe Subscriptions
	stripeSubscriptionId: { type: String, default: null, index: true }, // Stripe Subscription ID
	stripeCustomerId: { type: String, default: null, index: true }, // Stripe Customer ID
	stripePriceId: { type: String, default: null }, // Stripe Price ID dla tego planu
	// Failed payment retry
	paymentRetryCount: { type: Number, default: 0 }, // Liczba prób ponownej płatności
	lastPaymentAttempt: { type: Date, default: null }, // Data ostatniej próby płatności
	nextRetryAt: { type: Date, default: null }, // Data następnej próby retry
	// Notifications tracking
	notifications: {
		expiry7daysSent: { type: Boolean, default: false },
		expiry7daysSentAt: { type: Date },
		expiry3daysSent: { type: Boolean, default: false },
		expiry3daysSentAt: { type: Date },
		expiry1daySent: { type: Boolean, default: false },
		expiry1daySentAt: { type: Date },
		expiredSent: { type: Boolean, default: false },
		expiredSentAt: { type: Date }
	},
	// Grace period
	gracePeriodUntil: { type: Date, default: null }, // Data do której działa grace period (7 dni po wygaśnięciu)
	// Cancellation
	cancelledAt: { type: Date, default: null },
	cancellationReason: { type: String, default: null },
	cancellationFeedback: { type: String, default: null },
	pausedUntil: { type: Date, default: null }, // Data do której subskrypcja jest wstrzymana
	// Scheduled changes
	scheduledDowngrade: {
		newPlanKey: { type: String, default: null },
		effectiveDate: { type: Date, default: null }
	}
}, { timestamps: true });

// Indexes for performance
UserSubscriptionSchema.index({ user: 1, validUntil: -1 }); // Dla sprawdzania aktywnych subskrypcji
UserSubscriptionSchema.index({ planKey: 1, validUntil: -1 }); // Dla zapytań o plany PRO
UserSubscriptionSchema.index({ validUntil: 1 }); // Dla czyszczenia wygasłych subskrypcji

module.exports = mongoose.model('UserSubscription', UserSubscriptionSchema);





























