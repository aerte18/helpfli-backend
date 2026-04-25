const mongoose = require("mongoose");

const OfferSchema = new mongoose.Schema({
  orderId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Order", 
    index: true, 
    required: true 
  },
  providerId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    index: true, 
    required: true 
  },
  
  // Oferta (MVP)
  price: { type: Number, required: true }, // Cena w PLN
  etaMinutes: { type: Number, required: true }, // Estimated Time of Arrival w minutach
  notes: { type: String, default: "" }, // Komentarz od providera
  
  // Informacje o cenie - przydatne dla klienta
  priceInfo: {
    includes: [{ type: String }], // Co zawiera cena: 'materials', 'labor', 'transport', 'other'
    includesOther: { type: String, default: "" }, // Inne - tekst
    isFinal: { type: Boolean, default: true } // Czy cena jest ostateczna
  },
  
  // Sposób kontaktu / realizacji
  contactMethod: { 
    type: String, 
    enum: ['call_before', 'chat_only', 'no_contact'], 
    default: null 
  },
  
  // Metoda płatności wybrana przez providera (tylko jeśli klient wybrał "both")
  paymentMethod: {
    type: String,
    enum: ['system', 'external'],
    default: null
  }, // 'system' = przez Helpfli, 'external' = poza systemem
  
  // Gwarancja (opcjonalna)
  hasGuarantee: { type: Boolean, default: false },
  guaranteeDetails: { type: String, default: "" },
  
  // Status (ujednolicony z planem MVP)
  status: {
    type: String,
    enum: ["sent", "accepted", "rejected", "expired"],
    default: "sent",
    index: true
  },
  
  // Timestamps
  sentAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, index: true }, // Oferta wygasa po X godzinach (domyślnie 24h)
  acceptedAt: { type: Date },
  rejectedAt: { type: Date },
  
  // Legacy fields (zachowane dla kompatybilności)
  amount: { type: Number }, // Alias dla price
  message: { type: String }, // Alias dla notes
  completionDate: { type: Date }, // Termin realizacji
  boostUntil: { type: Date, default: null },
  boostFee: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  
  // Pricing analytics (zachowane)
  pricing: {
    service: String,
    city: String,
    bands: { min: Number, p25: Number, med: Number, p75: Number, max: Number, k: Number },
    position: { type: String, enum: ["below_min", "low", "fair", "optimal", "high", "above_max"], default: "fair" },
    badge: { type: String, enum: ["", "optimal", "fair", "high", "low"], default: "" },
  },

  // AI quality preflight - wynik oceny formularza przed wysłaniem
  aiQuality: {
    percent: { type: Number, default: null },
    label: { type: String, default: "" },
    tone: { type: String, enum: ["emerald", "blue", "amber", "rose", ""], default: "" },
    missing: [{ type: String }],
    warnings: [{ type: String }],
    strengths: [{ type: String }],
    measuredAt: { type: Date, default: null }
  },
  
  // Teleporada - pola dla konsultacji online
  pricePerHour: { type: Number, default: null }, // Cena za godzinę (dla teleporad)
  pricePerConsultation: { type: Number, default: null }, // Cena za konsultację (dla teleporad)
  consultationDuration: { type: Number, default: 30 }, // Czas trwania konsultacji w minutach
  availableSlots: [{ type: Date }], // Dostępne terminy (opcjonalnie, jeśli provider podaje)
  supportsVideo: { type: Boolean, default: true }, // Czy obsługuje połączenie video przez stronę
  supportsPhone: { type: Boolean, default: true }, // Czy obsługuje połączenie telefoniczne
  supportsChat: { type: Boolean, default: false }, // Czy obsługuje konsultację przez chat
  supportsEmail: { type: Boolean, default: false } // Czy obsługuje konsultację przez email
});

// Indeksy dla wydajności
OfferSchema.index({ orderId: 1, status: 1 });
OfferSchema.index({ providerId: 1, status: 1 });
OfferSchema.index({ status: 1, createdAt: -1 });
OfferSchema.index({ expiresAt: 1 }); // Dla cleanup expired offers

// Walidacja: tylko jedna accepted offer per order
OfferSchema.pre('save', async function(next) {
  if (this.status === 'accepted' && this.isNew) {
    const Order = mongoose.model('Order');
    const order = await Order.findById(this.orderId);
    
    if (order && order.acceptedOfferId && order.acceptedOfferId.toString() !== this._id.toString()) {
      return next(new Error('Order already has an accepted offer'));
    }
  }
  next();
});

// Auto-set expiresAt jeśli nie ustawione (24h domyślnie)
OfferSchema.pre('save', function(next) {
  if (!this.expiresAt && this.status === 'sent') {
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  }
  next();
});

// Sync legacy fields
OfferSchema.pre('save', function(next) {
  if (this.price && !this.amount) {
    this.amount = this.price;
  }
  if (this.notes && !this.message) {
    this.message = this.notes;
  }
  next();
});

module.exports = mongoose.model("Offer", OfferSchema);






