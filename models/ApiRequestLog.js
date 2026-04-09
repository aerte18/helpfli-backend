const mongoose = require('mongoose');

/** Próbki czasu odpowiedzi wybranych endpointów API (np. wyszukiwanie) — TTL skraca kolekcję. */
const apiRequestLogSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, index: true },
    method: { type: String, required: true },
    statusCode: { type: Number, required: true },
    durationMs: { type: Number, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

apiRequestLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 72 }); // 72 h

module.exports = mongoose.model('ApiRequestLog', apiRequestLogSchema);
