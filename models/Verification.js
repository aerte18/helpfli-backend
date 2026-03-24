const mongoose = require("mongoose");

const VerificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  
  status: {
    type: String,
    enum: ["unverified", "pending_review", "verified", "rejected", "suspended"],
    default: "unverified",
  },
  
  // Kontakt / weryfikacje
  phoneNumber: { type: String },
  phoneVerified: { type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },
  
  // Kody i ograniczenia prób
  emailCodeHash: { type: String },
  emailCodeExpiresAt: { type: Date },
  emailCodeAttempts: { type: Number, default: 0 },
  
  phoneCodeHash: { type: String },
  phoneCodeExpiresAt: { type: Date },
  phoneCodeAttempts: { type: Number, default: 0 },
  
  // Dane firmy
  businessName: { type: String },
  taxId: { type: String }, // NIP/REGON – opcjonalnie
  address: { type: String },
  website: { type: String },
  
  // Review
  verifiedAt: { type: Date },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  rejectionReason: { type: String },
}, { timestamps: true });

module.exports = mongoose.model("Verification", VerificationSchema);

























