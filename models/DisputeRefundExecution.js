const mongoose = require('mongoose');

const disputeRefundPartSchema = new mongoose.Schema(
  {
    partKey: { type: String, required: true },
    role: { type: String, enum: ['main', 'additional'], required: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true },
    stripePaymentIntentId: { type: String, required: true },
    stripeChargeId: { type: String, default: null },
    operation: {
      type: String,
      enum: ['cancel', 'partial_capture', 'refund'],
      required: true,
    },
    amountGrosze: { type: Number, required: true, min: 1 },
    captureAmountGrosze: { type: Number, default: null },
    captureApplicationFeeGrosze: { type: Number, default: null },
    chargeAmountGrosze: { type: Number, default: null },
    chargeRefundedBeforeGrosze: { type: Number, default: null },
    idempotencyKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'succeeded', 'failed'],
      default: 'pending',
    },
    stripeRef: { type: String, default: null },
    paymentStatus: { type: String, default: null },
    error: { type: String, default: '' },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const disputeRefundExecutionSchema = new mongoose.Schema(
  {
    executionKey: { type: String, required: true },
    idempotencyScope: { type: String, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    amountGrosze: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ['planned', 'processing', 'succeeded', 'failed'],
      default: 'planned',
      index: true,
    },
    parts: { type: [disputeRefundPartSchema], default: [] },
    initialOrderPaymentStatus: { type: String, default: null },
    initialOrderPaymentSubStatus: { type: String, default: null },
    initialAdditionalPaymentStatus: { type: String, default: null },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: '' },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

disputeRefundExecutionSchema.index({ executionKey: 1 }, { unique: true });
disputeRefundExecutionSchema.index({ order: 1, createdAt: -1 });

module.exports =
  mongoose.models.DisputeRefundExecution ||
  mongoose.model('DisputeRefundExecution', disputeRefundExecutionSchema);
