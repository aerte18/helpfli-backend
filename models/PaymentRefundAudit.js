const mongoose = require('mongoose');

const PaymentRefundAuditSchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  stripePaymentIntentId: { type: String, required: true },
  stripeChargeId: { type: String, required: true },
  stripeRefundId: { type: String, default: null },
  amount: { type: Number, required: true },
  refundableBefore: { type: Number, required: true },
  fullRefund: { type: Boolean, default: false },
  reverseTransfer: { type: Boolean, default: false },
  refundApplicationFee: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['pending', 'succeeded', 'failed'],
    default: 'pending',
    index: true,
  },
  error: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.PaymentRefundAudit ||
  mongoose.model('PaymentRefundAudit', PaymentRefundAuditSchema);
