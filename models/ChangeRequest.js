const mongoose = require("mongoose");

const ChangeRequestSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true,
    index: true
  },
  offerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Offer",
    required: true
  },
  providerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  
  // Szczegóły dopłaty
  amount: { type: Number, required: true }, // Kwota dopłaty w PLN
  reason: { type: String, required: true }, // Powód dopłaty (obowiązkowy)
  type: { 
    type: String, 
    enum: ['additional_work', 'materials', 'unexpected_issue', 'other'],
    default: 'additional_work'
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  respondedAt: { type: Date }, // Kiedy klient odpowiedział
  expiresAt: { type: Date }, // Dopłata wygasa po 48h jeśli nie odpowiedziano
  
  // Komunikacja
  clientMessage: { type: String, default: "" }, // Wiadomość od klienta przy odrzuceniu/akceptacji
});

// Auto-set expiresAt (48h)
ChangeRequestSchema.pre('save', function(next) {
  if (!this.expiresAt && this.status === 'pending') {
    this.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h
  }
  next();
});

// Indeksy
ChangeRequestSchema.index({ orderId: 1, status: 1 });
ChangeRequestSchema.index({ providerId: 1, status: 1 });
ChangeRequestSchema.index({ clientId: 1, status: 1 });
ChangeRequestSchema.index({ expiresAt: 1 });

module.exports = mongoose.model("ChangeRequest", ChangeRequestSchema);

