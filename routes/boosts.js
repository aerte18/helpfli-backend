const express = require('express');
const router = express.Router();
const Boost = require('../models/Boost');
const Payment = require('../models/Payment');
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const dayjs = require('dayjs');
const User = require('../models/User');

const BOOSTS = [
	{ code: 'TOP_24H', title: 'Wyróżnienie 24h', pricePLN: 9.99, durationDays: 1 },
	{ code: 'TOP_7D', title: 'TOP 7 dni', pricePLN: 49, durationDays: 7 },
	{ code: 'TOP_30D', title: 'TOP 30 dni', pricePLN: 199, durationDays: 30 },
	{ code: 'FAST_TRACK', title: 'Fast-Track (pojedynczy)', pricePLN: 4.99, durationDays: 0 },
	// Nowe boosty dla większych przychodów
	{ code: 'HIGHLIGHT', title: 'Wyróżnienie (obwódka fioletowa)', pricePLN: 29, durationDays: 7 },
	{ code: 'FEATURED', title: 'Featured (na górze wyników)', pricePLN: 79, durationDays: 7 },
	{ code: 'AI_RECOMMENDED', title: 'Polecane przez AI', pricePLN: 99, durationDays: 30 },
	{ code: 'VERIFIED_BADGE', title: 'Szybka weryfikacja', pricePLN: 49, durationDays: 0 }, // jednorazowo
];

router.get('/options', (_req, res) => {
	res.json({
		boosts: BOOSTS,
		bulkDiscounts: {
			'3': { discountPercent: 10, description: '10% zniżki za 3 boosty' },
			'5': { discountPercent: 20, description: '20% zniżki za 5 boostów' },
			'10': { discountPercent: 30, description: '30% zniżki za 10+ boostów' }
		}
	});
});

// Funkcja do obliczania bulk discount
function calculateBulkDiscount(quantity) {
	if (quantity >= 10) return 30; // 30% zniżki za 10+ boostów
	if (quantity >= 5) return 20;  // 20% zniżki za 5+ boostów
	if (quantity >= 3) return 10;  // 10% zniżki za 3+ boostów
	return 0; // Brak zniżki
}

