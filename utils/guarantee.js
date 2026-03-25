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

  // Dopuszczalne statusy (dopasuj do swoich)
  const allowed = new Set(["created", "accepted", "in_progress"]);
  if (!allowed.has(orderStatus)) {
    eligible = false;
    reasons.push("Status zlecenia nie kwalifikuje się do gwarancji");
  }

  return { eligible, reasons };
};



