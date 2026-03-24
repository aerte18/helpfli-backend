const express = require('express');
const router = express.Router();
const PromoCode = require('../models/PromoCode');
const Order = require('../models/Order');
const { authMiddleware: auth } = require('../middleware/authMiddleware');

router.post('/validate', auth, async (req, res) => {
  try {
    const { code, serviceKey, baseAmount } = req.body || {};
    const promo = await PromoCode.findOne({ code: code?.toUpperCase(), active: true });
    if (!promo) return res.status(404).json({ message: 'Kod nie istnieje lub jest nieaktywny' });

    const now = new Date();
    if ((promo.validFrom && promo.validFrom > now) || (promo.validTo && promo.validTo < now)) {
      return res.status(400).json({ message: 'Kod nie jest aktualnie ważny' });
    }
    if (promo.maxRedemptions && promo.redemptions >= promo.maxRedemptions) {
      return res.status(400).json({ message: 'Limit użyć kodu został wyczerpany' });
    }
    if (promo.minOrderValue && baseAmount < promo.minOrderValue) {
      return res.status(400).json({ message: `Minimalna wartość zamówienia: ${promo.minOrderValue}` });
    }
    if (promo.allowedServices?.length && serviceKey && !promo.allowedServices.includes(serviceKey)) {
      return res.status(400).json({ message: 'Kod nie dotyczy wybranej usługi' });
    }
    if (promo.firstOrderOnly) {
      const count = await Order.countDocuments({ client: req.user._id, status: { $in: ['completed', 'paid'] } });
      if (count > 0) return res.status(400).json({ message: 'Kod tylko na pierwsze zlecenie' });
    }

    return res.json({ ok: true, promo: {
      code: promo.code,
      discountPercent: promo.discountPercent,
      discountFlat: promo.discountFlat
    }});
  } catch (e) {
    const logger = require('../utils/logger');
    logger.error('PROMO_CODE_VALIDATION_ERROR:', {
      message: e.message,
      stack: e.stack
    });
    res.status(500).json({ message: 'Błąd walidacji kodu' });
  }
});

module.exports = router;






