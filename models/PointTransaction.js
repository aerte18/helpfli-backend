const mongoose = require('mongoose');

const PointTransactionSchema = new mongoose.Schema({
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
	delta: { type: Number, required: true },
	reason: { type: String, default: '' },
	balanceAfter: { type: Number, required: true }
}, { timestamps: true });

module.exports = mongoose.model('PointTransaction', PointTransactionSchema);




























