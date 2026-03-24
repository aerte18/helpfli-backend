const mongoose = require('mongoose');

const PaymentErrorLogSchema = new mongoose.Schema({
  // Typ błędu
  errorType: {
    type: String,
    enum: ['webhook_verification', 'payment_intent_failed', 'subscription_activation', 'promotion_activation', 'refund_failed', 'capture_failed', 'other'],
    required: true
  },
  
  // Powiązane obiekty
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserSubscription', default: null },
  
  // Stripe IDs
  stripePaymentIntentId: { type: String, index: true },
  stripeEventId: { type: String },
  stripeChargeId: { type: String },
  
  // Szczegóły błędu
  errorMessage: { type: String, required: true },
  errorStack: { type: String },
  errorCode: { type: String }, // np. 'card_declined', 'insufficient_funds'
  
  // Kontekst
  eventType: { type: String }, // np. 'payment_intent.succeeded', 'payment_intent.payment_failed'
  eventPayload: { type: Object, default: {} }, // fragment payloadu webhooka (bez wrażliwych danych)
  
  // Status i retry
  status: {
    type: String,
    enum: ['new', 'retrying', 'resolved', 'failed'],
    default: 'new'
  },
  retryable: { type: Boolean, default: true },
  retryCount: { type: Number, default: 0 },
  lastRetryAt: { type: Date },
  resolvedAt: { type: Date },
  
  // Metadata
  metadata: { type: Object, default: {} },
}, { timestamps: true });

// Indeksy dla szybkiego wyszukiwania
PaymentErrorLogSchema.index({ errorType: 1, status: 1, createdAt: -1 });
PaymentErrorLogSchema.index({ stripePaymentIntentId: 1 });
PaymentErrorLogSchema.index({ userId: 1, createdAt: -1 });
PaymentErrorLogSchema.index({ status: 1, retryable: 1 });

module.exports = mongoose.model('PaymentErrorLog', PaymentErrorLogSchema);

