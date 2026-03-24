?const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const Coupon = require("../models/Coupon");

// One-time kwoty (grosze)
const PRICE_TABLE = {
  highlight_24h: { name: "Wyróżnienie 24h",  amount: 1000 },  // 10.00 PLN
  top_7d:        { name: "TOP 7 dni",        amount: 4900 },  // 49.00 PLN
  top_14d:       { name: "TOP 14 dni",       amount: 9900 },  // 99.00 PLN
  top_31d:       { name: "TOP 31 dni",       amount: 19900 }, // 199.00 PLN
};

// Subskrypcyjne Price IDs (z .env)
const SUB_PRICE = {
  highlight_24h: process.env.PRICE_SUB_HIGHLIGHT_1D,
  top_7d:        process.env.PRICE_SUB_TOP_7D,
  top_14d:       process.env.PRICE_SUB_TOP_14D,
  top_31d:       process.env.PRICE_SUB_TOP_31D,
};

router.post("/checkout", authMiddleware, async (req, res) => {
  try {
    
    const { productKey, autoRenew, promoCode } = req.body;
    const p = PRICE_TABLE[productKey];
    if (!p) return res.status(400).json({ message: "Nieznany pakiet" });

    // SUB: jeśli autoRenew = true, użyj priceId i mode=subscription
    let session;
    if (autoRenew) {
      // DEV FALLBACK: brak Stripe → ustaw autoRenew w bazie i aktywuj pakiet
      if (!stripe) {
        const User = require("../models/User");
        await require("./promo").activatePromo(req.user._id, productKey);
        await User.findByIdAndUpdate(req.user._id, {
          $set: {
            "promo.autoRenew": true,
            "promo.subscriptionId": "dev-demo",
            "promo.subscriptionProductKey": productKey
          }
        });
        return res.json({ url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/promote?paid=1` });
      }
      const priceId = SUB_PRICE[productKey];
      if (!priceId) return res.status(500).json({ message: "Brak ID ceny subskrypcyjnej dla pakietu." });
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/promote?paid=1`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/promote?canceled=1`,
        allow_promotion_codes: true, // wbudowane pole do wpisania kodu
        metadata: { userId: req.user._id.toString(), productKey, autoRenew: "true" },
      });
    } else {
      // Jednorazowo (+ własny kupon Helpfli)
      if (!stripe) {
        // DEV FALLBACK dla jednorazówki – aktywuj pakiet bez płatności
        await require("./promo").activatePromo(req.user._id, productKey);
        return res.json({ url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/promote?paid=1` });
      }
      let amount = p.amount;
      let appliedCouponId = null;
      if (promoCode) {
        const now = new Date();
        const c = await Coupon.findOne({ code: promoCode.toUpperCase(), active: true });
        const okDate = c && (!c.validFrom || c.validFrom <= now) && (!c.validTo || c.validTo >= now);
        const okProd = c && (!c.products?.length || c.products.includes(productKey));
        const okUses = c && (!c.maxUses || c.used < c.maxUses);
        if (c && okDate && okProd && okUses) {
          if (c.type === "percent") amount = Math.max(0, Math.round(amount * (100 - c.value) / 100));
          if (c.type === "amount")  amount = Math.max(0, amount - c.value);
          appliedCouponId = c._id;
        }
      }
      const opts = {
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "pln",
            product_data: { name: p.name },
            unit_amount: amount,
          },
          quantity: 1,
        }],
        success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/promote?paid=1`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/provider/promote?canceled=1`,
        allow_promotion_codes: true,
        metadata: { userId: req.user._id.toString(), productKey, autoRenew: "false", appliedCouponId: appliedCouponId || "" },
      };
      session = await stripe.checkout.sessions.create(opts);
    }
    
    res.json({ url: session.url });
  } catch (err) {
    console.error('STRIPE_CHECKOUT_ERROR:', err);
    res.status(500).json({ message: 'Błąd tworzenia sesji płatności' });
  }
});

module.exports = router;
