const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const User = require("../models/User");

router.post("/autorenew/cancel", authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ message: "Stripe nie jest skonfigurowane" });
    }
    
    const me = await User.findById(req.user._id);
    if (me.role !== "provider") return res.status(403).json({ message: "Tylko dla usługodawcy" });
    if (!me.promo.subscriptionId) return res.status(400).json({ message: "Brak aktywnej subskrypcji" });

    await stripe.subscriptions.update(me.promo.subscriptionId, { cancel_at_period_end: true });
    me.promo.autoRenew = false;
    await me.save();
    
    res.json({ ok: true, message: "Auto-odnawianie wyłączone – subskrypcja wygaśnie na koniec okresu." });
  } catch (err) {
    console.error('AUTORENEW_CANCEL_ERROR:', err);
    res.status(500).json({ message: 'Błąd anulowania auto-odnawiania' });
  }
});

module.exports = router;
