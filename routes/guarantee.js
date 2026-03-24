const express = require("express");
const router = express.Router();
const { authMiddleware: auth } = require("../middleware/authMiddleware");
const Order = require("../models/Order");
const { checkGuaranteeEligibility } = require("../utils/guarantee");

// GET /api/guarantee/:orderId/eligibility
router.get("/:orderId/eligibility", auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .select("provider paymentMethod status");
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    const result = await checkGuaranteeEligibility({
      paymentMethod: order.paymentMethod || "system", // fallback
      providerId: order.provider,
      orderStatus: order.status,
    });

    res.json({
      eligibleForGuarantee: result.eligible,
      reasons: result.reasons,
    });
  } catch (e) {
    res.status(500).json({ message: "Błąd serwera" });
  }
});

module.exports = router;


