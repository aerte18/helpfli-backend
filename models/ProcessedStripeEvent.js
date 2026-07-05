const mongoose = require('mongoose');

const processedStripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, default: '' },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

module.exports =
  mongoose.models.ProcessedStripeEvent ||
  mongoose.model('ProcessedStripeEvent', processedStripeEventSchema);
