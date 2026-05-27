const mongoose = require('mongoose');

const guestAiUsageSchema = new mongoose.Schema(
  {
    guestId: { type: String, required: true, unique: true, index: true },
    queryCount: { type: Number, default: 0 },
    lastSessionId: { type: String, default: null },
    ipHash: { type: String, default: null, index: true },
    mergedToUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuestAiUsage', guestAiUsageSchema);
