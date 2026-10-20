const mongoose = require('mongoose');

const BoostSchema = new mongoose.Schema({
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
	code: { type: String, index: true },
	title: { type: String },
	startsAt: { type: Date },
	endsAt: { type: Date },
	stripePaymentIntentId: { type: String, default: null },
	stripeItemIndex: { type: Number, default: null },
}, { timestamps: true });

BoostSchema.index(
	{ stripePaymentIntentId: 1, stripeItemIndex: 1 },
	{ unique: true, partialFilterExpression: { stripePaymentIntentId: { $type: 'string' } } }
);

module.exports = mongoose.model('Boost', BoostSchema);




























