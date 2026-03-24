const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  provider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Może być null dla firm zewnętrznych
  },
  // Dla firm zewnętrznych (niezalogowanych)
  externalCompany: {
    name: String,
    email: String,
    phone: String,
    website: String,
    address: String
  },
  isExternal: {
    type: Boolean,
    default: false
  },
  type: {
    type: String,
    enum: ['equipment_rental', 'parts_sale', 'service', 'other'],
    required: true
  },
  category: {
    type: String,
    required: true // np. "hydraulika", "elektryka", "IT", "remont"
  },
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  description: {
    type: String,
    required: true,
    maxlength: 2000
  },
  price: {
    type: Number,
    required: true // w groszach
  },
  priceType: {
    type: String,
    enum: ['per_hour', 'per_day', 'per_week', 'per_month', 'one_time'],
    default: 'one_time'
  },
  location: {
    type: String,
    required: true
  },
  locationLat: {
    type: Number
  },
  locationLon: {
    type: Number
  },
  images: [{
    type: String // URLs do zdjęć
  }],
  tags: [{
    type: String // np. ["betoniarka", "wielofunkcyjna", "z operatorem"]
  }],
  availability: {
    type: String,
    enum: ['available', 'rented', 'sold', 'unavailable'],
    default: 'available'
  },
  contactPhone: {
    type: String
  },
  contactEmail: {
    type: String
  },
  // Dla wynajmu sprzętu
  equipmentDetails: {
    brand: String,
    model: String,
    condition: {
      type: String,
      enum: ['new', 'like_new', 'good', 'fair', 'needs_repair']
    },
    includesOperator: {
      type: Boolean,
      default: false
    },
    deliveryAvailable: {
      type: Boolean,
      default: false
    },
    deliveryPrice: Number // w groszach
  },
  // Dla sprzedaży części
  partsDetails: {
    brand: String,
    model: String,
    condition: {
      type: String,
      enum: ['new', 'used', 'refurbished']
    },
    warranty: {
      type: String,
      enum: ['none', '1_month', '3_months', '6_months', '1_year', '2_years']
    },
    stock: {
      type: Number,
      default: 1
    }
  },
  // Status i widoczność
  status: {
    type: String,
    enum: ['pending', 'active', 'inactive', 'archived', 'rejected'],
    default: 'pending' // Wymaga akceptacji admina
  },
  // Moderacja admina
  moderation: {
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reviewedAt: Date,
    rejectionReason: String,
    notes: String // Notatki admina (np. "Klient VIP - wyższa pozycja")
  },
  featured: {
    type: Boolean,
    default: false
  },
  featuredUntil: {
    type: Date
  },
  // System płatności i promocji
  payment: {
    status: {
      type: String,
      enum: ['pending', 'paid', 'expired', 'refunded'],
      default: 'pending'
    },
    amount: Number, // w groszach
    paymentMethod: String, // 'card', 'transfer', 'invoice'
    paidAt: Date,
    expiresAt: Date,
    paymentIntentId: String // dla Stripe
  },
  promotion: {
    type: {
      type: String,
      enum: ['none', 'featured', 'top', 'premium'],
      default: 'none'
    },
    expiresAt: Date,
    boostUntil: Date // dla boostów czasowych
  },
  views: {
    type: Number,
    default: 0
  },
  inquiries: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indeksy dla szybkiego wyszukiwania
announcementSchema.index({ provider: 1, status: 1 });
announcementSchema.index({ type: 1, category: 1, status: 1 });
announcementSchema.index({ locationLat: 1, locationLon: 1 });
announcementSchema.index({ tags: 1 });
announcementSchema.index({ createdAt: -1 });
announcementSchema.index({ featured: 1, featuredUntil: 1 });

// Auto-update updatedAt
announcementSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Announcement', announcementSchema);

