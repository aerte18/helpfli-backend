const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  sessionId: {
    type: String,
    index: true
  },
  properties: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Indeksy dla wydajności
eventSchema.index({ type: 1, createdAt: -1 });
eventSchema.index({ userId: 1, type: 1, createdAt: -1 });
eventSchema.index({ sessionId: 1, createdAt: -1 });

// TTL index - usuwaj eventy starsze niż 1 rok
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('Event', eventSchema);