router.post('/purchase', auth, async (req, res) => {
	const { code, codes, requestInvoice = false } = req.body || {}; // codes - array kodów dla bulk purchase
	
	// Sprawdź subskrypcję użytkownika dla darmowych boostów
	const UserSubscription = require('../models/UserSubscription');
	const subscription = await UserSubscription.findOne({ 
		user: req.user._id, 
		validUntil: { $gt: new Date() } 
	});
	
	// Obsługa pojedynczego boosta (backward compatibility)
	if (code && !codes) {
		const item = BOOSTS.find(b => b.code === code);
		if (!item) return res.status(404).json({ message: 'Boost not found' });

		// Sprawdź czy użytkownik ma darmowe boosty z pakietu (tylko dla boostów ofert, nie profilowych)
		// Boosty profilowe (TOP_*, HIGHLIGHT, FEATURED, AI_RECOMMENDED) zawsze są płatne
		// Boosty ofert (order boosts) mogą być darmowe z pakietu
		const isOrderBoost = ['HIGHLIGHT_OFFER', 'FEATURED_OFFER'].includes(code);
		let useFreeBoost = false;
		let paymentAmount = item.pricePLN;
		
		if (isOrderBoost && subscription && subscription.freeOrderBoostsLeft > 0) {
			// Użyj darmowego boosta z pakietu
			subscription.freeOrderBoostsLeft -= 1;
			await subscription.save();
			useFreeBoost = true;
			paymentAmount = 0; // Darmowe
		}

		// Utwórz płatność tylko jeśli nie użyto darmowego boosta
		let payment = null;
		if (!useFreeBoost && paymentAmount > 0) {
			payment = await Payment.create({
				purpose: 'promotion',
				provider: req.user._id,
				client: req.user._id,
				amount: Math.round(paymentAmount * 100), // w groszach
				currency: 'pln',
				status: 'succeeded',
				requestInvoice: requestInvoice || false,
				metadata: { boostCode: code, type: 'boost_purchase' }
			});
		}

		const startsAt = dayjs();
		const endsAt = item.durationDays > 0 ? startsAt.add(item.durationDays, 'day') : null;

		const boost = await Boost.create({
			user: req.user._id,
			code: item.code,
			title: item.title,
			startsAt: startsAt.toDate(),
			endsAt: endsAt ? endsAt.toDate() : null
		});

		return res.json({ 
			ok: true, 
			paymentId: payment?._id || null, 
			boost,
			usedFreeBoost: useFreeBoost,
			remainingFreeBoosts: subscription?.freeOrderBoostsLeft || 0
		});
	}
	
	// Obsługa bulk purchase (zakup wielu boostów)
	if (codes && Array.isArray(codes) && codes.length > 0) {
		const items = codes.map(code => BOOSTS.find(b => b.code === code)).filter(Boolean);
		
		if (items.length === 0) {
			return res.status(400).json({ message: 'Nie znaleziono żadnych boostów' });
		}
		
		if (items.length !== codes.length) {
			return res.status(400).json({ message: 'Niektóre kody boostów są nieprawidłowe' });
		}
		
		// Sprawdź które boosty mogą być darmowe (tylko boosty ofert)
		const orderBoostCodes = ['HIGHLIGHT_OFFER', 'FEATURED_OFFER'];
		let freeBoostsUsed = 0;
		const availableFreeBoosts = subscription?.freeOrderBoostsLeft || 0;
		
		// Oblicz ile boostów będzie płatnych vs darmowych
		const paidItems = [];
		const freeItems = [];
		
		for (const item of items) {
			const isOrderBoost = orderBoostCodes.includes(item.code);
			if (isOrderBoost && freeBoostsUsed < availableFreeBoosts) {
				freeItems.push(item);
				freeBoostsUsed++;
			} else {
				paidItems.push(item);
			}
		}
		
		// Oblicz bulk discount tylko dla płatnych boostów
		const paidQuantity = paidItems.length;
		const discountPercent = calculateBulkDiscount(paidQuantity);
		
		// Oblicz całkowitą cenę przed zniżką (tylko płatne boosty)
		const totalPriceBeforeDiscount = paidItems.reduce((sum, item) => sum + item.pricePLN, 0);
		
		// Oblicz zniżkę i finalną cenę
		const discountAmount = (totalPriceBeforeDiscount * discountPercent) / 100;
		const totalPriceAfterDiscount = totalPriceBeforeDiscount - discountAmount;
		
		// Zaktualizuj liczbę darmowych boostów jeśli użyto
		if (freeBoostsUsed > 0 && subscription) {
			subscription.freeOrderBoostsLeft = Math.max(0, subscription.freeOrderBoostsLeft - freeBoostsUsed);
			await subscription.save();
		}
		
		// Utwórz płatność tylko jeśli są płatne boosty
		let payment = null;
		if (totalPriceAfterDiscount > 0) {
			payment = await Payment.create({
				purpose: 'promotion',
				provider: req.user._id,
				client: req.user._id,
				amount: Math.round(totalPriceAfterDiscount * 100), // w groszach
				currency: 'pln',
				status: 'succeeded',
				requestInvoice: requestInvoice || false,
				metadata: { 
					boostCodes: codes,
					bulkPurchase: true,
					quantity: items.length,
					paidQuantity: paidQuantity,
					freeQuantity: freeBoostsUsed,
					discountPercent: discountPercent,
					discountAmount: discountAmount,
					totalBeforeDiscount: totalPriceBeforeDiscount,
					type: 'boost_purchase'
				}
			});
		}
		
		// Utwórz boosty (zarówno płatne jak i darmowe)
		const startsAt = dayjs();
		const createdBoosts = [];
		
		for (const item of items) {
			const endsAt = item.durationDays > 0 ? startsAt.add(item.durationDays, 'day') : null;
			const boost = await Boost.create({
				user: req.user._id,
				code: item.code,
				title: item.title,
				startsAt: startsAt.toDate(),
				endsAt: endsAt ? endsAt.toDate() : null
			});
			createdBoosts.push(boost);
		}
		
		return res.json({ 
			ok: true, 
			paymentId: payment?._id || null, 
			boosts: createdBoosts,
			usedFreeBoosts: freeBoostsUsed,
			remainingFreeBoosts: subscription?.freeOrderBoostsLeft || 0,
			bulkDiscount: paidQuantity > 0 ? {
				quantity: items.length,
				paidQuantity: paidQuantity,
				freeQuantity: freeBoostsUsed,
				discountPercent: discountPercent,
				discountAmount: discountAmount.toFixed(2),
				totalBeforeDiscount: totalPriceBeforeDiscount.toFixed(2),
				totalAfterDiscount: totalPriceAfterDiscount.toFixed(2)
			} : null
		});
	}
	
	return res.status(400).json({ message: 'Podaj code lub codes (array)' });
});

module.exports = router;





