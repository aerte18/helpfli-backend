const Payment = require("../models/Payment");
const User = require("../models/User");
const Stripe = require("stripe");
const { isExternalOrderPayment } = require("./orderPaymentFlow");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function sameId(left, right) {
  if (left == null || right == null) return false;
  return String(left) === String(right);
}

function releaseFailure(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

function stripeObjectId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value._id || null;
}

function hasDestinationChargeBinding(intent, payment) {
  const intentMetadata = intent?.metadata || {};
  const paymentMetadata = payment?.metadata || {};
  return Boolean(
    stripeObjectId(intent?.transfer_data?.destination) ||
      intentMetadata.providerId ||
      intentMetadata.acceptedOfferId ||
      intentMetadata.destinationAccountId ||
      paymentMetadata.providerId ||
      paymentMetadata.acceptedOfferId ||
      paymentMetadata.destinationAccountId
  );
}

function validateDestinationChargeBinding(order, payment, intent, provider) {
  // Historyczne escrow sprzed wdrożenia Stripe Connect nie miało destination ani
  // trzech poniższych pól. Gdy choć jeden współczesny sygnał istnieje, wymagamy
  // kompletnego powiązania po obu stronach (Stripe i lokalny Payment).
  if (!hasDestinationChargeBinding(intent, payment)) {
    return { ok: true, legacy: true };
  }

  const orderId = order?._id;
  const providerId = order?.provider?._id || order?.provider;
  const acceptedOfferId = order?.acceptedOfferId?._id || order?.acceptedOfferId;
  const destinationAccountId = provider?.stripeAccountId;
  const destination = stripeObjectId(intent?.transfer_data?.destination);
  const intentMetadata = intent?.metadata || {};
  const paymentMetadata = payment?.metadata || {};
  const paymentOrderId = payment?.order?._id || payment?.order;
  const paymentProviderId = payment?.provider?._id || payment?.provider;

  if (!orderId || !providerId || !acceptedOfferId || !destinationAccountId || !destination) {
    return releaseFailure(
      "destination_charge_mismatch",
      "Nie można potwierdzić kompletnego powiązania płatności z wykonawcą"
    );
  }

  const providerDocumentId = provider?._id || provider?.id;
  if (providerDocumentId && !sameId(providerDocumentId, providerId)) {
    return releaseFailure(
      "destination_charge_mismatch",
      "Konto Stripe nie należy do aktualnego wykonawcy zlecenia"
    );
  }

  const allBindingsMatch =
    sameId(destination, destinationAccountId) &&
    sameId(intentMetadata.orderId, orderId) &&
    sameId(intentMetadata.providerId, providerId) &&
    sameId(intentMetadata.acceptedOfferId, acceptedOfferId) &&
    sameId(intentMetadata.destinationAccountId, destinationAccountId) &&
    sameId(paymentOrderId, orderId) &&
    sameId(paymentProviderId, providerId) &&
    sameId(paymentMetadata.orderId, orderId) &&
    sameId(paymentMetadata.providerId, providerId) &&
    sameId(paymentMetadata.acceptedOfferId, acceptedOfferId) &&
    sameId(paymentMetadata.destinationAccountId, destinationAccountId);

  if (!allBindingsMatch) {
    return releaseFailure(
      "destination_charge_mismatch",
      "Płatność Stripe nie jest powiązana z aktualną ofertą lub kontem wykonawcy"
    );
  }

  return { ok: true, legacy: false };
}

async function validateCurrentDestinationChargeBinding(
  order,
  payment,
  intent,
  UserModel
) {
  if (!hasDestinationChargeBinding(intent, payment)) {
    return { ok: true, legacy: true };
  }

  const providerId = order?.provider?._id || order?.provider;
  if (!providerId) {
    return releaseFailure(
      "destination_charge_mismatch",
      "Zlecenie nie ma aktualnie przypisanego wykonawcy"
    );
  }

  let provider;
  try {
    const query = UserModel.findById(providerId);
    provider = query && typeof query.select === "function"
      ? await query.select("stripeAccountId")
      : await query;
  } catch (error) {
    console.error("releaseOrderEscrow provider lookup:", error);
    return releaseFailure(
      "provider_lookup_failed",
      "Nie udało się potwierdzić konta Stripe wykonawcy",
      { error }
    );
  }

  return validateDestinationChargeBinding(order, payment, intent, provider);
}

