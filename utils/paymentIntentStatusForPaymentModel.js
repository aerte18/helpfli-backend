/**
 * Mapuje Stripe PaymentIntent.status na enum modelu Payment (Mongoose).
 * Unika ValidationError przy statusach typu requires_action / requires_confirmation.
 * @see https://stripe.com/docs/api/payment_intents/object#payment_intent_object-status
 */
function paymentIntentStatusForPaymentModel(stripePiStatus) {
  const allowed = new Set([
    'requires_payment_method',
    'processing',
    'succeeded',
    'failed',
    'canceled',
    'refunded',
    'partial_refund',
  ]);
  if (!stripePiStatus || typeof stripePiStatus !== 'string') return 'processing';
  if (allowed.has(stripePiStatus)) return stripePiStatus;
  if (
    stripePiStatus === 'requires_action' ||
    stripePiStatus === 'requires_confirmation'
  ) {
    return 'requires_payment_method';
  }
  if (stripePiStatus === 'requires_capture') {
    return 'processing';
  }
  return 'processing';
}

module.exports = { paymentIntentStatusForPaymentModel };
