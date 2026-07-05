const mongoose = require('mongoose');

/**
 * Atomowe liczniki platformy (np. sloty Founding Provider).
 */
const platformCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    used: { type: Number, default: 0, min: 0 },
  },
  { _id: false, timestamps: true }
);

module.exports =
  mongoose.models.PlatformCounter ||
  mongoose.model('PlatformCounter', platformCounterSchema);