function validateMainStripeIntent(order, payment, intent) {
  if (!intent?.id || !order?._id) {
    return releaseFailure("payment_intent_mismatch", "Stripe nie zwrócił poprawnej głównej płatności");
  }
  if (order.payment?.intentId && !sameId(order.payment.intentId, intent.id)) {
    return releaseFailure("payment_intent_mismatch", "PaymentIntent nie jest aktualnym escrow tego zlecenia");
  }

  const metadataOrderId = intent.metadata?.orderId;
  const metadataType = intent.metadata?.type;
  if (!metadataOrderId || !sameId(metadataOrderId, order._id)) {
    return releaseFailure("payment_intent_mismatch", "PaymentIntent należy do innego zlecenia");
  }
  if (metadataType !== "order_escrow") {
    return releaseFailure("payment_intent_mismatch", "PaymentIntent nie jest głównym escrow zlecenia");
  }

  const expectedAmount = Number(order.amountTotal) > 0
    ? Math.round(Number(order.amountTotal))
    : Math.round(Number(order.pricing?.total || 0) * 100);
  if (!expectedAmount || Number(intent.amount) !== expectedAmount) {
    return releaseFailure(
      "payment_amount_mismatch",
      "Kwota Stripe nie odpowiada aktualnej wycenie zlecenia"
    );
  }
  const expectedCurrency = String(order.currency || payment.currency || "pln").toLowerCase();
  if (String(intent.currency || "").toLowerCase() !== expectedCurrency) {
    return releaseFailure(
      "payment_currency_mismatch",
      "Waluta Stripe nie odpowiada walucie zlecenia"
    );
  }
  return { ok: true };
}

/**
 * Verifies the canonical (main) order Payment and captures it when necessary.
 *
 * Important invariants:
 * - the main payment is referenced exclusively by order.paymentId;
 * - order.payment.additionalPaymentId is never treated as the escrow payment;
 * - success is reported only after Stripe confirms status=succeeded.
 *
 * Dependencies are injectable to keep the financial state machine unit-testable.
 */
