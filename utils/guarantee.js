const Verification = require("../models/Verification");

/**
 * Zwraca { eligible: boolean, reasons: string[] }
 * @param {Object} params
 * @param {'system'|'external'} params.paymentMethod
 * @param {string} params.providerId
 * @param {string} params.orderStatus
 */
exports.checkGuaranteeEligibility = async ({ paymentMethod, providerId, orderStatus }) => {
  const reasons = [];
  let eligible = true;

  if (paymentMethod !== "system") {
    eligible = false;
    reasons.push("Płatność poza systemem Helpfli");
  }

  const v = await Verification.findOne({ user: providerId }).select("status");
  if (!v || v.status !== "verified") {
    eligible = false;
    reasons.push("Wykonawca nie jest zweryfikowany");
  }
  if (v && v.status === "suspended") {
    eligible = false;
    reasons.push("Konto wykonawcy jest zawieszone");
  }

  // Statusy, w których nadal ma sens ochrona / narzędzia sporu–zwrot (cykl życia zlecenia)
  const allowed = new Set([
    "open",
    "collecting_offers",
    "accepted",
    "awaiting_payment",
    "funded",
    "paid",
    "in_progress",
    "completed",
    "rated",
    "released",
    "matched",
    "quote",
    "disputed",
  ]);
  if (orderStatus && !allowed.has(orderStatus)) {
    eligible = false;
    reasons.push("Status zlecenia nie kwalifikuje się do gwarancji");
  }

  return { eligible, reasons };
};



