const mongoose = require("mongoose");

const CouponSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true }, // np. WELCOME20
  type: { type: String, enum: ["percent", "amount"], default: "percent" },
  value: { type: Number, required: true }, // 20 = 20% lub 200 = 2,00 zł (amount w groszach)
  active: { type: Boolean, default: true },
  validFrom: Date,
  validTo: Date,
  products: [String], // np. ["highlight_24h","top_7d"] lub puste = wszystkie
  maxUses: { type: Number, default: 0 }, // 0 = bez limitu
  used: { type: Number, default: 0 },
}, {
  timestamps: true
});

module.exports = mongoose.model("Coupon", CouponSchema);



