async function settleMainOrderPaymentForRelease(order, dependencies = {}) {
  const PaymentModel = dependencies.PaymentModel || Payment;
  const UserModel = dependencies.UserModel || User;
  const stripeClient = Object.prototype.hasOwnProperty.call(dependencies, "stripeClient")
    ? dependencies.stripeClient
    : stripe;

  if (!order) {
    return releaseFailure("missing_order", "Brak zlecenia do rozliczenia");
  }

  if (isExternalOrderPayment(order)) {
    return { ok: true, external: true, payment: null, intent: null };
  }

  if (!stripeClient) {
    return releaseFailure(
      "stripe_unavailable",
      "Płatności Stripe są chwilowo niedostępne. Spróbuj ponownie później."
    );
  }

  if (!order.paymentId) {
    return releaseFailure(
      "missing_main_payment",
      "Brak głównej płatności Stripe przypisanej do zlecenia"
    );
  }

  const additionalPaymentId = order.payment?.additionalPaymentId;
  if (additionalPaymentId && sameId(order.paymentId, additionalPaymentId)) {
    return releaseFailure(
      "ambiguous_payment_reference",
      "Główna płatność i dopłata wskazują ten sam rekord. Wymagana jest weryfikacja obsługi."
    );
  }

  let payment;
  try {
    payment = await PaymentModel.findById(order.paymentId);
  } catch (error) {
    console.error("releaseOrderEscrow main payment lookup:", error);
    return releaseFailure(
      "main_payment_lookup_failed",
      "Nie udało się zweryfikować głównej płatności",
      { error }
    );
  }

  if (!payment || !payment.stripePaymentIntentId) {
    return releaseFailure(
      "missing_main_payment_intent",
      "Główna płatność nie ma identyfikatora Stripe"
    );
  }

  const paymentOrderId = payment.order?._id || payment.order;
  if (!paymentOrderId || !order._id || !sameId(paymentOrderId, order._id)) {
    return releaseFailure(
      "payment_order_mismatch",
      "Główna płatność nie należy do tego zlecenia"
    );
  }

  const paymentType = payment.metadata?.type || payment.metadata?.subtype;
  if (
    payment.purpose !== "order" ||
    paymentType !== "order_escrow"
  ) {
    return releaseFailure(
      "main_payment_not_escrow",
      "Wskazana płatność nie jest głównym escrow zlecenia"
    );
  }

  if (
    payment.status === "refunded" ||
    order.paymentStatus === "refunded" ||
    order.payment?.status === "refunded"
  ) {
    return releaseFailure(
      "payment_refunded",
      "Płatność została w całości zwrócona i zlecenie nie może zostać rozliczone ponownie"
    );
  }

  const paymentIntentId = payment.stripePaymentIntentId;
  let intent;
  try {
    intent = await stripeClient.paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    console.error("releaseOrderEscrow retrieve:", error);
    return releaseFailure(
      "stripe_retrieve_failed",
      "Nie udało się potwierdzić statusu płatności w Stripe",
      { error }
    );
  }

  const intentBinding = validateMainStripeIntent(order, payment, intent);
  if (!intentBinding.ok) return intentBinding;

  if (intent?.status === "requires_capture") {
    // Ostatnia kontrola tuż przed nieodwracalnym capture. Nie ufamy samemu
    // order.provider: konto Connect pobieramy ponownie z aktualnego Usera.
    const destinationBinding = await validateCurrentDestinationChargeBinding(
      order,
      payment,
      intent,
      UserModel
    );
    if (!destinationBinding.ok) return destinationBinding;

    try {
      intent = await stripeClient.paymentIntents.capture(paymentIntentId);
    } catch (error) {
      // Capture may have reached Stripe even when the response was interrupted.
      // Re-read once, but release only if Stripe explicitly confirms success.
      try {
        intent = await stripeClient.paymentIntents.retrieve(paymentIntentId);
      } catch (retrieveAfterCaptureError) {
        console.error("releaseOrderEscrow capture/retrieve:", error, retrieveAfterCaptureError);
        return releaseFailure(
          "stripe_capture_failed",
          "Nie udało się potwierdzić pobrania środków w Stripe",
          { error }
        );
      }
      if (intent?.status !== "succeeded") {
        console.error("releaseOrderEscrow capture:", error);
        return releaseFailure(
          "stripe_capture_failed",
          "Nie udało się pobrać środków w Stripe",
          { error, stripeStatus: intent?.status || null }
        );
      }
    }
  }

  const capturedIntentBinding = validateMainStripeIntent(order, payment, intent);
  if (!capturedIntentBinding.ok) return capturedIntentBinding;

  // Capture może zwrócić inny stan niż wcześniejszy retrieve (a przy błędzie
  // sieciowym powyżej wykonujemy ponowny retrieve), dlatego przed lokalną
  // finalizacją sprawdzamy destination i wszystkie bindingi jeszcze raz.
  const capturedDestinationBinding = await validateCurrentDestinationChargeBinding(
    order,
    payment,
    intent,
    UserModel
  );
  if (!capturedDestinationBinding.ok) return capturedDestinationBinding;

  if (intent?.status !== "succeeded") {
    return releaseFailure(
      "stripe_payment_not_succeeded",
      `Płatność nie została jeszcze rozliczona (status: ${intent?.status || "unknown"})`,
      { stripeStatus: intent?.status || null }
    );
  }

  // Pełny refund został odrzucony powyżej. Częściowy zwrot zachowujemy,
  // ponieważ pozostała część płatności mogła zostać rozliczona ugodą.
  const refundStates = new Set(["partial_refund"]);
  const hasRefundState =
    refundStates.has(payment.status) ||
    refundStates.has(order.paymentStatus) ||
    refundStates.has(order.payment?.status);

  if (!hasRefundState) {
    payment.status = "succeeded";
  }
  await payment.save();

  if (!refundStates.has(order.paymentStatus)) {
    order.paymentStatus = "succeeded";
  }
  order.paidInSystem = true;
  const protectionPurchased =
    order.protectionEligible === true ||
    order.pricing?.includeGuarantee === true ||
    Number(order.pricing?.guaranteeFee || 0) > 0;
  if (!hasRefundState && protectionPurchased && order.protectionStatus !== "void") {
    order.protectionEligible = true;
    order.protectionStatus = "active";
    order.protectionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else if (!hasRefundState && !protectionPurchased && order.protectionStatus !== "void") {
    // Capture escrow nie może sam włączyć płatnej ochrony, której klient nie wybrał.
    order.protectionEligible = false;
    order.protectionStatus = "inactive";
    order.protectionExpiresAt = null;
  }
  if (order.payment) {
    if (!hasRefundState) {
      order.payment.status = "paid";
    }
    order.payment.intentId = paymentIntentId;
  }

  return { ok: true, external: false, payment, intent };
}

/**
 * Po ugodzie (np. 0 PLN zwrotu) — capture escrow i status released (jak confirm-receipt).
 */
async function releaseOrderEscrowToProvider(order, dependencies = {}) {
  if (!order || order.status === "released" || order.status === "rated") {
    return { released: false, reason: "already_released" };
  }

  const OrderModel = dependencies.OrderModel || (
    order.constructor?.modelName ? order.constructor : null
  );
  const originalStatus = order.status;
  let releaseClaimed = false;

  if (OrderModel?.findOneAndUpdate) {
    if (originalStatus === "releasing") {
      return { released: false, reason: "release_in_progress" };
    }
    const claim = await OrderModel.findOneAndUpdate(
      { _id: order._id, status: originalStatus },
      {
        $set: {
          status: "releasing",
          releaseStartedAt: new Date(),
          releasePreviousStatus: originalStatus,
        },
      },
      { new: true, runValidators: true }
    );
    if (!claim) {
      return { released: false, reason: "already_released" };
    }
    releaseClaimed = true;
    order.status = "releasing";
  }

  const revertClaim = async () => {
    if (!releaseClaimed) return;
    await OrderModel.updateOne(
      { _id: order._id, status: "releasing" },
      {
        $set: {
          status: originalStatus,
          releaseStartedAt: null,
          releasePreviousStatus: null,
        },
      }
    );
    releaseClaimed = false;
    order.status = originalStatus;
  };

  try {
    const settlement = await settleMainOrderPaymentForRelease(order, dependencies);
    if (!settlement.ok) {
      await revertClaim();
      return {
        released: false,
        reason: settlement.reason,
        message: settlement.message,
        stripeStatus: settlement.stripeStatus || null,
      };
    }

    const releaseSet = {
      status: "released",
      releaseStartedAt: null,
      releasePreviousStatus: null,
    };
    if (settlement.external) {
      // External payments are never represented as paid/succeeded in Helpfli.
      releaseSet.paidInSystem = false;
      releaseSet.protectionEligible = false;
      releaseSet.protectionStatus = "inactive";
      releaseSet.protectionExpiresAt = null;
    } else {
      releaseSet.paymentStatus = order.paymentStatus;
      releaseSet.paidInSystem = order.paidInSystem;
      releaseSet.protectionEligible = order.protectionEligible;
      releaseSet.protectionStatus = order.protectionStatus;
      releaseSet.protectionExpiresAt = order.protectionExpiresAt || null;
      if (order.payment?.status != null) releaseSet["payment.status"] = order.payment.status;
      if (order.payment?.intentId) releaseSet["payment.intentId"] = order.payment.intentId;
    }

    if (OrderModel?.findOneAndUpdate) {
      const finalized = await OrderModel.findOneAndUpdate(
        { _id: order._id, status: "releasing" },
        { $set: releaseSet },
        { new: true, runValidators: true }
      );
      if (!finalized) throw new Error("Order release claim was lost before finalization");
      releaseClaimed = false;
    } else {
      // Test doubles / starsze wywołania bez modelu nadal zachowują ten sam kontrakt.
      Object.assign(order, releaseSet);
      if (typeof order.save === "function") await order.save();
    }

    order.status = "released";
    if (settlement.external) {
      order.paidInSystem = false;
      order.protectionEligible = false;
      order.protectionStatus = "inactive";
      order.protectionExpiresAt = null;
    }

    const processOrderGrowthRewards = dependencies.processOrderGrowthRewards
      || require("./growthRewards").processOrderGrowthRewards;
    try {
      await processOrderGrowthRewards(order);
    } catch (e) {
      console.error("releaseOrderEscrow growth rewards:", e?.message || e);
    }

    return { released: true };
  } catch (error) {
    await revertClaim();
    throw error;
  }
}

module.exports = {
  releaseOrderEscrowToProvider,
  settleMainOrderPaymentForRelease,
  validateDestinationChargeBinding,
  validateMainStripeIntent,
};
