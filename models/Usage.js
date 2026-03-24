const mongoose = require('mongoose');

const UsageSchema = new mongoose.Schema({
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
	monthKey: { type: String, index: true }, // YYYY-MM
	fastTrackUsed: { type: Number, default: 0 },
	responsesUsed: { type: Number, default: 0 }
}, { timestamps: true });

UsageSchema.index({ user: 1, monthKey: 1 }, { unique: true });

module.exports = mongoose.model('Usage', UsageSchema);




























