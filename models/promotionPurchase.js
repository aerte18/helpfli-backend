const mongoose = require('mongoose');

const PromotionPurchaseSchema = new mongoose.Schema({
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'PromotionPlan', required: true },
  stripePaymentIntentId: { type: String, index: true },
  status: { type: String, enum: ['pending','active','expired','canceled','failed','refunded'], default: 'pending' },

  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },

  amount: { type: Number, required: true }, // grosze
  currency: { type: String, default: 'pln' },
}, { timestamps: true });

module.exports = mongoose.model('PromotionPurchase', PromotionPurchaseSchema);






















