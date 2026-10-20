const mongoose = require('mongoose');

const proSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tier: { type: String, enum: ['PRO_MONTHLY','PRO_YEARLY'], required: true },
  status: { type: String, enum: ['active','past_due','canceled','incomplete'], default: 'incomplete' },
  stripeCustomerId: String,
  stripeSubscriptionId: String,
  stripeCheckoutSessionId: String,
  currentPeriodEnd: Date,
}, { timestamps: true });

proSubscriptionSchema.index({ user: 1, status: 1 });
proSubscriptionSchema.index(
  { stripeCheckoutSessionId: 1 },
  { unique: true, partialFilterExpression: { stripeCheckoutSessionId: { $type: 'string' } } }
);

module.exports = mongoose.models.ProSubscription ||
  mongoose.model('ProSubscription', proSubscriptionSchema);

