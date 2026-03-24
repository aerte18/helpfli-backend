const mongoose = require('mongoose');

const ReferralCodeSchema = new mongoose.Schema({
  code: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true 
  },
  referrer: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  referrerRole: {
    type: String,
    enum: ['client', 'provider'],
    required: true
  },
  usedBy: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    usedAt: { type: Date, default: Date.now },
    rewardGranted: { type: Boolean, default: false }
  }],
  totalUses: { type: Number, default: 0 },
  maxUses: { type: Number, default: null }, // null = unlimited
  expiresAt: { type: Date, default: null }, // null = never expires
  active: { type: Boolean, default: true },
  rewards: {
    referrerReward: {
      type: String,
      enum: ['1_month_standard', '1_month_pro', '50_pln_credit'],
      default: '1_month_standard'
    },
    refereeReward: {
      type: String,
      enum: ['20_percent_discount', 'first_month_free'],
      default: '20_percent_discount'
    }
  }
}, { timestamps: true });

// Index dla szybkiego wyszukiwania
ReferralCodeSchema.index({ code: 1, active: 1 });
ReferralCodeSchema.index({ referrer: 1 });

// Generuj unikalny kod
ReferralCodeSchema.statics.generateCode = function(userId) {
  const prefix = 'HELPFLI';
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${random}`;
};

module.exports = mongoose.model('ReferralCode', ReferralCodeSchema);







