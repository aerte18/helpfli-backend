const Payment = require("../models/Payment");
const Revenue = require("../models/Revenue");
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Po ugodzie (np. 0 PLN zwrotu) — capture escrow i status released (jak confirm-receipt).
 */
async function releaseOrderEscrowToProvider(order) {
  if (!order || order.status === "released" || order.status === "rated") {
    return { released: false, reason: "already_released" };
  }

  if (stripe && order.paymentId) {
    try {
      const payment = await Payment.findById(order.paymentId);
      if (payment?.stripePaymentIntentId) {
        const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
        const blocked = ["canceled", "requires_payment_method", "requires_action"];
        if (!blocked.includes(intent.status) && intent.status === "requires_capture") {
          const captured = await stripe.paymentIntents.capture(payment.stripePaymentIntentId);
          if (captured.status === "succeeded") {
            payment.status = "succeeded";
            await payment.save();
            order.paymentStatus = "succeeded";
            order.paidInSystem = true;
          }
        }
      }
    } catch (e) {
      if (e?.code !== "payment_intent_unexpected_state") {
        console.error("releaseOrderEscrow capture:", e);
      }
    }
  }

  order.status = "released";
  if (!order.paymentStatus || order.paymentStatus === "unpaid") {
    order.paymentStatus = "succeeded";
  }

  await Revenue.updateMany(
    { orderId: order._id, type: "escrow", status: "pending" },
    { $set: { status: "paid", releasedAt: new Date() } }
  );

  try {
    const { processOrderGrowthRewards } = require("./growthRewards");
    await processOrderGrowthRewards(order);
  } catch (e) {
    console.error("releaseOrderEscrow growth rewards:", e?.message || e);
  }

  return { released: true };
}

module.exports = { releaseOrderEscrowToProvider };
