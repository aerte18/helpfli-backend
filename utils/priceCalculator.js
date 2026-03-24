const pricingCfg = require('../config/pricing');

function applySubscriptionFeeDiscount(platformFee, subscription) {
	if (!subscription) return platformFee;
	if (subscription.zeroCommission) return 0;
	const discount = (platformFee * (subscription.feeDiscountPercent || 0)) / 100;
	return Math.max(0, platformFee - discount);
}

function calcExtrasCost(baseAmount, extras, subscription) {
	let cost = 0;
	if (extras?.express) {
		if (subscription && subscription.freeExpressLeft > 0) {
			// free express from plan
		} else {
			cost += pricingCfg.extras.express;
		}
	}
	if (extras?.premiumProvider) cost += pricingCfg.extras.premiumProvider;
	if (extras?.guarantee) cost += (baseAmount * pricingCfg.extras.guaranteePercent) / 100;
	return cost;
}

function applyPromo(baseAmount, extrasCost, platformFee, promo) {
	if (!promo) return { discountPromo: 0 };
	const subtotal = baseAmount + extrasCost + platformFee;
	let discount = 0;
	if (promo.discountPercent) discount += (subtotal * promo.discountPercent) / 100;
	if (promo.discountFlat) discount += promo.discountFlat;
	return { discountPromo: Math.min(discount, subtotal) };
}

function applyTier(subtotalAfterPromo, userTier) {
	if (!userTier || !userTier.discount || userTier.discount <= 0) return { discountTier: 0 };
	const discountTier = (subtotalAfterPromo * userTier.discount) / 100;
	return { discountTier };
}

function applyPoints(subtotalAfterTier, pointsToUse, userPoints, baseAmount) {
	if (!pointsToUse || pointsToUse <= 0) return { discountPoints: 0, pointsUsed: 0 };
	const usable = Math.min(userPoints, pointsToUse);
	const value = usable * pricingCfg.points.redeemValue;
	
	// Ograniczenie: maksymalna zniżka z punktów to 20% wartości bazowej usługi (baseAmount)
	// To chroni platformę przed zbyt dużymi kosztami marketingowymi
	const maxDiscountFromPoints = baseAmount * 0.20;
	const discountPoints = Math.min(value, subtotalAfterTier, maxDiscountFromPoints);
	const pointsUsed = Math.floor(discountPoints / pricingCfg.points.redeemValue);
	
	return { discountPoints, pointsUsed };
}

function calcTotal({ baseAmount, extras, subscription, promo, pointsToUse, userPoints, userTier }) {
	const extrasCost = calcExtrasCost(baseAmount, extras, subscription);
	
	// Użyj platformFeePercent z planu subskrypcji jeśli dostępny, w przeciwnym razie domyślne 10%
	// FREE plan ma 15%, STANDARD 8%, PRO 5%
	const platformFeePercent = subscription?.platformFeePercent || pricingCfg.platformFeePercent;
	
	// WAŻNE: PlatformFee obliczane od kwoty bazowej PRZED zniżkami z punktów
	// To zapewnia, że provider otrzymuje pełną kwotę (baseAmount + extrasCost - platformFee)
	// Zniżka z punktów jest pokrywana przez platformę jako koszt marketingowy
	const platformFeeRaw = (baseAmount * (platformFeePercent / 100));
	const platformFee = applySubscriptionFeeDiscount(platformFeeRaw, subscription);
	
	const { discountPromo } = applyPromo(baseAmount, extrasCost, platformFee, promo);
	const subtotalAfterPromo = Math.max(0, baseAmount + extrasCost + platformFee - discountPromo);
	const { discountTier } = applyTier(subtotalAfterPromo, userTier);
	const subtotalAfterTier = Math.max(0, subtotalAfterPromo - discountTier);
	
	// Zastosuj zniżki z punktów (pokrywane przez platformę)
	const { discountPoints, pointsUsed } = applyPoints(subtotalAfterTier, pointsToUse, userPoints, baseAmount);
	
	// Oblicz finalną kwotę: klient płaci mniej dzięki zniżce z punktów
	// Provider otrzymuje: baseAmount + extrasCost - platformFee (pełna kwota)
	// Platforma pokrywa zniżkę z punktów jako koszt marketingowy
	const total = Math.max(0, subtotalAfterTier - discountPoints);
	
	// Oryginalna kwota przed zniżką z punktów (używana do obliczenia platformFee dla providera)
	const originalTotal = subtotalAfterTier;
	
	return { 
		extrasCost, 
		platformFee, // PlatformFee obliczane od baseAmount (przed zniżkami z punktów)
		platformFeePercent, 
		discountPromo, 
		discountTier, 
		discountPoints, // Zniżka z punktów - pokrywana przez platformę jako koszt marketingowy
		pointsUsed, 
		total, // Kwota którą płaci klient (po zniżkach)
		originalTotal // Kwota przed zniżką z punktów (dla rozliczeń z providerem)
	};
}

module.exports = { calcTotal };





























