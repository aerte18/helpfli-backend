const mongoose = require('mongoose');

const processedStripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, default: '' },
    // Starsze rekordy nie mają pola `status`; są traktowane jak poprawnie
    // przetworzone. Domyślna wartość `processed` zachowuje tę kompatybilność,
    // natomiast nowy webhook zawsze jawnie tworzy rekord jako `processing`.
    status: {
      type: String,
      enum: ['processing', 'processed', 'failed'],
      default: 'processed',
      index: true,
    },
    lockToken: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

processedStripeEventSchema.index({ status: 1, lockedAt: 1 });

module.exports =
  mongoose.models.ProcessedStripeEvent ||
  mongoose.model('ProcessedStripeEvent', processedStripeEventSchema);
