const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { authMiddleware } = require('../middleware/authMiddleware');
const { syncOrderPaymentFromStripe } = require('./payments');

/**
 * Kompatybilność z frontendem prod: GET /api/charge-requests/order/:orderId
 * Zwraca 200 (nie 404), żeby UI mogło sprawdzić, czy płatność Stripe już przeszła.
 */
router.get('/order/:orderId', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ message: 'Nie znaleziono zlecenia' });
    }
    const clientId = order.client?._id || order.client;
    const providerId = order.provider?._id || order.provider;
    const uid = String(req.user._id);
    if (String(clientId) !== uid && String(providerId) !== uid) {
      return res.status(403).json({ message: 'Brak dostępu' });
    }

    const result = await syncOrderPaymentFromStripe(req.params.orderId);
    if (!result.paid) {
      return res.json({
        paid: false,
        order,
        chargeRequest: null,
      });
    }

    return res.json({
      paid: true,
      order: result.order,
      paymentIntentId: result.paymentIntentId,
      stripeStatus: result.stripeStatus,
      duplicatesCanceled: result.duplicatesCanceled,
      chargeRequest: {
        status: result.stripeStatus,
        paymentIntentId: result.paymentIntentId,
        orderId: String(order._id),
      },
    });
  } catch (e) {
    console.error('charge-requests/order error:', e);
    res.status(500).json({ message: 'Błąd sprawdzania płatności' });
  }
});

module.exports = router;
