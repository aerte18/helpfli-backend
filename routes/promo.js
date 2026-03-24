const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const User = require("../models/User");
const { isActive } = require("../utils/promo");

// Helper functions
function addDays(from, n) { 
  const d = new Date(from || Date.now()); 
  d.setDate(d.getDate() + n); 
  return d; 
}

async function activatePromo(userId, productKey) {
  const p = PRICES[productKey];
  if (!p) throw new Error("Nieznany pakiet");
  const me = await User.findById(userId);
  if (!me) throw new Error("User not found");

  // ustaw efekty
  if (p.highlight) me.promo.highlightUntil = addDays(me.promo?.highlightUntil, p.days);
  if (p.top) me.promo.topBadgeUntil = addDays(me.promo?.topBadgeUntil, p.days);

  // „AI poleca": dla top_14d – 7 dni, dla top_31d – 31 dni, dla top_7d brak
  if (productKey === "top_14d") me.promo.aiTopTagUntil = addDays(me.promo?.aiTopTagUntil, 7);
  if (productKey === "top_31d") me.promo.aiTopTagUntil = addDays(me.promo?.aiTopTagUntil, 31);

  // punkty do rankingu na czas trwania pakietu
  me.promo.rankBoostPoints = Math.max(me.promo.rankBoostPoints || 0, p.rank);
  me.promo.rankBoostUntil = addDays(me.promo?.rankBoostUntil, p.days);
  
  // snapshot metryk "na starcie" do obliczeń ROI
  if (!me.promo.metricsAtStart || new Date(me.promo.rankBoostUntil || 0) < new Date()) {
    me.promo.metricsAtStart = {
      impressions: me.metrics?.impressions || 0,
      clicks: me.metrics?.clicks || 0,
      quoteRequests: me.metrics?.quoteRequests || 0,
      chatsStarted: me.metrics?.chatsStarted || 0,
      ordersWon: me.metrics?.ordersWon || 0,
      at: new Date()
    };
  }
  
  await me.save();
  return me.promo;
}

// CENNIK v2 - Pakiety promocji
const PRICES = {
  // Cena, czas i efekty
  highlight_24h: { label: "Wyróżnienie 24h", price: 10,  days: 1,  rank: 20, highlight: true },
  top_7d:        { label: "TOP 7 dni",       price: 49,  days: 7,  rank: 40, highlight: true, top: true },
  top_14d:       { label: "TOP 14 dni",      price: 99,  days: 14, rank: 60, highlight: true, top: true, ai: true },
  top_31d:       { label: "TOP 31 dni",      price: 199, days: 31, rank: 100, highlight: true, top: true, ai: true },
};

// GET status + cennik
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select("role promo metrics name");
    if (me.role !== "provider") return res.status(403).json({ message: "Tylko dla usługodawcy" });
    
    res.json({
      promo: {
        highlightUntil: me.promo?.highlightUntil,
        topBadgeUntil: me.promo?.topBadgeUntil,
        pinBoostUntil: me.promo?.pinBoostUntil,
        aiTopTagUntil: me.promo?.aiTopTagUntil,
        rankBoostUntil: me.promo?.rankBoostUntil,
        rankBoostPoints: me.promo?.rankBoostPoints,
        autoRenew: me.promo?.autoRenew,
        subscriptionId: me.promo?.subscriptionId,
        subscriptionProductKey: me.promo?.subscriptionProductKey,
        metricsAtStart: me.promo?.metricsAtStart,
        active: {
          highlight: isActive(me.promo?.highlightUntil),
          top: isActive(me.promo?.topBadgeUntil),
          pin: isActive(me.promo?.pinBoostUntil),
          ai: isActive(me.promo?.aiTopTagUntil),
          rank: isActive(me.promo?.rankBoostUntil),
        }
      },
      prices: PRICES,
      metrics: me.metrics,
    });
  } catch (err) {
    console.error('GET_PROMO_ME_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania danych' });
  }
});

// POST zakup/aktywacja (płatności możesz podpiąć później; na razie „mock success")
router.post("/purchase", authMiddleware, async (req, res) => {
  try {
    const { productKey } = req.body; // np. "top_7d"
    const me = await User.findById(req.user._id);
    if (me.role !== "provider") return res.status(403).json({ message: "Tylko dla usługodawcy" });
    
    const p = PRICES[productKey];
    if (!p) return res.status(400).json({ message: "Nieznany pakiet" });

    const addDays = (d, n) => { 
      const x = new Date(d || Date.now()); 
      x.setDate(x.getDate() + n); 
      return x; 
    };

    // ustaw efekty
    if (p.highlight) me.promo.highlightUntil = addDays(me.promo?.highlightUntil, p.days);
    if (p.top) me.promo.topBadgeUntil = addDays(me.promo?.topBadgeUntil, p.days);

    // „AI poleca": dla top_14d – 7 dni, dla top_31d – 31 dni, dla top_7d brak
    if (productKey === "top_14d") me.promo.aiTopTagUntil = addDays(me.promo?.aiTopTagUntil, 7);
    if (productKey === "top_31d") me.promo.aiTopTagUntil = addDays(me.promo?.aiTopTagUntil, 31);

    // punkty do rankingu na czas trwania pakietu
    me.promo.rankBoostPoints = Math.max(me.promo.rankBoostPoints || 0, p.rank);
    me.promo.rankBoostUntil = addDays(me.promo?.rankBoostUntil, p.days);
    
    await me.save();
    res.json({ ok: true, charged: p.price, untils: me.promo });
  } catch (err) {
    console.error('PURCHASE_ERROR:', err);
    res.status(500).json({ message: 'Błąd zakupu' });
  }
});

// (opcjonalnie) reset okresu metryk, np. co miesiąc
router.post("/metrics/reset", authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.user._id);
    if (me.role !== "provider") return res.status(403).json({ message: "Tylko dla usługodawcy" });
    
    me.metrics = { 
      impressions: 0, 
      mapOpens: 0, 
      clicks: 0, 
      quoteRequests: 0, 
      chatsStarted: 0, 
      ordersWon: 0, 
      periodStart: new Date() 
    };
    
    await me.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('RESET_METRICS_ERROR:', err);
    res.status(500).json({ message: 'Błąd resetowania metryk' });
  }
});

module.exports = router;
module.exports.activatePromo = activatePromo;
