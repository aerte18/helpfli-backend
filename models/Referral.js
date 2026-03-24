const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  referrer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  referred: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true // Jeden użytkownik może być zaproszony tylko raz
  },
  referredRole: {
    type: String,
    enum: ['client', 'provider'],
    required: true
  },
  referralCode: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'rewarded'],
    default: 'pending'
  },
  // Warunki ukończenia (np. zarejestrował się, złożył pierwsze zlecenie)
  completedAt: {
    type: Date
  },
  // Nagrody
  referrerReward: {
    points: { type: Number, default: 0 },
    subscriptionMonths: { type: Number, default: 0 },
    givenAt: { type: Date }
  },
  referredReward: {
    points: { type: Number, default: 0 },
    subscriptionMonths: { type: Number, default: 0 },
    givenAt: { type: Date }
  },
  // Dla providerów - dodatkowe warunki
  providerBonus: {
    ordersCompleted: { type: Number, default: 0 }, // Ile zleceń musi zrealizować zaproszony provider
    bonusPoints: { type: Number, default: 0 }
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indeksy
referralSchema.index({ referrer: 1, status: 1 });
referralSchema.index({ referralCode: 1 });
referralSchema.index({ referred: 1 });

module.exports = mongoose.model('Referral', referralSchema);
