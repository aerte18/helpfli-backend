const mongoose = require('mongoose');

const kycVerificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  steps: {
    profile: { type: Boolean, default: false },  // dane firmy/osobowe
    nip: { type: Boolean, default: false },      // NIP/REGON
    bank: { type: Boolean, default: false },     // rachunek do wypłat
    selfie: { type: Boolean, default: false },   // opcjonalne (bez skanów dowodu)
  },
  status: { type: String, enum: ['unverified','pending','verified','rejected'], default: 'unverified' },
  note: String,
}, { timestamps: true });

module.exports = mongoose.model('KYCVerification', kycVerificationSchema);























