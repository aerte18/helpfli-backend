const mongoose = require('mongoose');

const proSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tier: { type: String, enum: ['PRO_MONTHLY','PRO_YEARLY'], required: true },
  status: { type: String, enum: ['active','past_due','canceled','incomplete'], default: 'incomplete' },
  stripeCustomerId: String,
  stripeSubscriptionId: String,
  currentPeriodEnd: Date,
}, { timestamps: true });

module.exports = mongoose.model('ProSubscription', proSubscriptionSchema);
proSubscriptionSchema.index({ user: 1, status: 1 });










