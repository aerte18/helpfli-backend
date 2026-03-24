const router = require("express").Router();
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PRICE_PER_DAY = { 2: 3000, 7: 2000 };

function daysBetween(start, end) {
	const s = new Date(start), e = new Date(end);
	const ms = Math.max(0, e.setHours(0, 0, 0, 0) - s.setHours(0, 0, 0, 0));
	return Math.floor(ms / 86400000) + 1;
}

router.post("/sponsor/checkout", auth, async (req, res) => {
	try {
		if (req.user.role !== "provider") return res.status(403).json({ message: "Tylko usługodawca" });
		const { service = "*", positions = [], startAt, endAt } = req.body || {};
		if (!positions.length) return res.status(400).json({ message: "Wybierz sloty (2/7)" });
		if (!startAt || !endAt) return res.status(400).json({ message: "Podaj zakres dat" });
		const days = daysBetween(startAt, endAt);
		if (days < 1 || days > 62) return res.status(400).json({ message: "Dozwolone 1–62 dni" });
		let amount = 0;
		for (const p of positions) {
			if (!PRICE_PER_DAY[p]) return res.status(400).json({ message: `Nieobsługiwana pozycja #${p}` });
			amount += PRICE_PER_DAY[p] * days;
		}

		const label = `Kampania sponsorowana (${positions.map((p) => `#${p}`).join("+")}) – ${days} dni`;

		if (!stripe) {
			// DEV fallback bez Stripe – po sukcesie frontend wejdzie z ?paid=1 i osobny endpoint create może utworzyć kampanię
			return res.json({ url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/sponsored?paid=1`, amount });
		}

		const session = await stripe.checkout.sessions.create({
			mode: "payment",
			line_items: [
				{
					price_data: { currency: "pln", product_data: { name: label }, unit_amount: amount },
					quantity: 1,
				},
			],
			success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/sponsored?paid=1`,
			cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/sponsored?canceled=1`,
			allow_promotion_codes: true,
			metadata: {
				kind: "sponsor",
				userId: req.user._id.toString(),
				service,
				positions: positions.join(","),
				startAt,
				endAt,
			},
		});

		res.json({ url: session.url, amount });
	} catch (e) {
		console.error("SPONSOR_CHECKOUT_ERROR", e);
		res.status(500).json({ message: "Błąd inicjowania płatności" });
	}
});

module.exports = router;






