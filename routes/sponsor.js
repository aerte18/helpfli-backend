const router = require("express").Router();
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const SponsorCampaign = require("../models/SponsorCampaign");

router.get("/sponsor/me", auth, async (req, res) => {
	try {
		if (req.user.role !== "provider") return res.status(403).json({ message: "Tylko usługodawca" });
		const list = await SponsorCampaign.find({ provider: req.user._id }).sort({ startAt: -1 });
		res.json(list);
	} catch (e) {
		console.error("SPONSOR_ME_ERROR", e);
		res.status(500).json({ message: "Błąd pobierania kampanii" });
	}
});

router.post("/sponsor/create", auth, async (req, res) => {
	try {
		if (req.user.role !== "provider") return res.status(403).json({ message: "Tylko usługodawca" });
		const { service = "*", positions = [2, 7], startAt, endAt, dailyCap = 1 } = req.body || {};
		const camp = await SponsorCampaign.create({ provider: req.user._id, service, positions, startAt, endAt, dailyCap, isActive: true });
		res.json(camp);
	} catch (e) {
		console.error("SPONSOR_CREATE_ERROR", e);
		res.status(500).json({ message: "Błąd tworzenia kampanii" });
	}
});

module.exports = router;






