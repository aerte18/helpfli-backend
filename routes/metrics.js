const router = require("express").Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const User = require("../models/User");

// Anonimowe wyświetlenie – bez JWT
router.post("/hit", async (req, res) => {
  try {
    const { providerId, field } = req.body; // field: impressions | mapOpens
    if (!["impressions", "mapOpens"].includes(field)) return res.sendStatus(400);
    
    await User.findByIdAndUpdate(providerId, { $inc: { [`metrics.${field}`]: 1 } });
    res.sendStatus(200);
  } catch (err) {
    console.error('METRICS_HIT_ERROR:', err);
    res.sendStatus(500);
  }
});

// Akcje zalogowanych
router.post("/act", authMiddleware, async (req, res) => {
  try {
    const { providerId, field } = req.body; // field: clicks | quoteRequests | chatsStarted | ordersWon
    if (!["clicks", "quoteRequests", "chatsStarted", "ordersWon"].includes(field)) return res.sendStatus(400);
    
    await User.findByIdAndUpdate(providerId, { $inc: { [`metrics.${field}`]: 1 } });
    res.sendStatus(200);
  } catch (err) {
    console.error('METRICS_ACT_ERROR:', err);
    res.sendStatus(500);
  }
});

router.get("/summary", authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const u = await User.findById(userId).select("role metrics");
    if (u.role !== "provider") return res.status(403).json({ message: "Tylko dla usługodawcy" });

    // Prosto: zwracamy tylko bieżące liczniki (na szybko)
    res.json({
      totals: u.metrics || {
        impressions: 0,
        mapOpens: 0,
        clicks: 0,
        quoteRequests: 0,
        chatsStarted: 0,
        ordersWon: 0,
        periodStart: new Date()
      },
    });
  } catch (err) {
    console.error('METRICS_SUMMARY_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania metryk' });
  }
});

module.exports = router;
