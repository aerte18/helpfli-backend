const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roles");
const Coupon = require("../models/Coupon");

// ADMIN: tworzenie kuponu
router.post("/", authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const c = await Coupon.create(req.body);
    res.json(c);
  } catch (err) {
    console.error('COUPON_CREATE_ERROR:', err);
    res.status(500).json({ message: 'Błąd tworzenia kuponu' });
  }
});

// ADMIN: lista kuponów
router.get("/", authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json(coupons);
  } catch (err) {
    console.error('COUPON_LIST_ERROR:', err);
    res.status(500).json({ message: 'Błąd pobierania kuponów' });
  }
});

// ADMIN: aktualizacja kuponu
router.put("/:id", authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const c = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!c) return res.status(404).json({ message: 'Kupon nie znaleziony' });
    res.json(c);
  } catch (err) {
    console.error('COUPON_UPDATE_ERROR:', err);
    res.status(500).json({ message: 'Błąd aktualizacji kuponu' });
  }
});

// ADMIN: usuwanie kuponu
router.delete("/:id", authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const c = await Coupon.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ message: 'Kupon nie znaleziony' });
    res.json({ message: 'Kupon usunięty' });
  } catch (err) {
    console.error('COUPON_DELETE_ERROR:', err);
    res.status(500).json({ message: 'Błąd usuwania kuponu' });
  }
});

// PUBLIC (wymaga zalogowania): walidacja i podgląd rabatu
// POST /api/coupons/apply
// body: { code, productKey, baseAmount }
router.post("/apply", authMiddleware, async (req, res) => {
  try {
    const { code, productKey, baseAmount } = req.body || {};
    if (!code) return res.status(400).json({ message: "Brak kodu kuponu" });

    const now = new Date();
    const c = await Coupon.findOne({ code: code.toUpperCase(), active: true });
    if (!c) return res.status(404).json({ message: "Kupon nie istnieje lub jest nieaktywny" });

    const okDate = (!c.validFrom || c.validFrom <= now) && (!c.validTo || c.validTo >= now);
    if (!okDate) return res.status(400).json({ message: "Kupon nie jest aktualnie ważny" });

    const okUses = (!c.maxUses || c.used < c.maxUses);
    if (!okUses) return res.status(400).json({ message: "Limit użyć kuponu został wyczerpany" });

    const okProd = (!c.products?.length || (productKey && c.products.includes(productKey)));
    if (!okProd) return res.status(400).json({ message: "Kupon nie dotyczy tego produktu" });

    const base = typeof baseAmount === "number" ? baseAmount : 0;
    let finalAmount = base;
    if (c.type === "percent") {
      finalAmount = Math.max(0, Math.round(base * (100 - c.value) / 100));
    } else if (c.type === "amount") {
      finalAmount = Math.max(0, base - c.value);
    }

    const discountAmount = Math.max(0, base - finalAmount);

    return res.json({
      ok: true,
      coupon: {
        id: c._id,
        code: c.code,
        type: c.type,
        value: c.value,
      },
      baseAmount: base,
      finalAmount,
      discountAmount,
    });
  } catch (err) {
    console.error("COUPON_APPLY_ERROR:", err);
    res.status(500).json({ message: "Błąd walidacji kuponu" });
  }
});

module.exports = router;




