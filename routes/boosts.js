const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const Payment = require('../models/Payment');
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const { paymentIntentStatusForPaymentModel } = require('../utils/paymentIntentStatusForPaymentModel');
const {
	BOOSTS,
	BOOST_BY_CODE,
	calculateBulkDiscount,
	activateBoostItems,
} = require('../services/boostPurchaseService');

const CURRENCY = process.env.CURRENCY || 'pln';

router.get('/options', (_req, res) => {
	res.json({
		boosts: BOOSTS,
		bulkDiscounts: {
			'3': { discountPercent: 10, description: '10% zniżki za 3 boosty' },
			'5': { discountPercent: 20, description: '20% zniżki za 5 boostów' },
			'10': { discountPercent: 30, description: '30% zniżki za 10+ boostów' },
		},
	});
});

async function applyFreeBoostFromSubscription(subscription, code) {
	const orderBoostCodes = ['HIGHLIGHT_OFFER', 'FEATURED_OFFER'];
	if (!orderBoostCodes.includes(code) || !subscription || subscription.freeOrderBoostsLeft <= 0) {
		return { used: false, subscription };
	}
	subscription.freeOrderBoostsLeft -= 1;
	await subscription.save();
	return { used: true, subscription };
}

async function createBoostPaymentIntent({ userId, userName, codes, amountPln, requestInvoice, bulkMeta = {} }) {
	if (!stripe) {
		throw Object.assign(new Error('Płatności Stripe niedostępne'), { status: 503 });
	}
	const amountGrosze = Math.max(0, Math.round(amountPln * 100));
	if (amountGrosze <= 0) {
		throw Object.assign(new Error('Kwota płatności musi być większa od zera'), { status: 400 });
	}

	const intent = await stripe.paymentIntents.create({
		amount: amountGrosze,
		currency: CURRENCY,
		payment_method_types: ['card', 'p24', 'blik'],
		description: `Helpfli Boost: ${codes.join(', ')}`,
		metadata: {
			type: 'boost_purchase',
			userId: String(userId),
			boostCodes: codes.join(','),
			boostCode: codes.length === 1 ? codes[0] : '',
			...bulkMeta,
		},
		statement_descriptor_suffix: 'HELPFLI BOOST',
	});

	const payment = await Payment.create({
		purpose: 'promotion',
		provider: userId,
		client: userId,
		providerName: userName,
		clientName: userName,
		stripePaymentIntentId: intent.id,
		amount: amountGrosze,
		currency: CURRENCY,
		method: 'unknown',
		status: paymentIntentStatusForPaymentModel(intent.status),
		requestInvoice: !!requestInvoice,
		metadata: intent.metadata,
	});

	return { clientSecret: intent.client_secret, paymentIntentId: intent.id, paymentId: payment._id };
}

router.post('/purchase', auth, async (req, res) => {
	try {
		const { code, codes, requestInvoice = false } = req.body || {};
		const { isPlatformInvoicingEnabled } = require('../utils/platformInvoicing');
		const wantsInvoice = isPlatformInvoicingEnabled() && !!requestInvoice;

		const UserSubscription = require('../models/UserSubscription');
		const subscription = await UserSubscription.findOne({
			user: req.user._id,
			validUntil: { $gt: new Date() },
		});

		if (code && !codes) {
			const item = BOOST_BY_CODE[code];
			if (!item) return res.status(404).json({ message: 'Boost not found' });

			const free = await applyFreeBoostFromSubscription(subscription, code);
			if (free.used) {
				const [boost] = await activateBoostItems(req.user._id, [code]);
				return res.json({
					ok: true,
					boost,
					usedFreeBoost: true,
					remainingFreeBoosts: free.subscription?.freeOrderBoostsLeft || 0,
				});
			}

			const paymentInfo = await createBoostPaymentIntent({
				userId: req.user._id,
				userName: req.user.name,
				codes: [code],
				amountPln: item.pricePLN,
				requestInvoice: wantsInvoice,
			});

			return res.json({
				ok: true,
				requiresPayment: true,
				...paymentInfo,
			});
		}

		if (codes && Array.isArray(codes) && codes.length > 0) {
			const items = codes.map((c) => BOOST_BY_CODE[c]).filter(Boolean);
			if (items.length === 0) return res.status(400).json({ message: 'Nie znaleziono żadnych boostów' });
			if (items.length !== codes.length) {
				return res.status(400).json({ message: 'Niektóre kody boostów są nieprawidłowe' });
			}

			const orderBoostCodes = ['HIGHLIGHT_OFFER', 'FEATURED_OFFER'];
			let freeBoostsUsed = 0;
			const availableFreeBoosts = subscription?.freeOrderBoostsLeft || 0;
			const paidCodes = [];
			const freeCodes = [];

			for (const item of items) {
				if (orderBoostCodes.includes(item.code) && freeBoostsUsed < availableFreeBoosts) {
					freeCodes.push(item.code);
					freeBoostsUsed++;
				} else {
					paidCodes.push(item.code);
				}
			}

			if (freeBoostsUsed > 0 && subscription) {
				subscription.freeOrderBoostsLeft = Math.max(0, subscription.freeOrderBoostsLeft - freeBoostsUsed);
				await subscription.save();
			}

			let freeBoosts = [];
			if (freeCodes.length) {
				freeBoosts = await activateBoostItems(req.user._id, freeCodes);
			}

			if (paidCodes.length === 0) {
				return res.json({
					ok: true,
					boosts: freeBoosts,
					usedFreeBoosts: freeBoostsUsed,
					remainingFreeBoosts: subscription?.freeOrderBoostsLeft || 0,
				});
			}

			const discountPercent = calculateBulkDiscount(paidCodes.length);
			const totalBefore = paidCodes.reduce((sum, c) => sum + BOOST_BY_CODE[c].pricePLN, 0);
			const totalAfter = totalBefore - (totalBefore * discountPercent) / 100;

			const paymentInfo = await createBoostPaymentIntent({
				userId: req.user._id,
				userName: req.user.name,
				codes: paidCodes,
				amountPln: totalAfter,
				requestInvoice: wantsInvoice,
				bulkMeta: {
					bulkPurchase: 'true',
					discountPercent: String(discountPercent),
				},
			});

			return res.json({
				ok: true,
				requiresPayment: true,
				pendingFreeBoosts: freeBoosts,
				usedFreeBoosts: freeBoostsUsed,
				remainingFreeBoosts: subscription?.freeOrderBoostsLeft || 0,
				bulkDiscount: {
					discountPercent,
					totalBeforeDiscount: totalBefore.toFixed(2),
					totalAfterDiscount: totalAfter.toFixed(2),
				},
				...paymentInfo,
			});
		}

		return res.status(400).json({ message: 'Podaj code lub codes (array)' });
	} catch (err) {
		console.error('[boosts] purchase error:', err);
		res.status(err.status || 500).json({ message: err.message || 'Błąd zakupu boosta' });
	}
});

module.exports = router;
