const mongoose = require('mongoose');

const BoostSchema = new mongoose.Schema({
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
	code: { type: String, index: true },
	title: { type: String },
	startsAt: { type: Date },
	endsAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Boost', BoostSchema);




























