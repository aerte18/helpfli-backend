const Stripe = require("stripe");
const Payment = require("../models/Payment");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function isExternalPayment(order) {
  return (
    order.paymentMethod === "external" ||
    order.paymentPreference === "external"
  );
}

/**
 * Zwraca środki klientowi zgodnie z ugodą (PLN → grosze).
 * - requires_capture: częściowy capture lub cancel całej autoryzacji
 * - succeeded: Refund na charge
 * - external / brak płatności: pomijamy (ugoda tylko „papierowo”)
 *
 * @param {import('mongoose').Document} order
 * @param {number} amountPln
 * @returns {Promise<{ ok: true, amountGrosze: number, method: string, stripeRef: string|null, orderPaymentStatus: string, orderPaymentSubStatus: string|null } | { ok: false, code: string, message: string }>}
 */
async function applyDisputeSettlementRefund(order, amountPln) {
  const refundGroszeRequested = Math.round(Number(amountPln) * 100);
  if (!Number.isFinite(refundGroszeRequested) || refundGroszeRequested < 1) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Nieprawidłowa kwota zwrotu." };
  }

  if (isExternalPayment(order)) {
    return {
      ok: true,
      amountGrosze: 0,
      method: "skipped_external",
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || "succeeded",
      orderPaymentSubStatus: null,
    };
  }

  if (!order.paymentId) {
    return {
      ok: true,
      amountGrosze: 0,
      method: "skipped_no_payment",
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || "unpaid",
      orderPaymentSubStatus: null,
    };
  }

  if (!stripe) {
    return {
      ok: false,
      code: "NO_STRIPE",
      message:
        "Stripe nie jest skonfigurowany — automatycznego zwrotu nie można wykonać. Skontaktuj się z pomocą Helpfli.",
    };
  }

  try {
    const payment = await Payment.findById(order.paymentId);
    if (!payment?.stripePaymentIntentId) {
      return {
        ok: false,
        code: "NO_INTENT",
        message: "Brak powiązanej płatności Stripe dla tego zlecenia.",
      };
    }

    const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId, {
      expand: ["latest_charge"],
    });

    /** @type {string} */
    let orderPaymentStatus = order.paymentStatus || "succeeded";

    if (pi.status === "requires_capture") {
      const authorized = pi.amount;
      const cap = Math.min(refundGroszeRequested, authorized);
      if (cap < 1) {
        return { ok: false, code: "NOTHING_TO_REFUND", message: "Brak autoryzowanej kwoty do zwrotu." };
      }

      if (cap >= authorized - 1) {
        await stripe.paymentIntents.cancel(payment.stripePaymentIntentId);
        payment.status = "refunded";
        await payment.save();
        return {
          ok: true,
          amountGrosze: cap,
          method: "cancel",
          stripeRef: pi.id,
          orderPaymentStatus: "refunded",
          orderPaymentSubStatus: "refunded",
        };
      }

      const toCapture = authorized - cap;
      const captured = await stripe.paymentIntents.capture(payment.stripePaymentIntentId, {
        amount_to_capture: toCapture,
      });
      if (captured.status !== "succeeded") {
        return {
          ok: false,
          code: "CAPTURE_FAILED",
          message: "Nie udało się sfinalizować częściowej płatności po ugodzie.",
        };
      }
      payment.status = "partial_refund";
      await payment.save();
      return {
        ok: true,
        amountGrosze: cap,
        method: "partial_capture",
        stripeRef: captured.id,
        orderPaymentStatus: "partial_refund",
        orderPaymentSubStatus: "partial_refund",
      };
    }

    if (pi.status === "succeeded") {
      let charge =
        pi.latest_charge && typeof pi.latest_charge === "object"
          ? pi.latest_charge
          : null;
      const chargeId =
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : charge?.id;
      if (!chargeId) {
        return { ok: false, code: "NO_CHARGE", message: "Brak charge do zwrotu w Stripe." };
      }
      if (!charge) {
        charge = await stripe.charges.retrieve(chargeId);
      }
      const alreadyRefunded = charge.amount_refunded || 0;
      const refundable = charge.amount - alreadyRefunded;
      const cap = Math.min(refundGroszeRequested, refundable);
      if (cap < 1) {
        return { ok: false, code: "NOTHING_TO_REFUND", message: "Brak środków do zwrotu na tej płatności." };
      }

      const refund = await stripe.refunds.create({
        charge: charge.id,
        amount: cap,
        metadata: {
          orderId: String(order._id),
          reason: "dispute_settlement",
        },
      });

      const ch2 = await stripe.charges.retrieve(charge.id);
      const totalRefunded = ch2.amount_refunded || 0;
      let subStatus = "partial_refund";
      if (totalRefunded >= ch2.amount - 1) {
        payment.status = "refunded";
        orderPaymentStatus = "refunded";
        subStatus = "refunded";
      } else {
        payment.status = "partial_refund";
        orderPaymentStatus = "partial_refund";
      }
      await payment.save();

      return {
        ok: true,
        amountGrosze: cap,
        method: "refund",
        stripeRef: refund.id,
        orderPaymentStatus,
        orderPaymentSubStatus: subStatus,
      };
    }

    return {
      ok: false,
      code: "UNEXPECTED_PI_STATUS",
      message: `Nieobsługiwany status płatności Stripe (${pi.status}). Skontaktuj się z pomocą Helpfli.`,
    };
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Błąd Stripe";
    return {
      ok: false,
      code: "STRIPE_ERROR",
      message: `Nie udało się wykonać zwrotu: ${msg}`,
    };
  }
}

module.exports = { applyDisputeSettlementRefund, isExternalPayment };
