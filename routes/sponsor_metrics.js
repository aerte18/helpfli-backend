const router = require("express").Router();
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const { trackImpression } = require("../utils/sponsor");

router.post("/sponsor/imp", auth, async (req, res) => {
	const { campaignId, providerId } = req.body || {};
	try {
		await trackImpression({ campaignId, providerId, userId: req.user._id });
		res.sendStatus(200);
	} catch (e) {
		console.error("sponsor imp", e);
		res.sendStatus(200);
	}
});

module.exports = router;






