/**
 * Rozliczenie zlecenia: płatność w Helpfli (escrow) vs poza systemem.
 * Uwaga: order.paymentMethod to enum Stripe (card/p24/blik) — NIE mieszać z paymentPreference.
 */

function isExternalOrderPayment(order) {
  return order?.paymentPreference === "external";
}

/** 'system' | 'external' — do gwarancji (baner Protect), sporu, akceptacji zakończenia */
function resolvePaymentFlow(order) {
  if (!order) return "system";
  if (isExternalOrderPayment(order)) return "external";
  return "system";
}

/**
 * Spór w platformie — każde rozliczenie w Helpfli (escrow), także gdy wykonawca nie ma pełnej weryfikacji KYC.
 * Nie wymaga eligibleForGuarantee (to osobny warunek pod baner marketingowy).
 */
function allowsPlatformDispute(order) {
  if (!order) return false;
  if (isExternalOrderPayment(order)) return false;
  if (order.paidInSystem === true) return true;
  if (order.paymentPreference === "system" || order.paymentPreference === "both") return true;
  // Starsze zlecenia bez paymentPreference, opłacone w systemie
  if (!order.paymentPreference && order.paymentStatus === "succeeded") return true;
  return resolvePaymentFlow(order) === "system";
}

module.exports = {
  isExternalOrderPayment,
  resolvePaymentFlow,
  allowsPlatformDispute,
};
