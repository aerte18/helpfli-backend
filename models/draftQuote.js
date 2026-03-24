const mongoose = require('mongoose');

const DraftQuoteSchema = new mongoose.Schema({
  draft: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderDraft', required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  status: { type: String, enum: ['pending','quoted','declined','expired','accepted'], default: 'pending' },
  quoteAmount: { type: Number, default: 0 }, // grosze
  message: { type: String, default: '' },

  expiresAt: { type: Date, default: () => new Date(Date.now() + 72*60*60*1000) }, // 72h
}, { timestamps: true });

DraftQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DraftQuote', DraftQuoteSchema);






















