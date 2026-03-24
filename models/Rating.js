const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String },
  
  // Rozszerzone pola (FAZA 3 - Social features)
  categories: {
    quality: { type: Number, min: 1, max: 5 }, // Jakość wykonania
    punctuality: { type: Number, min: 1, max: 5 }, // Punktualność
    communication: { type: Number, min: 1, max: 5 }, // Komunikacja
    price: { type: Number, min: 1, max: 5 }, // Stosunek jakości do ceny
    professionalism: { type: Number, min: 1, max: 5 } // Profesjonalizm
  },
  photos: [{ type: String }], // URL do zdjęć z pracy
  verified: { type: Boolean, default: false }, // Czy recenzja jest zweryfikowana (zakończone zlecenie)
  helpful: { type: Number, default: 0 }, // Liczba "pomocne" (helpful votes)
  helpfulUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Użytkownicy, którzy oznaczyli jako pomocne
  response: { // Odpowiedź wykonawcy na recenzję
    text: { type: String },
    createdAt: { type: Date }
  },
  status: { type: String, enum: ['active', 'hidden', 'reported'], default: 'active' },
  reported: { type: Boolean, default: false },
  reportedReason: { type: String }
}, {
  timestamps: true
});

// Indexy dla szybkiego wyszukiwania
ratingSchema.index({ to: 1, createdAt: -1 });
ratingSchema.index({ orderId: 1 });
ratingSchema.index({ verified: 1, status: 1 });

module.exports = mongoose.models.Rating || mongoose.model("Rating", ratingSchema);
