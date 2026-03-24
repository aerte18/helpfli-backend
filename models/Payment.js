const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  // Płatność może być powiązana ze zleceniem (order) – przy subskrypcjach to pole zostaje puste
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },

  // Typ płatności:
  // - 'order'        – klasyczna płatność za zlecenie
  // - 'promotion'    – płatność za promowanie / sponsor / boost
  // - 'subscription' – płatność za subskrypcję (CLIENT_* / PROV_*)
  purpose: { type: String, enum: ['order', 'promotion', 'subscription'], default: 'order' },

  // Pola powiązane z promocjami
  promotionPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'PromotionPlan', default: null },
  promotionPurchase: { type: mongoose.Schema.Types.ObjectId, ref: 'PromotionPurchase', default: null },

  // Pola powiązane z subskrypcjami
  subscriptionUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  subscriptionPlanKey: { type: String, default: null },

  // Uczestnicy płatności za zlecenia (mogą być puste dla subskrypcji)
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // wykonawca
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  providerName: String,
  clientName: String,

  stripePaymentIntentId: { type: String, index: true },
  stripeSubscriptionId: { type: String, index: true }, // Dla Stripe Subscriptions
  stripeCustomerId: { type: String, index: true }, // Customer ID w Stripe
  stripeChargeId: { type: String },
  stripeInvoiceId: { type: String }, // Invoice ID dla subskrypcji

  amount: { type: Number, required: true }, // grosze
  currency: { type: String, default: 'pln' },
  method: { type: String, enum: ['card', 'p24', 'blik', 'unknown'], default: 'unknown' },
  status: {
    type: String,
    enum: [
      'requires_payment_method',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'refunded',
      'partial_refund',
    ],
    default: 'requires_payment_method',
  },

  platformFeePercent: { type: Number, default: 0.07 },
  platformFeeAmount: { type: Number, default: 0 },
  pointsDiscount: { type: Number, default: 0 }, // Zniżka z punktów pokrywana przez platformę (koszt marketingowy)

  // Faktura od Helpfli
  requestInvoice: { type: Boolean, default: false }, // Użytkownik prosił o fakturę przy płatności
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null }, // Faktura wystawiona przez Helpfli (admin)

  metadata: { type: Object, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('Payment', PaymentSchema);






