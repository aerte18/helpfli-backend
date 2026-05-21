const Offer = require("../models/Offer");
const Payment = require("../models/Payment");

/**
 * Maksymalna kwota zwrotu w ugodzie (PLN) — min(wartość oferty, suma opłacona w systemie).
 */
async function getSettlementRefundCaps(order) {
  let offerMaxPln = 200000;
  if (order.acceptedOfferId) {
    const off = await Offer.findById(order.acceptedOfferId).select("amount price");
    if (off) offerMaxPln = Math.max(Number(off.amount || off.price || 0), 0);
  } else if (order.budget) {
    offerMaxPln = Math.max(Number(order.budget), 0);
  }

  let maxRefundPln = offerMaxPln;
  try {
    let totalGrosze = 0;
    if (order.paymentId) {
      const pm = await Payment.findById(order.paymentId).select("amount status").lean();
      if (pm && ["succeeded", "processing", "partial_refund"].includes(pm.status)) {
        totalGrosze += Number(pm.amount) || 0;
      }
    }
    const addPid = order.payment?.additionalPaymentId;
    if (addPid && order.additionalPaymentStatus === "succeeded") {
      const ap = await Payment.findById(addPid).select("amount status").lean();
      if (ap && ap.status === "succeeded") {
        totalGrosze += Number(ap.amount) || 0;
      }
    }
    if (totalGrosze > 0) {
      maxRefundPln = Math.min(offerMaxPln, Math.round(totalGrosze) / 100);
    }
  } catch (_) {
    /* cap z oferty */
  }

  return {
    offerMaxPln: Math.round(offerMaxPln * 100) / 100,
    maxRefundPln: Math.round(maxRefundPln * 100) / 100,
  };
}

module.exports = { getSettlementRefundCaps };
