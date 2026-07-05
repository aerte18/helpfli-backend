const Stripe = require("stripe");
const Payment = require("../models/Payment");

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const { isExternalOrderPayment } = require("./orderPaymentFlow");

function buildIdempotencyKey(scope, paymentId, amountGrosze, operation) {
  const raw = `dispute_${scope}_${paymentId}_${operation}_${amountGrosze}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 255);
}

function isExternalPayment(order) {
  return isExternalOrderPayment(order);
}

/**
 * Zwrot z jednego dokumentu Payment (Stripe PI).
 * @returns {Promise<{ skipped: true } | { ok: false, code: string, message: string } | { ok: true, paymentId: string, amountGrosze: number, method: string, stripeRef: string|null, paymentStatus: string }>}
 */
async function applyRefundToSinglePayment(payment, capGrosze, orderId, idempotencyScope) {
  if (!payment?.stripePaymentIntentId || !capGrosze || capGrosze < 1) {
    return { skipped: true };
  }

  const scope = idempotencyScope || String(orderId || payment._id);

  const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId, {
    expand: ["latest_charge"],
  });

  const paymentIdStr = String(payment._id);

  if (pi.status === "requires_capture") {
    const authorized = pi.amount;
    const use = Math.min(capGrosze, authorized);
    if (use < 1) {
      return { skipped: true };
    }

    if (use >= authorized - 1) {
      await stripe.paymentIntents.cancel(payment.stripePaymentIntentId, {
        idempotencyKey: buildIdempotencyKey(scope, paymentIdStr, use, "cancel"),
      });
      payment.status = "refunded";
      await payment.save();
      return {
        ok: true,
        paymentId: paymentIdStr,
        amountGrosze: use,
        method: "cancel",
        stripeRef: pi.id,
        paymentStatus: "refunded",
      };
    }

    const toCapture = authorized - use;
    const captured = await stripe.paymentIntents.capture(
      payment.stripePaymentIntentId,
      { amount_to_capture: toCapture },
      { idempotencyKey: buildIdempotencyKey(scope, paymentIdStr, toCapture, "partial_capture") }
    );
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
      paymentId: paymentIdStr,
      amountGrosze: use,
      method: "partial_capture",
      stripeRef: captured.id,
      paymentStatus: "partial_refund",
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
      return { skipped: true };
    }
    if (!charge) {
      charge = await stripe.charges.retrieve(chargeId);
    }
    const alreadyRefunded = charge.amount_refunded || 0;
    const refundable = charge.amount - alreadyRefunded;
    const use = Math.min(capGrosze, refundable);
    if (use < 1) {
      return { skipped: true };
    }

    const refund = await stripe.refunds.create(
      {
        charge: charge.id,
        amount: use,
        metadata: {
          reason: "dispute_settlement",
          ...(orderId ? { orderId: String(orderId) } : {}),
        },
      },
      { idempotencyKey: buildIdempotencyKey(scope, paymentIdStr, use, "refund") }
    );

    const ch2 = await stripe.charges.retrieve(charge.id);
    const totalRefunded = ch2.amount_refunded || 0;
    if (totalRefunded >= ch2.amount - 1) {
      payment.status = "refunded";
    } else {
      payment.status = "partial_refund";
    }
    await payment.save();

    return {
      ok: true,
      paymentId: paymentIdStr,
      amountGrosze: use,
      method: "refund",
      stripeRef: refund.id,
      paymentStatus: payment.status,
    };
  }

  return {
    ok: false,
    code: "UNEXPECTED_PI_STATUS",
    message: `Nieobsługiwany status płatności Stripe (${pi.status}).`,
  };
}

/**
 * Zwraca środki klientowi zgodnie z ugodą (PLN → grosze).
 * Najpierw główna płatność zlecenia, potem — jeśli trzeba — dopłata (`payment.additionalPaymentId`).
 *
 * @param {import('mongoose').Document} order
 * @param {number} amountPln
 * @returns {Promise<{ ok: true, amountGrosze: number, method: string, stripeRef: string|null, orderPaymentStatus: string, orderPaymentSubStatus: string|null, additionalPaymentStatus: string|null } | { ok: false, code: string, message: string }>}
 */
async function applyDisputeSettlementRefund(order, amountPln, options = {}) {
  const idempotencyScope = options.idempotencyScope || String(order._id);
  const refundGroszeRequested = Math.round(Number(amountPln) * 100);
  if (!Number.isFinite(refundGroszeRequested) || refundGroszeRequested < 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Nieprawidłowa kwota zwrotu." };
  }

  if (refundGroszeRequested === 0) {
    return {
      ok: true,
      amountGrosze: 0,
      method: "zero_settlement",
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || "succeeded",
      orderPaymentSubStatus: order.payment?.status || null,
      additionalPaymentStatus: order.additionalPaymentStatus || null,
    };
  }

  if (isExternalPayment(order)) {
    return {
      ok: true,
      amountGrosze: 0,
      method: "skipped_external",
      stripeRef: null,
      orderPaymentStatus: order.paymentStatus || "succeeded",
      orderPaymentSubStatus: null,
      additionalPaymentStatus: null,
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
      additionalPaymentStatus: null,
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
    let remaining = refundGroszeRequested;
    const parts = [];
    let mainOrderPaymentStatus = order.paymentStatus || "succeeded";
    let mainOrderPaymentSubStatus = null;
    let additionalPaymentStatus = null;

    const mainPayment = await Payment.findById(order.paymentId);
    if (!mainPayment?.stripePaymentIntentId) {
      return {
        ok: false,
        code: "NO_INTENT",
        message: "Brak powiązanej płatności Stripe dla tego zlecenia.",
      };
    }

    const r1 = await applyRefundToSinglePayment(mainPayment, remaining, order._id, idempotencyScope);
    if (r1.ok === false) {
      return r1;
    }
    if (!r1.skipped) {
      remaining -= r1.amountGrosze;
      parts.push(r1);
      mainOrderPaymentStatus = r1.paymentStatus;
      mainOrderPaymentSubStatus =
        r1.paymentStatus === "refunded"
          ? "refunded"
          : r1.paymentStatus === "partial_refund"
            ? "partial_refund"
            : order.payment?.status || "paid";
    }

    if (remaining >= 1) {
      const addId = order.payment?.additionalPaymentId;
      const addPay = addId ? await Payment.findById(addId) : null;
      if (!addPay?.stripePaymentIntentId) {
        return {
          ok: false,
          code: "INSUFFICIENT_REFUNDABLE",
          message:
            "Kwota ugody przekracza środki możliwe do zwrotu z zarejestrowanych płatności. Zmniejsz kwotę lub skontaktuj się z pomocą Helpfli.",
        };
      }
      if (order.additionalPaymentStatus !== "succeeded") {
        return {
          ok: false,
          code: "ADDITIONAL_NOT_PAID",
          message:
            "Część kwoty nie mieści się w głównej płatności, a dopłata nie jest zaksięgowana jako opłacona — nie można wykonać zwrotu. Skontaktuj się z pomocą Helpfli.",
        };
      }

      const r2 = await applyRefundToSinglePayment(addPay, remaining, order._id, idempotencyScope);
      if (r2.ok === false) {
        return r2;
      }
      if (r2.skipped) {
        return {
          ok: false,
          code: "INSUFFICIENT_REFUNDABLE",
          message:
            "Na dopłacie nie ma już środków do zwrotu w wysokości ugody. Zmniejsz kwotę lub skontaktuj się z pomocą Helpfli.",
        };
      }
      remaining -= r2.amountGrosze;
      parts.push(r2);
      additionalPaymentStatus = r2.paymentStatus;
    }

    if (remaining >= 1) {
      return {
        ok: false,
        code: "INSUFFICIENT_REFUNDABLE",
        message:
          "Kwota ugody przekracza łącznie możliwy zwrot z głównej płatności i dopłaty. Zmniejsz kwotę lub skontaktuj się z pomocą Helpfli.",
      };
    }

    const totalApplied = parts.reduce((s, p) => s + p.amountGrosze, 0);
    const method =
      parts.length > 1 ? "split_refund" : parts.length === 1 ? parts[0].method : "skipped_no_payment";
    const stripeRef =
      parts.length > 0 ? parts.map((p) => p.stripeRef).filter(Boolean).join(";") : null;

    return {
      ok: true,
      amountGrosze: totalApplied,
      method,
      stripeRef,
      orderPaymentStatus: mainOrderPaymentStatus,
      orderPaymentSubStatus: mainOrderPaymentSubStatus,
      additionalPaymentStatus,
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
