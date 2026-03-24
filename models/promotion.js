const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan: { type: String, enum: ['PROMO_24H','TOP_7','TOP_14','TOP_31'], required: true },
  pointsGranted: { type: Number, default: 0 },
  activeFrom: Date,
  activeTo: Date,
  status: { type: String, enum: ['active','expired','pending_payment','cancelled'], default: 'pending_payment' },
  stripeCheckoutSessionId: String,
}, { timestamps: true });

promotionSchema.index({ user: 1, activeTo: -1 });

module.exports = mongoose.model('Promotion', promotionSchema);























