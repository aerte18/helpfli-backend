const mongoose = require('mongoose');

const PromotionPlanSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true }, // np. 'HIGHLIGHT_24H', 'TOP_7D'
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true }, // grosze (PLN*100)
  durationDays: { type: Number, required: true }, // 1, 7, 14, 31
  effects: {
    highlight: { type: Boolean, default: false }, // obwódka
    topBadge: { type: Boolean, default: false },  // TOP badge
    aiBadge: { type: Boolean, default: false },   // "Polecane przez AI"
  },
  rankingPointsAdd: { type: Number, default: 0 }, // ile dodać przy zakupie/odnowieniu
  isProSubscription: { type: Boolean, default: false }, // na przyszłość: PRO sub
}, { timestamps: true });

module.exports = mongoose.model('PromotionPlan', PromotionPlanSchema);






















